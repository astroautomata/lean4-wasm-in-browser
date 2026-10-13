import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'
import { historicIngestionBound } from '../../src/migrate.js'
import { createCompactor, groupActions, observeBacklog } from '../../src/trajectory/compactor.js'
import { readAttempt } from '../../src/trajectory/reader.js'
import { attemptEvents, event, statuses, writerFixture } from '../helpers/collector.js'
import { skipWithoutDatabase } from '../helpers/database.js'

/** Compaction lifecycle against PostgreSQL (docs/compaction.md): readers
 * return identical actions before, during and after compaction; no crash
 * point loses an action, duplicates a chunk or removes unverified sources. */

const skip = skipWithoutDatabase
const IMMEDIATE = { minAgeSeconds: 0, inactiveSeconds: 0, recoverAfterSeconds: 0, replaceDelaySeconds: 0 }

async function withFixture(run) {
  const fixture = await writerFixture()
  try {
    const historicBound = await historicIngestionBound(fixture.db.pools.admin)
    const compactor = (settings = {}, options = {}) => createCompactor({
      pool: fixture.db.pools.compactor, historicBound, settings: { ...IMMEDIATE, ...settings }, ...options,
    })
    await run({ ...fixture, compactor })
  } finally {
    await fixture.close()
  }
}

async function snapshot(pool, attemptId) {
  const result = await readAttempt(pool, attemptId)
  return { actions: result.actions, errors: result.errors, completeness: result.completeness }
}

async function counts(pool, attemptId) {
  const live = await pool.query('SELECT count(*)::int AS n FROM proof_steps WHERE attempt_id = $1', [attemptId])
  const chunks = await pool.query(`SELECT state, sources_removed_at IS NOT NULL AS removed, event_count, kind
    FROM trajectory_chunks WHERE attempt_id = $1 ORDER BY seq_first`, [attemptId])
  return { live: live.rows[0].n, chunks: chunks.rows }
}

function classicEvents() {
  const shared = { user_uuid: crypto.randomUUID(), attempt_uuid: crypto.randomUUID(), mode: 'classic' }
  return [
    event({ ...shared, event_type: 'level_start', sequence: 0, elapsed_ms: 0, initial_script: 'intro n\n' }),
    event({ ...shared, sequence: 1, elapsed_ms: 10, step_type: 'edit', from_line: 1, removed_lines: 0, command: 'induction n with\n| zero => rfl' }),
    event({ ...shared, sequence: 2, elapsed_ms: 20, step_type: 'edit', from_line: 0, removed_lines: 2, command: '' }),
    event({ ...shared, sequence: 3, elapsed_ms: 30, step_type: 'edit', from_line: 0, removed_lines: 0, command: '  ∀ x, x = x 🎉' }),
    event({ ...shared, event_type: 'level_complete', sequence: 4, elapsed_ms: 40, lean_script: '∀ x, x = x' }),
  ]
}

test('shadow mode publishes verified chunks and keeps every source row', { skip }, async () => {
  await withFixture(async ({ writer, db, compactor }) => {
    const visual = attemptEvents({ steps: 7, complete: true })
    const classic = classicEvents()
    await writer.writeEvents([...visual, ...classic])
    for (const attemptId of [visual[0].attemptId, classic[0].attemptId]) {
      const before = await snapshot(db.pools.reader, attemptId)
      assert.equal(before.completeness.complete, true)
      const result = await compactor({ mode: 'shadow' }).compactAttempt({ attempt_id: attemptId, completed: true, inactive: true })
      assert.equal(result.chunks, 1)
      const state = await counts(db.pools.admin, attemptId)
      assert.equal(state.live, attemptId === visual[0].attemptId ? 7 : 3)
      assert.deepEqual(state.chunks.map(chunk => [chunk.state, chunk.removed, chunk.kind]), [['published', false, 'base']])
      assert.deepEqual(await snapshot(db.pools.reader, attemptId), before)
      // A second pass finds nothing new to chunk.
      assert.equal((await compactor().compactAttempt({ attempt_id: attemptId, completed: true, inactive: true })).chunks, 0)
    }
    const through = await db.pools.admin.query('SELECT compacted_through FROM proof_attempts WHERE attempt_id = $1', [visual[0].attemptId])
    assert.equal(through.rows[0].compacted_through, 7)
  })
})

