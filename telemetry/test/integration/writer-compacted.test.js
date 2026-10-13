import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'
import { toHttpError } from '../../src/http/errors.js'
import { ChunkUnavailableError } from '../../src/writer.js'
import { attemptEvents, compact, event, statuses, writerFixture } from '../helpers/collector.js'
import { skipWithoutDatabase } from '../helpers/database.js'

/** Identity after compaction (docs/design.md section 8): a step whose live row
 * was replaced by a published chunk is still a duplicate or a conflict, and is
 * never inserted again. Chunks are published here directly, as the compactor
 * would, so these tests do not depend on it. */

const skip = skipWithoutDatabase

async function withCompacted(run) {
  const fixture = await writerFixture()
  try {
    await run(fixture)
  } finally {
    await fixture.close()
  }
}

async function liveSteps(pool, attemptId) {
  const result = await pool.query('SELECT sequence FROM proof_steps WHERE attempt_id = $1 ORDER BY sequence', [attemptId])
  return result.rows.map(row => row.sequence)
}

test('retries of compacted steps are duplicates and never resurrect live rows', { skip }, async () => {
  await withCompacted(async ({ writer, db }) => {
    const events = attemptEvents({ steps: 6, complete: true })
    const missing = events[4]
    await writer.writeEvents(events.filter(item => item !== missing))
    const published = await compact(db.pools.admin, events[0].attemptId)
    assert.equal(published.deleted, 5)
    assert.deepEqual(await liveSteps(db.pools.admin, events[0].attemptId), [])

    const retry = events.filter(item => item !== missing)
    assert.deepEqual(statuses(await writer.writeEvents(retry)), retry.map(() => 'duplicate'))
    assert.deepEqual(await liveSteps(db.pools.admin, events[0].attemptId), [], 'nothing was re-inserted')

    // A late step filling a gap inside the chunk's range is new: it stays live.
    assert.deepEqual(statuses(await writer.writeEvents([missing])), ['accepted'])
    assert.deepEqual(statuses(await writer.writeEvents([missing])), ['duplicate'])
    assert.deepEqual(await liveSteps(db.pools.admin, events[0].attemptId), [missing.sequence])
  })
})

test('conflicts with compacted steps are detected exactly as for live rows', { skip }, async () => {
  await withCompacted(async ({ writer, db }) => {
    const events = attemptEvents({ steps: 4 })
    await writer.writeEvents(events)
    await compact(db.pools.admin, events[0].attemptId)
    const shared = { user_uuid: events[0].userId, attempt_uuid: events[0].attemptId }
    const other = attemptEvents({ steps: 0 })[0]
    await writer.writeEvents([other])
    assert.deepEqual(statuses(await writer.writeEvents([
      { ...events[2], command: 'changed' },
      { ...events[2], elapsedMs: events[2].elapsedMs + 1 },
      event({ ...shared, sequence: 3 }),
      { ...events[2], attemptId: other.attemptId, userId: other.userId, sequence: 9 },
      { ...events[3], eventType: 'level_start', stepType: null, command: null },
      event({ ...shared, sequence: 5 }),
    ])), ['rejected:id_conflict', 'rejected:id_conflict', 'rejected:sequence_conflict', 'rejected:id_conflict',
      'rejected:id_conflict', 'accepted'])
    assert.deepEqual(await liveSteps(db.pools.admin, events[0].attemptId), [5])
    assert.deepEqual(await liveSteps(db.pools.admin, other.attemptId), [], 'a reused id is not inserted under another attempt')
  })
})

test('after receipt expiry, (attempt, sequence) coverage still prevents resurrection', { skip }, async () => {
  await withCompacted(async ({ writer, db }) => {
    const events = attemptEvents({ steps: 3 })
    await writer.writeEvents(events)
    await compact(db.pools.admin, events[0].attemptId, { receipts: false })
    const shared = { user_uuid: events[0].userId, attempt_uuid: events[0].attemptId }
    assert.deepEqual(statuses(await writer.writeEvents([events[1], { ...events[2], command: 'changed' }, event({ ...shared, sequence: 2 })])),
      ['duplicate', 'rejected:id_conflict', 'rejected:sequence_conflict'])
    assert.deepEqual(await liveSteps(db.pools.admin, events[0].attemptId), [])
    // The documented limit of receipt expiry: an expired id reused under a
    // different attempt is no longer recognised.
    const other = attemptEvents({ steps: 0 })[0]
    const reused = { ...events[1], attemptId: other.attemptId, userId: other.userId }
    assert.deepEqual(statuses(await writer.writeEvents([other, reused])), ['accepted', 'accepted'])
  })
})

test('a corrupt chunk needed for a decision fails the batch instead of guessing', { skip }, async () => {
  await withCompacted(async ({ writer, db }) => {
    const events = attemptEvents({ steps: 2 })
    await writer.writeEvents(events)
    const { chunkId } = await compact(db.pools.admin, events[0].attemptId)
    await db.pools.admin.query(`UPDATE trajectory_chunks SET checksum = decode(repeat('00', 32), 'hex') WHERE chunk_id = $1`, [chunkId])
    await assert.rejects(writer.writeEvents([events[1]]), error => {
      assert.ok(error instanceof ChunkUnavailableError)
      assert.equal(toHttpError(error).status, 500)
      return true
    })
    assert.deepEqual(await liveSteps(db.pools.admin, events[0].attemptId), [])
    // Events of other attempts are unaffected.
    assert.deepEqual(statuses(await writer.writeEvents([event()])), ['accepted'])
  })
})

test('shadow chunks are not authoritative: their sources stay live and decide', { skip }, async () => {
  await withCompacted(async ({ writer, db }) => {
    const events = attemptEvents({ steps: 2 })
    await writer.writeEvents(events)
    await db.pools.admin.query(`
      INSERT INTO trajectory_chunks (attempt_id, format, codec, kind, state, seq_first, seq_last, event_count, uncompressed_bytes,
        compressed_bytes, checksum, payload, receipt_event_ids, historic_sources)
      VALUES ($1, 'lean-trajectory/1', 'gzip', 'base', 'shadow', 1, 2, 2, 10, 1, decode(repeat('00', 32), 'hex'), '\\x00', $2, false)`,
    [events[0].attemptId, [events[1].eventId, crypto.randomUUID()]])
    assert.deepEqual(statuses(await writer.writeEvents(events)), ['duplicate', 'duplicate', 'duplicate'])
  })
})
