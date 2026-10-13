import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { boolean, ConfigError, connection, integer, string } from '../env.js'
import { historicIngestionBound } from '../migrate.js'
import { archiveSource } from '../trajectory/reader.js'

/** Policy-gated retention (docs/compaction.md "Retention").
 *
 * Every window is unset by default: nothing expires. A dry run (the default)
 * reports what the configured windows would remove. Deleting requires
 * --execute AND RETENTION_POLICY_ID naming the recorded decision
 * (docs/operations.md), and runs in small, bounded, measured batches.
 *
 * Windows are independent and use trusted times only: an attempt's activity is
 * last_received_at, else received_at, else migration 005's applied_at (the
 * upper bound for rows ingested before ingestion times were recorded). Client
 * timestamps are never used.
 *
 *   RETENTION_DETAIL_DAYS    step detail (live rows and chunks) of attempts idle
 *                            this long; the attempt summary stays, marked
 *                            detail_expired_at so late retries are refused
 *   RETENTION_ATTEMPT_DAYS   attempt rows (summaries, scripts) idle this long,
 *                            with any remaining detail; >= RETENTION_DETAIL_DAYS
 *   RETENTION_FEEDBACK_DAYS  feedback reports by received_at
 *   RETENTION_RECEIPT_DAYS   duplicate-detection receipts of chunks whose
 *                            sources were removed this long ago; must exceed
 *                            the clients' maximum retry age (7 days minimum)
 *
 * Expiring detail or attempts deletes the last copy unless a verified archive
 * (src/jobs/archive.js --verify) holds it. Set RETENTION_ARCHIVE_DIR to require
 * and check that per attempt; otherwise RETENTION_EXPIRE_LAST_COPY=true must
 * record that the policy accepts losing the only copy. */

const MIN_RECEIPT_DAYS = 7

export function loadRetentionConfig(env = process.env, argv = []) {
  const flags = new Set(argv)
  for (const flag of flags) {
    if (!['--execute', '--dry-run'].includes(flag)) throw new ConfigError(`unknown argument ${flag}`)
  }
  const days = name => integer(env, name, null, { min: 1, max: 36500 })
  const config = {
    connection: connection(env, 'RETENTION_'),
    execute: flags.has('--execute') && !flags.has('--dry-run'),
    policyId: string(env, 'RETENTION_POLICY_ID'),
    detailDays: days('RETENTION_DETAIL_DAYS'),
    attemptDays: days('RETENTION_ATTEMPT_DAYS'),
    feedbackDays: days('RETENTION_FEEDBACK_DAYS'),
    receiptDays: days('RETENTION_RECEIPT_DAYS'),
    archiveDir: string(env, 'RETENTION_ARCHIVE_DIR'),
    expireLastCopy: boolean(env, 'RETENTION_EXPIRE_LAST_COPY', false),
    batchSize: integer(env, 'RETENTION_BATCH_SIZE', 200, { min: 1, max: 5000 }),
    maxBatches: integer(env, 'RETENTION_MAX_BATCHES', 1000, { min: 1 }),
    sleepMs: integer(env, 'RETENTION_SLEEP_MS', 500, { min: 0 }),
  }
  if (config.execute && !config.policyId) {
    throw new ConfigError('--execute requires RETENTION_POLICY_ID naming the recorded retention decision')
  }
  if (config.attemptDays !== null && config.detailDays !== null && config.attemptDays < config.detailDays) {
    throw new ConfigError('RETENTION_ATTEMPT_DAYS must be at least RETENTION_DETAIL_DAYS')
  }
  if (config.receiptDays !== null && config.receiptDays < MIN_RECEIPT_DAYS) {
    throw new ConfigError(`RETENTION_RECEIPT_DAYS must be at least ${MIN_RECEIPT_DAYS} (the clients' maximum retry age)`)
  }
  if ((config.detailDays !== null || config.attemptDays !== null) && !config.archiveDir && !config.expireLastCopy) {
    throw new ConfigError('expiring detail or attempts needs RETENTION_ARCHIVE_DIR (a verified archive) ' +
      'or RETENTION_EXPIRE_LAST_COPY=true recorded in the policy')
  }
  return config
}

const ACTIVITY = `COALESCE(a.last_received_at, a.received_at, $1::timestamptz)`

/** Whether a verified archive holds every published chunk of an attempt and
 * its context, checked against the database copy (ids and checksums) and by
 * re-hashing the archived payload files. Live rows are never archived, so an
 * attempt with live rows is not covered. */