test('replace mode removes exactly the verified sources; reads and retries are unchanged', { skip }, async () => {
  await withFixture(async ({ writer, db, compactor }) => {
    const events = attemptEvents({ steps: 5, complete: true })
    await writer.writeEvents(events)
    const before = await snapshot(db.pools.reader, events[0].attemptId)
    const worker = compactor({ mode: 'replace' })
    await worker.runOnce()
    // The first cycle publishes; the next replaces (delay 0).
    await worker.runOnce()
    const state = await counts(db.pools.admin, events[0].attemptId)
    assert.equal(state.live, 0)
    assert.deepEqual(state.chunks.map(chunk => [chunk.state, chunk.removed]), [['published', true]])
    assert.deepEqual(await snapshot(db.pools.reader, events[0].attemptId), before)
    assert.deepEqual(statuses(await writer.writeEvents(events)), events.map(() => 'duplicate'))
    assert.equal((await counts(db.pools.admin, events[0].attemptId)).live, 0, 'retries never resurrect rows')
  })
})

test('the canary limit bounds replacement', { skip }, async () => {
  await withFixture(async ({ writer, db, compactor }) => {
    const attempts = [attemptEvents({ steps: 2 }), attemptEvents({ steps: 2 }), attemptEvents({ steps: 2 })]
    await writer.writeEvents(attempts.flat())
    const worker = compactor({ mode: 'replace', replaceLimit: 2 })
    await worker.runOnce()
    const second = await worker.runOnce()
    assert.equal(second.replacement.replaced, 2)
    assert.equal(second.replacement.limited, true)
    assert.equal((await worker.runOnce()).replacement.replaced, 0)
    const live = await db.pools.admin.query('SELECT count(*)::int AS n FROM proof_steps')
    assert.equal(live.rows[0].n, 2)
  })
})

test('late actions survive replacement and become delta chunks', { skip }, async () => {
  await withFixture(async ({ writer, db, compactor }) => {
    const events = attemptEvents({ steps: 6 })
    const gap = events[3]
    await writer.writeEvents(events.filter(item => item !== gap))
    const late = event({ user_uuid: events[0].userId, attempt_uuid: events[0].attemptId, sequence: 9, elapsed_ms: 9000 })
    let concurrent = null
    const worker = compactor({ mode: 'replace' }, {
      hooks: {
        // A step arriving while the chunk is being published is a concurrent
        // late action: it waits for the attempt lock and is not part of the
        // verified source set.
        beforePublishCommit: async () => {
          if (!concurrent) {
            concurrent = writer.writeEvents([late])
            await new Promise(resolve => setTimeout(resolve, 100))
          }
        },
      },
    })
    await worker.runOnce()
    assert.deepEqual(statuses(await concurrent), ['accepted'])
    await worker.runOnce()
    assert.deepEqual(statuses(await writer.writeEvents([gap])), ['accepted'])
    let state = await counts(db.pools.admin, events[0].attemptId)
    assert.ok(state.live >= 1, 'late rows stay live after the base chunk replaced its sources')
    await worker.runOnce()
    await worker.runOnce()
    state = await counts(db.pools.admin, events[0].attemptId)
    assert.equal(state.live, 0)
    assert.ok(state.chunks.some(chunk => chunk.kind === 'delta'))
    const read = await snapshot(db.pools.reader, events[0].attemptId)
    assert.deepEqual(read.actions.map(action => action.sequence), [1, 2, 3, 4, 5, 6, 9])
    assert.deepEqual(read.errors, [])
    assert.deepEqual(read.completeness.missingSequences, [7, 8])
  })
})

