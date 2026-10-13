import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'
import { event, statuses, writerFixture } from '../helpers/collector.js'
import { skipWithoutDatabase } from '../helpers/database.js'

/** Rows written by collectors before event identities existed (migrations
 * 001-004 only, millisecond client timestamps, no start/completion ids). */

const user = crypto.randomUUID()
const completed = crypto.randomUUID()
const createdByStep = crypto.randomUUID()
const scripted = crypto.randomUUID()
const legacyStep = crypto.randomUUID()
const context = { user_uuid: user, game_id: 'g/local/NNG4', world_id: 'Tutorial', level_id: 2, mode: 'visual' }
const ts = second => `2026-08-04T12:00:0${second}.250Z`

async function seed(pool) {
  await pool.query(`INSERT INTO anonymous_users VALUES ($1, '2026-08-04T12:00:00Z', '2026-08-04T12:00:05Z')`, [user])
  await pool.query(`
    INSERT INTO proof_attempts (attempt_id, user_id, game_id, world_id, level_id, mode, started_at, initial_script,
                                completed, completed_at, duration_ms, play_script, lean_script)
    VALUES ($1, $4, 'g/local/NNG4', 'Tutorial', 2, 'visual', $5, 'intro n', true, $6, 5000, 'intro n\nrfl', 'by rfl'),
           ($2, $4, 'g/local/NNG4', 'Tutorial', 2, 'visual', $7, NULL, false, NULL, NULL, NULL, NULL),
           ($3, $4, 'g/local/NNG4', 'Tutorial', 2, 'visual', $5, 'x', false, NULL, NULL, NULL, NULL)`,
  [completed, createdByStep, scripted, user, ts(0), ts(5), ts(1)])
  await pool.query(`
    INSERT INTO proof_steps (event_id, attempt_id, sequence, client_ts, elapsed_ms, step_type, command)
    VALUES ($1, $2, 1, $3, 1000, 'command', 'intro n'), ($4, $2, 2, $5, 2000, 'undo', 'undo')`,
  [legacyStep, completed, ts(1), crypto.randomUUID(), ts(2)])
}

test('retries from old clients against legacy rows are duplicates, conflicts or late identities', { skip: skipWithoutDatabase }, async () => {
  const fixture = await writerFixture({ migrate: 'legacy' })
  try {
    await seed(fixture.db.pools.admin)
    await fixture.migrate()
    const { writer } = fixture
    const onCompleted = { ...context, attempt_uuid: completed }

    const step = event({ ...onCompleted, event_id: legacyStep, sequence: 1, elapsed_ms: 1000, ts: ts(1), command: 'intro n' })
    assert.deepEqual(statuses(await writer.writeEvents([step, { ...step, command: 'intro m' }])), ['duplicate', 'rejected:id_conflict'])

    const completion = event({ ...onCompleted, event_type: 'level_complete', sequence: 3, elapsed_ms: 5000, ts: ts(5),
      play_script: 'intro n\nrfl', lean_script: 'by rfl' })
    assert.deepEqual(statuses(await writer.writeEvents([completion])), ['duplicate'])
    let [row] = (await fixture.db.pools.admin.query('SELECT * FROM proof_attempts WHERE attempt_id = $1', [completed])).rows
    assert.equal(row.completion_event_id, completion.eventId, 'the identical retry now identifies the legacy completion')
    assert.equal(row.completion_sequence, 3)
    assert.equal(row.completion_received_at, null, 'its ingestion time stays unknown')
    assert.deepEqual(statuses(await writer.writeEvents([completion])), ['duplicate'])
    const different = event({ ...onCompleted, event_type: 'level_complete', sequence: 4, elapsed_ms: 9000, lean_script: 'by simp' })
    assert.deepEqual(statuses(await writer.writeEvents([different])), ['rejected:already_completed'])
    ;[row] = (await fixture.db.pools.admin.query('SELECT * FROM proof_attempts WHERE attempt_id = $1', [completed])).rows
    assert.equal(row.lean_script, 'by rfl')
    assert.deepEqual(row.later_completion_sequences, [4])

    const start = event({ ...onCompleted, event_type: 'level_start', sequence: 0, elapsed_ms: 0, ts: ts(0), initial_script: 'intro n' })
    assert.deepEqual(statuses(await writer.writeEvents([start])), ['accepted'], 'a legacy start is recorded on retry')
    assert.deepEqual(statuses(await writer.writeEvents([start])), ['duplicate'])

    const lateStart = event({ ...context, attempt_uuid: createdByStep, event_type: 'level_start', sequence: 0, ts: ts(0), initial_script: 'z' })
    assert.deepEqual(statuses(await writer.writeEvents([lateStart])), ['accepted'])
    const conflicting = event({ ...context, attempt_uuid: scripted, event_type: 'level_start', sequence: 0, initial_script: 'y' })
    assert.deepEqual(statuses(await writer.writeEvents([conflicting])), ['rejected:start_conflict'])
    ;[row] = (await fixture.db.pools.admin.query('SELECT initial_script FROM proof_attempts WHERE attempt_id = $1', [scripted])).rows
    assert.equal(row.initial_script, 'x')

    const newStep = event({ ...onCompleted, sequence: 5 })
    assert.deepEqual(statuses(await writer.writeEvents([newStep])), ['accepted'])
    const steps = await fixture.db.pools.admin.query('SELECT count(*)::int AS n FROM proof_steps')
    assert.equal(steps.rows[0].n, 3)
  } finally {
    await fixture.close()
  }
})
