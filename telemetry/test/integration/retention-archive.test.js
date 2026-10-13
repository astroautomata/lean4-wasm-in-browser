import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadArchiveConfig, runArchive, verifyArchive } from '../../src/jobs/archive.js'
import { loadCompactorConfig, runCompactor } from '../../src/jobs/compactor.js'
import { loadRetentionConfig, runRetention } from '../../src/jobs/retention.js'
import { historicIngestionBound } from '../../src/migrate.js'
import { createCompactor } from '../../src/trajectory/compactor.js'
import { archiveSource, readAttempt } from '../../src/trajectory/reader.js'
import { validateFeedback } from '../../src/validation.js'
import { verifyChunks } from '../../tools/verify-chunks.js'
import { attemptEvents, statuses, writerFixture } from '../helpers/collector.js'
import { skipWithoutDatabase } from '../helpers/database.js'

const skip = skipWithoutDatabase

async function withCompacted(run) {
  const fixture = await writerFixture()
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tlm-archive-'))
  try {
    const historicBound = await historicIngestionBound(fixture.db.pools.admin)
    const compactor = createCompactor({
      pool: fixture.db.pools.compactor, historicBound,
      settings: { mode: 'replace', minAgeSeconds: 0, inactiveSeconds: 0, replaceDelaySeconds: 0, recoverAfterSeconds: 0 },
    })
    await run({ ...fixture, compactor, directory })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
    await fixture.close()
  }
}

/** Make every attempt look idle for `days` days (trusted times are server-set). */
async function age(pool, days) {
  await pool.query(`UPDATE proof_attempts SET last_received_at = now() - $1 * interval '1 day', received_at = now() - $1 * interval '1 day'`, [days])
  await pool.query(`UPDATE feedback_reports SET received_at = now() - $1 * interval '1 day'`, [days])
  await pool.query(`UPDATE anonymous_users SET first_seen = now() - $1 * interval '1 day', last_seen = now() - $1 * interval '1 day'`, [days])
}

const env = (db, extra = {}) => ({ RETENTION_DATABASE_URL: db.url('telemetry_retention'), RETENTION_SLEEP_MS: '0', ...extra })

test('retention refuses unsafe or unrecorded policies', () => {
  const base = { RETENTION_DATABASE_URL: 'postgresql://x@localhost/x' }
  assert.throws(() => loadRetentionConfig({ ...base }, ['--execute']), /RETENTION_POLICY_ID/u)
  assert.throws(() => loadRetentionConfig({ ...base, RETENTION_DETAIL_DAYS: '7' }), /RETENTION_ARCHIVE_DIR|LAST_COPY/u)
  assert.throws(() => loadRetentionConfig({ ...base, RETENTION_RECEIPT_DAYS: '2' }), /at least 7/u)
  assert.throws(() => loadRetentionConfig({ ...base, RETENTION_DETAIL_DAYS: '30', RETENTION_ATTEMPT_DAYS: '7',
    RETENTION_EXPIRE_LAST_COPY: 'true' }), /at least RETENTION_DETAIL_DAYS/u)
  assert.throws(() => loadRetentionConfig(base, ['--everything']), /unknown argument/u)
  assert.equal(loadRetentionConfig(base).execute, false, 'dry run by default')
})

test('a dry run reports without deleting; nothing expires without windows', { skip }, async () => {
  await withCompacted(async ({ writer, db }) => {
    await writer.writeEvents(attemptEvents({ steps: 3, complete: true }))
    await age(db.pools.admin, 400)
    const none = await runRetention(db.pools.retention, loadRetentionConfig(env(db, { RETENTION_POLICY_ID: 'p1' }), ['--execute']))
    assert.deepEqual(Object.keys(none).sort(), ['execute', 'policyId'])
    const dry = await runRetention(db.pools.retention, loadRetentionConfig(env(db, {
      RETENTION_DETAIL_DAYS: '30', RETENTION_EXPIRE_LAST_COPY: 'true',
    })))
    assert.equal(dry.detail.eligible, 1)
    assert.equal(dry.detail.deleted, 0)
    const steps = await db.pools.admin.query('SELECT count(*)::int AS n FROM proof_steps')
    assert.equal(steps.rows[0].n, 3)
  })
})

