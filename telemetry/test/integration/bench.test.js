import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runLoad } from '../../bench/loadgen.js'
import { verifyRun } from '../../bench/verify.js'
import { historicIngestionBound } from '../../src/migrate.js'
import { createCompactor } from '../../src/trajectory/compactor.js'
import { storageReport } from '../../tools/storage-report.js'
import { writerFixture } from '../helpers/collector.js'
import { skipWithoutDatabase } from '../helpers/database.js'
import { ORIGIN, startApp } from '../helpers/http.js'

/** The benchmark tools end to end against the real collector and PostgreSQL,
 * at a harmless rate: acknowledged events are verified as stored exactly
 * once, before and after compaction replaced their live rows. */

const skip = skipWithoutDatabase
const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bench')
const profile = JSON.parse(fs.readFileSync(path.join(BENCH, 'profiles', 'sample-2026-10.json'), 'utf8'))

test('loadgen -> collector -> PostgreSQL -> verify, before and after compaction', { skip }, async () => {
  const fixture = await writerFixture()
  const app = await startApp({ config: fixture.config, writer: fixture.writer, metrics: fixture.metrics })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tlm-bench-'))
  try {
    const report = await runLoad({
      target: `http://127.0.0.1:${app.port}`, origin: ORIGIN, profile, out: directory, seed: 11,
      scenario: {
        name: 'integration', protocol: 'mixed', batch: 'client', players: 30, feedback_per_1000_events: 20,
        faults: { duplicate_resend: 0.1, id_conflict: 0.05, oversize: 0.03 },
        phases: [{ name: 'run', duration_s: 3, events_per_second: 20 }],
      },
    })
    const phase = report.phases[0]
    assert.ok(phase.eventsAcked > 20, JSON.stringify(phase))
    assert.equal(report.faults['id_conflict:wrongly_accepted'], undefined, 'conflicting reuse is never accepted')
    assert.ok(!Object.keys(phase.statuses).some(status => status.startsWith('5')), JSON.stringify(phase.statuses))

    let verified = await verifyRun(fixture.db.pools.reader, directory)
    assert.equal(verified.ok, true, JSON.stringify(verified))
    assert.equal(verified.missing, 0)
    assert.equal(verified.mismatched, 0)

    const compactor = createCompactor({
      pool: fixture.db.pools.compactor, historicBound: await historicIngestionBound(fixture.db.pools.admin),
      settings: { mode: 'replace', minAgeSeconds: 0, inactiveSeconds: 0, replaceDelaySeconds: 0, attemptsPerCycle: 1000 },
    })
    await compactor.runOnce()
    await compactor.runOnce()
    const live = await fixture.db.pools.admin.query('SELECT count(*)::int AS n FROM proof_steps')
    const chunks = await fixture.db.pools.admin.query('SELECT count(*)::int AS n FROM trajectory_chunks WHERE sources_removed_at IS NOT NULL')
    assert.equal(live.rows[0].n, 0)
    assert.ok(chunks.rows[0].n > 0)
    verified = await verifyRun(fixture.db.pools.reader, directory)
    assert.equal(verified.ok, true, JSON.stringify(verified))

    const storage = await storageReport(fixture.db.pools.reader, { walSampleSeconds: 0, diskPath: directory, exact: true })
    assert.equal(storage.relations.proof_steps.rows, 0)
    assert.ok(storage.chunks.actions > 0)
    assert.ok(storage.perRecord.compactedActionBytes > 0)
    assert.ok(storage.lastDay.steps > 0)
    assert.equal(typeof storage.wal.bytes, 'number')
    assert.ok(storage.disk.totalBytes > 0)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
    await app.close()
    await fixture.close()
  }
})