export async function archivedCompletely(client, archive, attemptId) {
  const directory = archive.attemptDirectory(attemptId)
  let verified
  try {
    verified = JSON.parse(await fs.readFile(path.join(directory, 'verified.json'), 'utf8'))
  } catch {
    return false
  }
  const live = await client.query('SELECT 1 FROM proof_steps WHERE attempt_id = $1 LIMIT 1', [attemptId])
  if (live.rows.length > 0) return false
  const chunks = (await client.query(
    `SELECT chunk_id::text, checksum FROM trajectory_chunks WHERE attempt_id = $1 AND state = 'published'`, [attemptId])).rows
  const archived = new Map((await archive.chunksFor(attemptId)).map(row => [row.chunk_id, row]))
  for (const chunk of chunks) {
    const copy = archived.get(chunk.chunk_id)
    if (!copy || !copy.checksum.equals(chunk.checksum)) return false
    const recorded = verified.chunks?.[chunk.chunk_id]
    if (!recorded) return false
    const payload = await copy.loadPayload()
    if (crypto.createHash('sha256').update(payload).digest('hex') !== recorded.compressed_sha256) return false
  }
  try {
    await fs.access(path.join(directory, 'attempt.json'))
  } catch {
    return false
  }
  return true
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Run retention. Returns per-category counts ({ eligible, deleted, skipped }). */
export async function runRetention(pool, config, { log = () => {} } = {}) {
  const bound = await historicIngestionBound(pool)
  if (!bound) throw new Error('migration 005 is not applied')
  const archive = config.archiveDir ? archiveSource(config.archiveDir) : null
  const report = { policyId: config.policyId, execute: config.execute }

  async function batches(category, select, act) {
    const totals = { eligible: 0, deleted: 0, skipped: 0 }
    const skippedIds = new Set()
    for (let batch = 0; batch < config.maxBatches; batch++) {
      const client = await pool.connect()
      let done = false
      try {
        await client.query('BEGIN')
        const ids = (await client.query(select, [bound, [...skippedIds], config.batchSize])).rows.map(row => row.id)
        if (ids.length === 0) {
          await client.query('ROLLBACK')
          done = true
        } else {
          const result = await act(client, ids)
          await client.query('COMMIT')
          totals.eligible += ids.length
          totals.deleted += result.deleted
          totals.skipped += result.skipped.length
          for (const id of result.skipped) skippedIds.add(id)
          log('info', 'retention batch', { category, deleted: result.deleted, skipped: result.skipped.length })
          if (result.deleted === 0 && result.skipped.length === 0) done = true
        }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      } finally {
        client.release()
      }
      if (done) break
      if (config.sleepMs > 0) await sleep(config.sleepMs)
    }
    return totals
  }

  async function count(sql) {
    return Number((await pool.query(sql, [bound])).rows[0].n)
  }

  async function lastCopyGuard(client, ids) {
    if (config.expireLastCopy) return { allowed: ids, skipped: [] }
    const allowed = []
    const skipped = []
    for (const id of ids) ((await archivedCompletely(client, archive, id)) ? allowed : skipped).push(id)
    return { allowed, skipped }
  }

  // Receipts first: later windows may delete the chunks that hold them.
  if (config.receiptDays !== null) {
    const where = `c.sources_removed_at < now() - ${config.receiptDays} * interval '1 day' AND c.receipt_event_ids IS NOT NULL`
    const select = `SELECT c.chunk_id::text AS id FROM trajectory_chunks c
      WHERE ${where} AND $1::timestamptz IS NOT NULL AND c.chunk_id::text <> ALL($2::text[])
      ORDER BY c.chunk_id LIMIT $3 FOR UPDATE SKIP LOCKED`
    report.receipts = config.execute
      ? await batches('receipts', select, async (client, ids) => {
        const result = await client.query('UPDATE trajectory_chunks SET receipt_event_ids = NULL WHERE chunk_id = ANY($1::bigint[])', [ids])
        return { deleted: result.rowCount, skipped: [] }
      })
      : { eligible: await count(`SELECT count(*) AS n FROM trajectory_chunks c WHERE ${where} AND $1::timestamptz IS NOT NULL`),
        deleted: 0, skipped: 0 }
  }
  if (config.detailDays !== null) {
    const where = `${ACTIVITY} < now() - ${config.detailDays} * interval '1 day' AND a.detail_expired_at IS NULL`
    const select = `SELECT a.attempt_id::text AS id FROM proof_attempts a
      WHERE ${where} AND a.attempt_id <> ALL($2::uuid[]) ORDER BY a.attempt_id LIMIT $3 FOR UPDATE SKIP LOCKED`
    report.detail = config.execute
      ? await batches('detail', select, async (client, ids) => {
        const { allowed, skipped } = await lastCopyGuard(client, ids)
        if (allowed.length > 0) {
          await client.query('DELETE FROM proof_steps WHERE attempt_id = ANY($1::uuid[])', [allowed])
          await client.query('DELETE FROM trajectory_chunks WHERE attempt_id = ANY($1::uuid[])', [allowed])
          await client.query('UPDATE proof_attempts SET detail_expired_at = now() WHERE attempt_id = ANY($1::uuid[])', [allowed])
        }
        return { deleted: allowed.length, skipped }
      })
      : { eligible: await count(`SELECT count(*) AS n FROM proof_attempts a WHERE ${where}`), deleted: 0, skipped: 0 }
  }

  if (config.attemptDays !== null) {
    const where = `${ACTIVITY} < now() - ${config.attemptDays} * interval '1 day'`
    const select = `SELECT a.attempt_id::text AS id FROM proof_attempts a
      WHERE ${where} AND a.attempt_id <> ALL($2::uuid[]) ORDER BY a.attempt_id LIMIT $3 FOR UPDATE SKIP LOCKED`
    report.attempts = config.execute
      ? await batches('attempts', select, async (client, ids) => {
        // Attempts whose detail already expired under this policy hold no step
        // detail; their summary is covered by the archive or the policy.
        const { allowed, skipped } = await lastCopyGuard(client, ids)
        if (allowed.length > 0) {
          // Steps and chunks cascade.
          await client.query('DELETE FROM proof_attempts WHERE attempt_id = ANY($1::uuid[])', [allowed])
        }
        return { deleted: allowed.length, skipped }
      })
      : { eligible: await count(`SELECT count(*) AS n FROM proof_attempts a WHERE ${where}`), deleted: 0, skipped: 0 }
    if (config.execute) {
      // Pseudonymous users left without attempts or feedback. They exist only
      // after their attempts expired by trusted time above; the (client)
      // last_seen condition is just a margin against racing a user who is
      // active right now, never the retention clock. No row lock is needed:
      // the delete re-checks both conditions, and an attempt inserted
      // concurrently makes it fail on the foreign key instead of orphaning it.
      const orphan = `NOT EXISTS (SELECT 1 FROM proof_attempts a WHERE a.user_id = u.user_id)
          AND NOT EXISTS (SELECT 1 FROM feedback_reports f WHERE f.user_id = u.user_id)
          AND u.last_seen < now() - ${config.attemptDays} * interval '1 day'`
      report.users = await batches('users', `SELECT u.user_id::text AS id FROM anonymous_users u
        WHERE ${orphan} AND $1::timestamptz IS NOT NULL AND u.user_id <> ALL($2::uuid[]) ORDER BY u.user_id LIMIT $3`,
      async (client, ids) => {
        const result = await client.query(`DELETE FROM anonymous_users u WHERE u.user_id = ANY($1::uuid[]) AND ${orphan}`, [ids])
        return { deleted: result.rowCount, skipped: [] }
      })
    }
  }

  if (config.feedbackDays !== null) {
    const where = `f.received_at < now() - ${config.feedbackDays} * interval '1 day'`
    const select = `SELECT f.report_id::text AS id FROM feedback_reports f
      WHERE ${where} AND $1::timestamptz IS NOT NULL AND f.report_id <> ALL($2::uuid[])
      ORDER BY f.report_id LIMIT $3`
    report.feedback = config.execute
      ? await batches('feedback', select, async (client, ids) => {
        const result = await client.query('DELETE FROM feedback_reports WHERE report_id = ANY($1::uuid[])', [ids])
        return { deleted: result.rowCount, skipped: [] }
      })
      : { eligible: await count(`SELECT count(*) AS n FROM feedback_reports f WHERE ${where} AND $1::timestamptz IS NOT NULL`),
        deleted: 0, skipped: 0 }
  }

  return report
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let config
  try {
    config = loadRetentionConfig(process.env, process.argv.slice(2))
  } catch (error) {
    console.error(`retention: ${error.message}`)
    process.exit(2)
  }
  const pool = new pg.Pool({ ...config.connection, max: 1, application_name: 'telemetry-retention' })
  runRetention(pool, config, { log: (level, message, fields) => console.log(JSON.stringify({ level, message, ...fields })) })
    .then(report => {
      console.log(JSON.stringify({ level: 'info', message: config.execute ? 'retention executed' : 'retention dry run', report }))
    }, error => {
      console.error(`retention failed: ${error.message}`)
      process.exitCode = 1
    })
    .finally(() => pool.end())
}