test('detail expiry keeps the summary, honours the archive guard and refuses late retries', { skip }, async () => {
  await withCompacted(async ({ writer, db, compactor, directory }) => {
    const archived = attemptEvents({ steps: 3, complete: true })
    const liveOnly = attemptEvents({ steps: 2 })
    await writer.writeEvents([...archived, ...liveOnly])
    // Compact and replace only the first attempt.
    await compactor.compactAttempt({ attempt_id: archived[0].attemptId, completed: true, inactive: true })
    await compactor.replacePass()
    const before = await readAttempt(db.pools.reader, archived[0].attemptId)

    const archiveConfig = loadArchiveConfig({ READER_DATABASE_URL: db.url('telemetry_reader') }, ['--dir', directory])
    const written = await runArchive(db.pools.reader, archiveConfig)
    assert.deepEqual(written, { attempts: 1, chunks: 1, bytes: written.bytes })
    const verification = await verifyArchive(directory)
    assert.deepEqual(verification.failures, [])
    assert.equal(verification.attempts, 1)

    await age(db.pools.admin, 60)
    const report = await runRetention(db.pools.retention, loadRetentionConfig(env(db, {
      RETENTION_POLICY_ID: 'test-policy', RETENTION_DETAIL_DAYS: '30', RETENTION_ARCHIVE_DIR: directory,
    }), ['--execute']))
    assert.equal(report.detail.deleted, 1, 'only the verified archived attempt')
    assert.equal(report.detail.skipped, 1, 'the live-only attempt has no second copy')

    const after = await readAttempt(db.pools.reader, archived[0].attemptId)
    assert.equal(after.actions.length, 0)
    assert.equal(after.completeness.detailExpired, true)
    assert.equal(after.attempt.playScript, before.attempt.playScript, 'the summary stays')
    // The archive still reconstructs the expired detail exactly.
    const restored = await readAttempt(db.pools.reader, archived[0].attemptId, { archive: archiveSource(directory) })
    assert.deepEqual(restored.actions, before.actions)
    // A late retry of an expired step is refused, not resurrected.
    assert.deepEqual(statuses(await writer.writeEvents([archived[1]])), ['rejected:late_event'])
    assert.equal((await verifyChunks(db.pools.reader)).ok, true)
  })
})

test('a tampered archive is not trusted by verification or retention', { skip }, async () => {
  await withCompacted(async ({ writer, db, compactor, directory }) => {
    const events = attemptEvents({ steps: 3 })
    await writer.writeEvents(events)
    await compactor.compactAttempt({ attempt_id: events[0].attemptId, completed: true, inactive: true })
    await compactor.replacePass()
    await runArchive(db.pools.reader, loadArchiveConfig({ READER_DATABASE_URL: db.url('telemetry_reader') }, ['--dir', directory]))
    const attemptDirectory = archiveSource(directory).attemptDirectory(events[0].attemptId)
    const payload = (await fs.readdir(attemptDirectory)).find(name => name.endsWith('.ltj.gz'))
    await fs.writeFile(path.join(attemptDirectory, payload), Buffer.from('not gzip'))
    const verification = await verifyArchive(directory)
    assert.equal(verification.attempts, 0)
    assert.equal(verification.failures.length, 1)
    await age(db.pools.admin, 60)
    const report = await runRetention(db.pools.retention, loadRetentionConfig(env(db, {
      RETENTION_POLICY_ID: 'p', RETENTION_DETAIL_DAYS: '30', RETENTION_ARCHIVE_DIR: directory,
    }), ['--execute']))
    assert.equal(report.detail.deleted, 0)
  })
})