for (const boundary of ['afterShadowInsert', 'afterVerify', 'beforePublishCommit', 'afterPublish', 'beforeReplaceCommit', 'afterReplace']) {
  test(`a crash at ${boundary} loses nothing and resumes idempotently`, { skip }, async () => {
    await withFixture(async ({ writer, db, compactor }) => {
      const events = attemptEvents({ steps: 4, complete: true })
      await writer.writeEvents(events)
      const attemptId = events[0].attemptId
      const before = await snapshot(db.pools.reader, attemptId)
      let crashed = false
      const crashing = compactor({ mode: 'replace' }, {
        hooks: {
          [boundary]: () => {
            if (!crashed) {
              crashed = true
              throw new Error(`simulated crash at ${boundary}`)
            }
          },
        },
      })
      for (let cycle = 0; cycle < 3 && !crashed; cycle++) await crashing.runOnce().catch(() => {})
      assert.ok(crashed, 'the boundary was reached')
      // Readers always see every action exactly once, whatever the crash point.
      assert.deepEqual(await snapshot(db.pools.reader, attemptId), before)

      const fresh = compactor({ mode: 'replace' })
      for (let cycle = 0; cycle < 3; cycle++) await fresh.runOnce()
      const state = await counts(db.pools.admin, attemptId)
      assert.equal(state.live, 0)
      assert.deepEqual(state.chunks.map(chunk => [chunk.state, chunk.removed, chunk.event_count]), [['published', true, 4]],
        'exactly one chunk, no duplicate built after the crash')
      assert.deepEqual(await snapshot(db.pools.reader, attemptId), before)
    })
  })
}

test('a source changed after building is never published or removed', { skip }, async () => {
  await withFixture(async ({ writer, db, compactor }) => {
    const events = attemptEvents({ steps: 3 })
    await writer.writeEvents(events)
    const attemptId = events[0].attemptId
    const worker = compactor({ mode: 'replace' }, {
      hooks: {
        afterVerify: () => db.pools.admin.query(`UPDATE proof_steps SET command = 'tampered' WHERE attempt_id = $1 AND sequence = 2`, [attemptId]),
      },
    })
    await worker.runOnce()
    const state = await counts(db.pools.admin, attemptId)
    assert.equal(state.live, 3)
    assert.deepEqual(state.chunks, [], 'the stale shadow chunk was discarded')
  })
})

test('corrupted chunks are reported, never silently read', { skip }, async () => {
  await withFixture(async ({ writer, db, compactor }) => {
    const events = attemptEvents({ steps: 3 })
    await writer.writeEvents(events)
    const attemptId = events[0].attemptId
    const worker = compactor({ mode: 'replace' })
    await worker.runOnce()
    await worker.runOnce()
    await db.pools.admin.query(`UPDATE trajectory_chunks SET payload = overlay(payload placing '\\x00'::bytea from 20 for 1),
      compressed_bytes = octet_length(payload) WHERE attempt_id = $1`, [attemptId])
    const read = await readAttempt(db.pools.reader, attemptId)
    assert.equal(read.actions.length, 0)
    assert.equal(read.errors.length, 1)
    assert.match(read.errors[0].code, /corrupt_chunk|chunk_too_large/u)
    assert.equal(read.completeness.complete, false)
  })
})

test('the recent-row window and inactivity gate what is eligible; long active attempts chunk in full chunks', { skip }, async () => {
  await withFixture(async ({ writer, db, compactor }) => {
    const events = attemptEvents({ steps: 7 })
    await writer.writeEvents(events)
    const attemptId = events[0].attemptId
    // Active attempt, below the threshold: nothing.
    const active = { attempt_id: attemptId, completed: false, inactive: false }
    assert.equal((await compactor({ activeChunkThreshold: 10, chunkMaxEvents: 3 }).compactAttempt(active)).chunks, 0)
    // Above the threshold: only full chunks of 3, the remainder stays live.
    assert.equal((await compactor({ activeChunkThreshold: 5, chunkMaxEvents: 3 }).compactAttempt(active)).chunks, 2)
    assert.equal((await counts(db.pools.admin, attemptId)).live, 7)
    const chunked = await db.pools.admin.query('SELECT event_count FROM trajectory_chunks WHERE attempt_id = $1 ORDER BY seq_first', [attemptId])
    assert.deepEqual(chunked.rows.map(row => row.event_count), [3, 3])
    // The recent-row window keeps fresh rows out entirely.
    const other = attemptEvents({ steps: 2 })
    await writer.writeEvents(other)
    const recent = compactor({ minAgeSeconds: 3600 })
    assert.equal((await recent.compactAttempt({ attempt_id: other[0].attemptId, completed: true, inactive: true })).chunks, 0)
  })
})

