import crypto from 'node:crypto'
import { createCollectorMetrics } from '../../src/collector-metrics.js'
import { createDatabase } from '../../src/database.js'
import { encodeChunk, microsFromSql, sqlMicros } from '../../src/trajectory/codec.js'
import { validateEvent } from '../../src/validation.js'
import { createWriter } from '../../src/writer.js'
import { createTestDatabase } from './database.js'
import { testConfig, wireEvent } from './http.js'

/** Collector integration-test support: a fresh database with the runtime
 * writer, event factories, and a stand-in for compaction that publishes chunks
 * directly (so writer tests do not depend on the compactor). */

export async function writerFixture({ env = {}, migrate = true } = {}) {
  const db = await createTestDatabase({ migrate })
  const config = testConfig({ DATABASE_URL: db.url('telemetry_writer'), ...env }, { requireDatabase: true })
  const metrics = createCollectorMetrics()
  let statements = 0
  let database = null
  let writer = null
  function open() {
    database = createDatabase(config, { metrics, log: () => {} })
    // Counting wrapper: every statement any pool client sends.
    database.pool.on('connect', client => {
      const query = client.query.bind(client)
      client.query = (...args) => {
        statements++
        return query(...args)
      }
    })
    writer = createWriter({ database, config, metrics })
  }
  if (migrate === true) open()
  return {
    db,
    config,
    metrics,
    get database() { return database },
    get writer() { return writer },
    get statements() { return statements },
    resetStatements() { statements = 0 },
    /** For 'legacy' databases: run the migration runner, then open the writer. */
    async migrate() {
      await db.migrate()
      open()
    },
    async close() {
      await database?.close().catch(() => {})
      await db.drop()
    },
  }
}

/** A validated event; throws if the wire event is invalid. */
export function event(overrides = {}) {
  const result = validateEvent(wireEvent(overrides))
  if (!result.ok) throw new Error(`invalid test event: ${result.reason}`)
  return result.event
}

/** Events of one attempt: start (sequence 0), `steps` steps, optional completion. */
export function attemptEvents({ steps = 3, complete = false, ...context } = {}) {
  const shared = { user_uuid: crypto.randomUUID(), attempt_uuid: crypto.randomUUID(), ...context }
  const events = [event({ ...shared, event_type: 'level_start', sequence: 0, elapsed_ms: 0, initial_script: '' })]
  for (let sequence = 1; sequence <= steps; sequence++) {
    events.push(event({ ...shared, sequence, elapsed_ms: sequence * 1000, command: `step ${sequence} ∀ 🎉`,
      ts: `2026-08-04T12:00:${String(sequence % 60).padStart(2, '0')}.${String(sequence).padStart(6, '0')}Z` }))
  }
  if (complete) {
    events.push(event({ ...shared, event_type: 'level_complete', sequence: steps + 1, elapsed_ms: (steps + 1) * 1000,
      play_script: 'intro n\nrfl', lean_script: 'theorem t : True := by\n  trivial' }))
  }
  return events
}

export const statuses = outcomes => outcomes.map(outcome => (outcome.reason ? `${outcome.status}:${outcome.reason}` : outcome.status))

/** Stand-in for the compactor: publish one chunk holding the attempt's live
 * steps (optionally only those `include` keeps), record compacted_through and
 * delete exactly those rows. Runs as the admin pool. */
export async function compact(pool, attemptId, { include = () => true, receipts = true } = {}) {
  const rows = (await pool.query(`
    SELECT event_id::text, sequence, ${sqlMicros('client_ts')} AS ts_us, elapsed_ms, step_type::text, command,
           from_line, removed_lines, attributes, ${sqlMicros('received_at')} AS received_us
    FROM proof_steps WHERE attempt_id = $1 ORDER BY sequence`, [attemptId])).rows
  const actions = rows.map(row => ({
    eventId: row.event_id,
    sequence: row.sequence,
    clientTsUs: microsFromSql(row.ts_us),
    elapsedMs: row.elapsed_ms,
    stepType: row.step_type,
    command: row.command,
    fromLine: row.from_line,
    removedLines: row.removed_lines,
    attributes: row.attributes,
    receivedAtUs: microsFromSql(row.received_us),
  })).filter(include)
  const chunk = encodeChunk({ attemptId, actions })
  const inserted = await pool.query(`
    INSERT INTO trajectory_chunks (attempt_id, format, codec, kind, state, seq_first, seq_last, event_count,
      uncompressed_bytes, compressed_bytes, checksum, payload, receipt_event_ids, historic_sources, published_at)
    VALUES ($1, $2, $3, 'base', 'published', $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
    RETURNING chunk_id`, [attemptId, chunk.format, chunk.codec, chunk.seqFirst, chunk.seqLast, chunk.eventCount,
    chunk.uncompressedBytes, chunk.compressedBytes, chunk.checksum, chunk.payload, receipts ? chunk.eventIds : null,
    chunk.historicSources])
  await pool.query('UPDATE proof_attempts SET compacted_through = GREATEST(compacted_through, $2) WHERE attempt_id = $1',
    [attemptId, chunk.seqLast])
  const deleted = await pool.query('DELETE FROM proof_steps WHERE event_id = ANY($1::uuid[])', [chunk.eventIds])
  return { chunkId: inserted.rows[0].chunk_id, eventIds: chunk.eventIds, deleted: deleted.rowCount, chunk }
}