test('attempt, feedback, receipt and user retention follow their own windows', { skip }, async () => {
  await withCompacted(async ({ writer, db, compactor, database }) => {
    const events = attemptEvents({ steps: 2, complete: true })
    await writer.writeEvents(events)
    await compactor.compactAttempt({ attempt_id: events[0].attemptId, completed: true, inactive: true })
    await compactor.replacePass()
    const feedback = validateFeedback({ report_id: '6f9619ff-8b86-4d01-b42d-00cf4fc964ff', game_id: 'g/local/NNG4',
      world_id: 'Tutorial', level_id: 1, mode: 'visual', message: 'hello', proof_state: {}, ts: '2026-08-04T12:00:00.000Z' })
    assert.equal(await database.storeFeedback(feedback.feedback), 'accepted')
    await db.pools.admin.query(`UPDATE trajectory_chunks SET sources_removed_at = now() - interval '30 days'`)
    await age(db.pools.admin, 400)

    const report = await runRetention(db.pools.retention, loadRetentionConfig(env(db, {
      RETENTION_POLICY_ID: 'p', RETENTION_RECEIPT_DAYS: '14', RETENTION_FEEDBACK_DAYS: '365',
      RETENTION_ATTEMPT_DAYS: '365', RETENTION_EXPIRE_LAST_COPY: 'true',
    }), ['--execute']))
    assert.equal(report.receipts.deleted, 1)
    assert.equal(report.feedback.deleted, 1)
    assert.equal(report.attempts.deleted, 1)
    assert.equal(report.users.deleted, 1)
    for (const table of ['proof_attempts', 'proof_steps', 'trajectory_chunks', 'feedback_reports', 'anonymous_users']) {
      const count = await db.pools.admin.query(`SELECT count(*)::int AS n FROM ${table}`)
      assert.equal(count.rows[0].n, 0, table)
    }
  })
})

test('verify-chunks detects receipt, overlap and compacted_through inconsistencies', { skip }, async () => {
  await withCompacted(async ({ writer, db, compactor }) => {
    const events = attemptEvents({ steps: 3 })
    await writer.writeEvents(events)
    await compactor.compactAttempt({ attempt_id: events[0].attemptId, completed: true, inactive: true })
    assert.equal((await verifyChunks(db.pools.reader)).ok, true)
    await db.pools.admin.query('UPDATE trajectory_chunks SET receipt_event_ids = receipt_event_ids[1:2]')
    await db.pools.admin.query('UPDATE proof_attempts SET compacted_through = 99 WHERE attempt_id = $1', [events[0].attemptId])
    const report = await verifyChunks(db.pools.reader)
    assert.equal(report.ok, false)
    assert.deepEqual(report.failures.map(failure => failure.code).sort(), ['compacted_through', 'receipt_mismatch'])
  })
})

test('the worker process runs a cycle as telemetry_compactor and stops on abort', { skip }, async () => {
  await withCompacted(async ({ writer, db }) => {
    const events = attemptEvents({ steps: 3, complete: true })
    await writer.writeEvents(events)
    const config = loadCompactorConfig({
      COMPACTOR_DATABASE_URL: db.url('telemetry_compactor'), METRICS_PORT: '0', COMPACTION_ONCE: 'true',
      COMPACTION_MIN_AGE_SECONDS: '0', COMPACTION_INACTIVE_SECONDS: '0', COMPACTION_OBSERVE_INTERVAL_MS: '1000',
    })
    assert.equal(config.settings.mode, 'shadow')
    await runCompactor(config, { signal: new AbortController().signal })
    const chunks = await db.pools.admin.query(`SELECT state FROM trajectory_chunks`)
    assert.deepEqual(chunks.rows, [{ state: 'published' }])
    const controller = new AbortController()
    const running = runCompactor({ ...config, once: false, idleSleepMs: 60000 }, { signal: controller.signal })
    setTimeout(() => controller.abort(), 200)
    await running
  })
})

test('compactor configuration validates modes and limits', () => {
  const base = { COMPACTOR_DATABASE_URL: 'postgresql://x@localhost/x' }
  assert.throws(() => loadCompactorConfig({ ...base, COMPACTION_MODE: 'delete' }), /COMPACTION_MODE/u)
  assert.throws(() => loadCompactorConfig({ ...base, COMPACTION_CHUNK_MAX_EVENTS: '100000' }), /COMPACTION_CHUNK_MAX_EVENTS/u)
  assert.equal(loadCompactorConfig({ ...base, COMPACTION_REPLACE_LIMIT: 'unlimited' }).settings.replaceLimit, Infinity)
  assert.equal(loadCompactorConfig({ ...base, COMPACTION_INACTIVE_SECONDS: '' }).settings.inactiveSeconds, 3600)
})
