import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { connection } from '../src/env.js'
import { decodeChunk, DEFAULT_LIMITS } from '../src/trajectory/codec.js'
import { chunkManifest } from '../src/trajectory/reader.js'

/** Verify every trajectory chunk in a database (docs/compaction.md):
 * decode within the codec limits (checksum, counts, range, row validity),
 * receipts equal to the payload's event ids (unless expired by policy after
 * the sources were removed), no two published chunks of an attempt holding
 * the same sequence, and compacted_through equal to the highest published
 * sequence (or above it when retention expired the detail).
 *
 * Runs as any role that can read the tables (telemetry_reader:
 * READER_DATABASE_URL or PG* with READER_PGUSER/READER_PGPASSWORD(_FILE)).
 * Prints a JSON report without any payload content; exits 1 on any failure. */

export async function verifyChunks(queryable, { batchSize = 200, limits = DEFAULT_LIMITS } = {}) {
  const report = { chunks: 0, published: 0, shadow: 0, actions: 0, attempts: 0, failures: [] }
  const fail = (failure) => {
    if (report.failures.length < 1000) report.failures.push(failure)
  }
  let cursor = '00000000-0000-0000-0000-000000000000'
  for (;;) {
    const attempts = (await queryable.query(`
      SELECT a.attempt_id::text, a.compacted_through, a.detail_expired_at IS NOT NULL AS detail_expired
      FROM proof_attempts a
      WHERE a.attempt_id > $1::uuid
        AND (a.compacted_through IS NOT NULL OR EXISTS (SELECT 1 FROM trajectory_chunks c WHERE c.attempt_id = a.attempt_id))
      ORDER BY a.attempt_id LIMIT $2`, [cursor, batchSize])).rows
    for (const attempt of attempts) {
      cursor = attempt.attempt_id
      report.attempts++
      const chunks = (await queryable.query(`
        SELECT chunk_id::text, state, format, codec, seq_first, seq_last, event_count, uncompressed_bytes, checksum,
               payload, receipt_event_ids::text[] AS receipts, sources_removed_at IS NOT NULL AS sources_removed
        FROM trajectory_chunks WHERE attempt_id = $1 ORDER BY seq_first, chunk_id`, [attempt.attempt_id])).rows
      const held = new Map()
      let highest = null
      for (const chunk of chunks) {
        report.chunks++
        report[chunk.state === 'published' ? 'published' : 'shadow']++
        let actions
        try {
          actions = decodeChunk(chunk.payload, chunkManifest(chunk, attempt.attempt_id), limits)
        } catch (error) {
          fail({ attemptId: attempt.attempt_id, chunkId: chunk.chunk_id, code: error.code ?? 'decode', message: error.message })
          continue
        }
        report.actions += actions.length
        const ids = actions.map(action => action.eventId)
        if (chunk.receipts === null) {
          if (!chunk.sources_removed) fail({ attemptId: attempt.attempt_id, chunkId: chunk.chunk_id, code: 'receipts_missing',
            message: 'receipts are cleared although the sources were never removed' })
        } else if (chunk.receipts.length !== ids.length || chunk.receipts.some((id, index) => id !== ids[index])) {
          fail({ attemptId: attempt.attempt_id, chunkId: chunk.chunk_id, code: 'receipt_mismatch', message: 'receipts differ from payload ids' })
        }
        if (chunk.state !== 'published') continue
        highest = Math.max(highest ?? -1, chunk.seq_last)
        for (const action of actions) {
          const other = held.get(action.sequence)
          if (other) fail({ attemptId: attempt.attempt_id, chunkId: chunk.chunk_id, code: 'overlap',
            message: `sequence ${action.sequence} also in chunk ${other}` })
          else held.set(action.sequence, chunk.chunk_id)
        }
      }
      const through = attempt.compacted_through
      const consistent = attempt.detail_expired ? (highest === null || (through ?? -1) >= highest) : through === highest
      if (!consistent) {
        fail({ attemptId: attempt.attempt_id, code: 'compacted_through', message: `compacted_through ${through} but highest published ${highest}` })
      }
    }
    if (attempts.length < batchSize) break
  }
  report.ok = report.failures.length === 0
  return report
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pool = new pg.Pool({ ...connection(process.env, 'READER_'), max: 1, application_name: 'telemetry-verify-chunks' })
  verifyChunks(pool)
    .then(report => {
      console.log(JSON.stringify(report))
      process.exitCode = report.ok ? 0 : 1
    }, error => {
      console.error(`verify-chunks failed: ${error.message}`)
      process.exitCode = 1
    })
    .finally(() => pool.end())
}