test('historic rows with unknown ingestion time are eligible by the migration bound', { skip }, async () => {
  await withFixture(async ({ writer, db, compactor }) => {
    const events = attemptEvents({ steps: 3 })
    await writer.writeEvents(events)
    const attemptId = events[0].attemptId
    await db.pools.admin.query('UPDATE proof_steps SET received_at = NULL WHERE attempt_id = $1', [attemptId])
    await db.pools.admin.query('UPDATE proof_attempts SET last_received_at = NULL, received_at = NULL WHERE attempt_id = $1', [attemptId])
    const before = await snapshot(db.pools.reader, attemptId)
    assert.equal(before.actions[0].receivedAtUs, null)
    await compactor({ mode: 'replace', minAgeSeconds: 0 }).runOnce()
    await compactor({ mode: 'replace' }).runOnce()
    assert.equal((await counts(db.pools.admin, attemptId)).live, 0)
    const chunk = await db.pools.admin.query('SELECT historic_sources FROM trajectory_chunks WHERE attempt_id = $1', [attemptId])
    assert.equal(chunk.rows[0].historic_sources, true)
    assert.deepEqual(await snapshot(db.pools.reader, attemptId), before)
  })
})

test('non-empty attributes, unicode and very long commands round-trip; oversized groups split', { skip }, async () => {
  await withFixture(async ({ writer, db, compactor }) => {
    const events = attemptEvents({ steps: 6 })
    events[2] = event({ user_uuid: events[0].userId, attempt_uuid: events[0].attemptId, sequence: 2, command: 'x'.repeat(60000) })
    await writer.writeEvents(events)
    const attemptId = events[0].attemptId
    await db.pools.admin.query(`UPDATE proof_steps SET attributes = '{"phantom": true, "nested": {"b": [1, "∀"]}}'
      WHERE attempt_id = $1 AND sequence = 1`, [attemptId])
    const before = await snapshot(db.pools.reader, attemptId)
    const result = await compactor({ mode: 'shadow', chunkMaxBytes: 4096 }).compactAttempt({ attempt_id: attemptId, completed: true, inactive: true })
    assert.ok(result.chunks >= 2)
    assert.deepEqual(await snapshot(db.pools.reader, attemptId), before)
  })
})

test('groupActions never splits an action and respects both bounds', () => {
  const action = command => ({ command, attributes: {} })
  const groups = groupActions([action('a'), action('b'), action('x'.repeat(5000)), action('c')], { chunkMaxEvents: 2, chunkMaxBytes: 1000 })
  assert.deepEqual(groups.map(group => group.length), [2, 1, 1])
})

test('backlog observation counts rows awaiting compaction', { skip }, async () => {
  await withFixture(async ({ writer, db, compactor }) => {
    const historicBound = await historicIngestionBound(db.pools.admin)
    const events = attemptEvents({ steps: 4 })
    await writer.writeEvents(events)
    let backlog = await observeBacklog(db.pools.compactor, { historicBound, minAgeSeconds: 0 })
    assert.equal(backlog.eligibleRows, 4)
    await compactor({ mode: 'shadow' }).runOnce()
    backlog = await observeBacklog(db.pools.compactor, { historicBound, minAgeSeconds: 0 })
    assert.equal(backlog.eligibleRows, 0)
    assert.equal(backlog.awaitingReplace, 1)
  })
})
