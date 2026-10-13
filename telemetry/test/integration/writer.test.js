import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'
import { sqlMicros } from '../../src/trajectory/codec.js'
import { attemptEvents, event, statuses, writerFixture } from '../helpers/collector.js'
import { skipWithoutDatabase } from '../helpers/database.js'

const skip = skipWithoutDatabase

async function withWriter(options, run) {
  const fixture = await writerFixture(options)
  try {
    await run(fixture)
  } finally {
    await fixture.close()
  }
}

async function snapshot(pool) {
  const attempts = await pool.query('SELECT xmin::text AS version, * FROM proof_attempts ORDER BY attempt_id')
  const steps = await pool.query('SELECT xmin::text AS version, * FROM proof_steps ORDER BY event_id')
  const users = await pool.query('SELECT xmin::text AS version, * FROM anonymous_users ORDER BY user_id')
  return { attempts: attempts.rows, steps: steps.rows, users: users.rows }
}

test('stores a start, steps and a completion exactly, with trusted ingestion times', { skip }, async () => {
  await withWriter({}, async ({ writer, db }) => {
    const events = attemptEvents({ steps: 2, complete: true })
    events.push(event({ user_uuid: events[0].userId, attempt_uuid: events[0].attemptId, sequence: 3, step_type: 'edit',
      from_line: 2, removed_lines: 1, command: 'exact\n  text  ', ts: '2026-08-04T14:30:00.000001+02:30' }))
    events[3].sequence = 4
    assert.deepEqual(statuses(await writer.writeEvents(events)), ['accepted', 'accepted', 'accepted', 'accepted', 'accepted'])

    const steps = (await db.pools.admin.query(`
      SELECT event_id::text, sequence, ${sqlMicros('client_ts')} AS ts_us, elapsed_ms, step_type::text, command, from_line,
             removed_lines, received_at
      FROM proof_steps ORDER BY sequence`)).rows
    assert.deepEqual(steps.map(row => [row.event_id, row.sequence, Number(row.ts_us), row.elapsed_ms, row.step_type, row.command,
      row.from_line, row.removed_lines]), [events[1], events[2], events[4]].map(item => [item.eventId, item.sequence, item.clientTsUs,
      item.elapsedMs, item.stepType, item.command, item.fromLine, item.removedLines]))
    assert.equal(Number(steps[2].ts_us), Date.UTC(2026, 7, 4, 12) * 1000 + 1, 'microseconds survive exactly')
    assert.ok(steps.every(row => row.received_at instanceof Date))

    const [attempt] = (await db.pools.admin.query(`
      SELECT *, ${sqlMicros('started_at')} AS started_us, ${sqlMicros('completed_at')} AS completed_us,
             ${sqlMicros('start_client_ts')} AS start_us FROM proof_attempts`)).rows
    assert.equal(attempt.start_event_id, events[0].eventId)
    assert.equal(attempt.start_sequence, 0)
    assert.equal(Number(attempt.start_us), events[0].clientTsUs)
    assert.equal(Number(attempt.started_us), events[0].clientTsUs)
    assert.equal(attempt.initial_script, '')
    assert.equal(attempt.completed, true)
    assert.equal(attempt.completion_event_id, events[3].eventId)
    assert.equal(attempt.completion_sequence, 4)
    assert.equal(Number(attempt.completed_us), events[3].clientTsUs)
    assert.equal(attempt.duration_ms, events[3].elapsedMs)
    assert.equal(attempt.play_script, 'intro n\nrfl')
    assert.equal(attempt.lean_script, 'theorem t : True := by\n  trivial')
    assert.ok(attempt.completion_received_at instanceof Date)
    assert.ok(attempt.last_received_at instanceof Date)
    assert.deepEqual(attempt.later_completion_sequences, [])
  })
})

test('duplicates do not mutate any row', { skip }, async () => {
  await withWriter({}, async ({ writer, db }) => {
    const events = attemptEvents({ steps: 3, complete: true })
    await writer.writeEvents(events)
    const before = await snapshot(db.pools.admin)
    assert.deepEqual(statuses(await writer.writeEvents(events)), events.map(() => 'duplicate'))
    assert.deepEqual(statuses(await writer.writeEvents([...events].reverse())), events.map(() => 'duplicate'))
    assert.deepEqual(await snapshot(db.pools.admin), before, 'no new row versions')
  })
})

test('distinguishes id conflicts from duplicates', { skip }, async () => {
  await withWriter({}, async ({ writer }) => {
    const events = attemptEvents({ steps: 2, complete: true })
    await writer.writeEvents(events)
    const [start, step, , completion] = events
    const other = attemptEvents({ steps: 1 })
    assert.deepEqual(statuses(await writer.writeEvents([
      { ...step, command: 'changed' },
      { ...step, attemptId: other[0].attemptId, userId: other[0].userId },
      { ...start, initialScript: 'different' },
      { ...completion, leanScript: 'different' },
      { ...step, eventId: start.eventId },
      { ...completion, eventId: step.eventId },
      { ...step, clientTsUs: step.clientTsUs + 1 },
    ])), ['rejected:id_conflict', 'rejected:id_conflict', 'rejected:id_conflict', 'rejected:id_conflict',
      'rejected:id_conflict', 'rejected:id_conflict', 'rejected:id_conflict'])
  })
})

test('distinguishes sequence conflicts from duplicates', { skip }, async () => {
  await withWriter({}, async ({ writer }) => {
    const events = attemptEvents({ steps: 2, complete: true })
    await writer.writeEvents(events)
    const shared = { user_uuid: events[0].userId, attempt_uuid: events[0].attemptId }
    assert.deepEqual(statuses(await writer.writeEvents([
      event({ ...shared, sequence: 1 }),
      event({ ...shared, sequence: 0 }),
      event({ ...shared, sequence: 3 }),
      event({ ...shared, event_type: 'level_start', sequence: 1 }),
      event({ ...shared, sequence: 4 }),
    ])), ['rejected:sequence_conflict', 'rejected:sequence_conflict', 'rejected:sequence_conflict', 'rejected:start_conflict',
      'accepted'])
  })
})

test('handles identity inside one batch', { skip }, async () => {
  await withWriter({}, async ({ writer }) => {
    const first = event({ sequence: 1 })
    const shared = { user_uuid: first.userId, attempt_uuid: first.attemptId }
    const sameSlot = event({ ...shared, sequence: 1 })
    assert.deepEqual(statuses(await writer.writeEvents([first, { ...first }, { ...first, command: 'other' }, sameSlot,
      event({ ...shared, sequence: 2 })])), ['accepted', 'duplicate', 'rejected:id_conflict', 'rejected:sequence_conflict', 'accepted'])
    const rejectedFirst = { ...first, eventId: crypto.randomUUID(), gameId: 'g/other' }
    assert.deepEqual(statuses(await writer.writeEvents([rejectedFirst, { ...rejectedFirst }])),
      ['rejected:context_mismatch', 'rejected:context_mismatch'], 'a copy of a rejected event is not reported as stored')
  })
})

test('a completion is immutable; later completions are recorded by sequence only', { skip }, async () => {
  await withWriter({}, async ({ writer, db }) => {
    const events = attemptEvents({ steps: 1, complete: true })
    await writer.writeEvents(events)
    const shared = { user_uuid: events[0].userId, attempt_uuid: events[0].attemptId }
    const later = event({ ...shared, event_type: 'level_complete', sequence: 5, play_script: 'other', lean_script: 'other' })
    assert.deepEqual(statuses(await writer.writeEvents([later])), ['rejected:already_completed'])
    assert.deepEqual(statuses(await writer.writeEvents([later])), ['rejected:already_completed'])
    const sameSequence = event({ ...shared, event_type: 'level_complete', sequence: 5 })
    assert.deepEqual(statuses(await writer.writeEvents([sameSequence, events.at(-1)])), ['rejected:already_completed', 'duplicate'])
    const [attempt] = (await db.pools.admin.query('SELECT * FROM proof_attempts')).rows
    assert.deepEqual(attempt.later_completion_sequences, [5])
    assert.equal(attempt.completion_event_id, events.at(-1).eventId)
    assert.equal(attempt.play_script, 'intro n\nrfl')
    // A step can no longer take a later completion's sequence.
    assert.deepEqual(statuses(await writer.writeEvents([event({ ...shared, sequence: 5 })])), ['rejected:sequence_conflict'])

    // Two completions in one batch: the first wins.
    const fresh = attemptEvents({ steps: 0 })
    const freshShared = { user_uuid: fresh[0].userId, attempt_uuid: fresh[0].attemptId }
    assert.deepEqual(statuses(await writer.writeEvents([
      fresh[0],
      event({ ...freshShared, event_type: 'level_complete', sequence: 1, lean_script: 'a' }),
      event({ ...freshShared, event_type: 'level_complete', sequence: 2, lean_script: 'b' }),
    ])), ['accepted', 'accepted', 'rejected:already_completed'])
  })
})

test('the later-completion record is bounded', { skip }, async () => {
  await withWriter({}, async ({ writer, db }) => {
    const events = attemptEvents({ steps: 0, complete: true })
    await writer.writeEvents(events)
    const shared = { user_uuid: events[0].userId, attempt_uuid: events[0].attemptId }
    const many = Array.from({ length: 70 }, (_, index) => event({ ...shared, event_type: 'level_complete', sequence: 100 + index }))
    await writer.writeEvents(many.slice(0, 50))
    await writer.writeEvents(many.slice(50))
    const [attempt] = (await db.pools.admin.query('SELECT later_completion_sequences FROM proof_attempts')).rows
    assert.equal(attempt.later_completion_sequences.length, 64)
  })
})

test('a completion may arrive before the steps it follows', { skip }, async () => {
  await withWriter({}, async ({ writer, db }) => {
    const events = attemptEvents({ steps: 3, complete: true })
    assert.deepEqual(statuses(await writer.writeEvents([events.at(-1)])), ['accepted'])
    assert.deepEqual(statuses(await writer.writeEvents(events.slice(0, -1))), ['accepted', 'accepted', 'accepted', 'accepted'])
    const count = await db.pools.admin.query('SELECT count(*)::int AS n FROM proof_steps')
    assert.equal(count.rows[0].n, 3)
  })
})

test('reconciles a late start without changing the context its attempt was created with', { skip }, async () => {
  await withWriter({}, async ({ writer, db }) => {
    const events = attemptEvents({ steps: 2 })
    const [start, ...steps] = events
    const earlierStart = { ...start, clientTsUs: steps[0].clientTsUs - 5000000, initialScript: 'intro n',
      sourceAttemptId: crypto.randomUUID() }
    assert.deepEqual(statuses(await writer.writeEvents(steps)), ['accepted', 'accepted'])
    let [attempt] = (await db.pools.admin.query(`SELECT *, ${sqlMicros('started_at')} AS started_us FROM proof_attempts`)).rows
    assert.equal(Number(attempt.started_us), steps[0].clientTsUs, 'created from its lowest-sequence event')
    assert.equal(attempt.initial_script, null)

    assert.deepEqual(statuses(await writer.writeEvents([{ ...earlierStart, levelId: 9 }])), ['rejected:context_mismatch'])
    assert.deepEqual(statuses(await writer.writeEvents([earlierStart])), ['accepted'])
    ;[attempt] = (await db.pools.admin.query(`SELECT *, ${sqlMicros('started_at')} AS started_us FROM proof_attempts`)).rows
    assert.equal(Number(attempt.started_us), earlierStart.clientTsUs, 'started_at moves to the earlier start')
    assert.equal(attempt.initial_script, 'intro n')
    assert.equal(attempt.source_attempt_id, earlierStart.sourceAttemptId)
    assert.equal(attempt.level_id, start.levelId)
    assert.deepEqual(statuses(await writer.writeEvents([earlierStart])), ['duplicate'])
    assert.deepEqual(statuses(await writer.writeEvents([{ ...earlierStart, eventId: crypto.randomUUID() }])), ['rejected:start_conflict'])
  })
})

test('rejects context mismatches against the attempt row and within a batch', { skip }, async () => {
  await withWriter({}, async ({ writer }) => {
    const events = attemptEvents({ steps: 1 })
    await writer.writeEvents(events)
    const shared = { user_uuid: events[0].userId, attempt_uuid: events[0].attemptId }
    assert.deepEqual(statuses(await writer.writeEvents([
      event({ ...shared, sequence: 2, level_id: 3 }),
      event({ ...shared, sequence: 3, mode: 'classic', step_type: 'edit', from_line: 0, removed_lines: 0 }),
      event({ ...shared, sequence: 4, user_uuid: crypto.randomUUID() }),
      event({ ...shared, sequence: 5, world_id: 'Other' }),
      event({ ...shared, sequence: 6, game_id: 'g/other/Game' }),
      event({ ...shared, sequence: 7 }),
    ])), ['rejected:context_mismatch', 'rejected:context_mismatch', 'rejected:context_mismatch', 'rejected:context_mismatch',
      'rejected:context_mismatch', 'accepted'])

    const fresh = { attempt_uuid: crypto.randomUUID(), user_uuid: crypto.randomUUID() }
    assert.deepEqual(statuses(await writer.writeEvents([
      event({ ...fresh, sequence: 2, level_id: 7 }),
      event({ ...fresh, event_type: 'level_start', sequence: 0 }),
    ])), ['rejected:context_mismatch', 'accepted'], 'the batch start defines a new attempt')
  })
})

test('one invalid event does not poison the batch or later deliveries', { skip }, async () => {
  await withWriter({}, async ({ writer, db }) => {
    const good = attemptEvents({ steps: 2 })
    // Bypass validation to force a PostgreSQL data exception (22021) that
    // validation normally prevents: only that event is rejected.
    const poisoned = { ...event({ user_uuid: good[0].userId, attempt_uuid: good[0].attemptId, sequence: 9 }), command: 'nul\u0000' }
    assert.deepEqual(statuses(await writer.writeEvents([good[0], poisoned, good[1], good[2]])),
      ['accepted', 'rejected:invalid_event', 'accepted', 'accepted'])
    assert.deepEqual(statuses(await writer.writeEvents([poisoned])), ['rejected:invalid_event'])
    const count = await db.pools.admin.query('SELECT count(*)::int AS n FROM proof_steps')
    assert.equal(count.rows[0].n, 2)
  })
})

test('a transaction abandoned before COMMIT acknowledges nothing and the retry is accepted', { skip }, async () => {
  await withWriter({}, async ({ writer, database, db }) => {
    const events = attemptEvents({ steps: 2 })
    const controller = new AbortController()
    let seen = 0
    database.pool.on('acquire', client => {
      const query = client.query
      client.query = (...args) => {
        if (typeof args[0] === 'string' && args[0].includes('INSERT INTO proof_steps') && seen++ === 0) controller.abort('deadline')
        return query.apply(client, args)
      }
    })
    await assert.rejects(writer.writeEvents(events, { signal: controller.signal }), error => error.name === 'AbortError')
    const count = await db.pools.admin.query('SELECT (SELECT count(*) FROM proof_steps)::int AS steps, (SELECT count(*) FROM proof_attempts)::int AS attempts')
    assert.deepEqual(count.rows[0], { steps: 0, attempts: 0 })
    assert.deepEqual(statuses(await writer.writeEvents(events)), ['accepted', 'accepted', 'accepted'])
  })
})

test('uses a fixed number of statements per batch, whatever its size', { skip }, async () => {
  await withWriter({}, async fixture => {
    const measure = async events => {
      fixture.resetStatements()
      await fixture.writer.writeEvents(events)
      return fixture.statements
    }
    // The count depends on which kinds of change a batch makes, never on how many events it holds.
    const oneStep = await measure([event()])
    const fiftySteps = await measure(attemptEvents({ steps: 50 }).slice(1))
    const fiftyAttempts = await measure(Array.from({ length: 50 }, () => event()))
    assert.equal(oneStep, fiftySteps)
    assert.equal(oneStep, fiftyAttempts)
    const startAndOne = await measure(attemptEvents({ steps: 1 }))
    const startAndMany = await measure(attemptEvents({ steps: 49 }))
    const mixed = await measure([...attemptEvents({ steps: 20, complete: true }), ...attemptEvents({ steps: 20, complete: true }),
      ...attemptEvents({ steps: 4 })])
    assert.equal(startAndOne, startAndMany)
    assert.equal(startAndOne, mixed)
    assert.ok(mixed <= 8, `a batch used ${mixed} statements, including BEGIN and COMMIT`)
    const retry = attemptEvents({ steps: 49 })
    await fixture.writer.writeEvents(retry)
    assert.ok(await measure(retry) <= 7, 'a fully duplicate batch writes nothing')
  })
})

test('concurrent batches on the same users and attempts finish without deadlocks', { skip }, async () => {
  await withWriter({ env: { PG_POOL_SIZE: '8', EVENT_WRITERS: '6', FEEDBACK_WRITERS: '1' } }, async ({ writer, db }) => {
    const users = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
    const attempts = Array.from({ length: 6 }, (_, index) => ({ attempt_uuid: crypto.randomUUID(), user_uuid: users[index % 3] }))
    const all = []
    for (const attempt of attempts) {
      all.push(event({ ...attempt, event_type: 'level_start', sequence: 0 }))
      for (let sequence = 1; sequence <= 30; sequence++) all.push(event({ ...attempt, sequence }))
      all.push(event({ ...attempt, event_type: 'level_complete', sequence: 31 }))
    }
    // Overlapping batches in shuffled order; every event appears in two batches.
    const shuffled = list => list.map(item => [Math.random(), item]).sort((a, b) => a[0] - b[0]).map(([, item]) => item)
    const batches = []
    for (const round of [shuffled(all), shuffled(all)]) {
      for (let index = 0; index < round.length; index += 12) batches.push(round.slice(index, index + 12))
    }
    const results = await Promise.allSettled(batches.map(batch => writer.writeEvents(batch)))
    const failures = results.filter(result => result.status === 'rejected')
    assert.deepEqual(failures.map(result => result.reason?.code), [], 'no batch failed')
    const outcomes = results.flatMap(result => result.value)
    assert.equal(outcomes.filter(outcome => outcome.status === 'accepted').length, all.length)
    assert.equal(outcomes.filter(outcome => outcome.status === 'duplicate').length, all.length)
    const steps = await db.pools.admin.query('SELECT count(*)::int AS n FROM proof_steps')
    assert.equal(steps.rows[0].n, 6 * 30)
    const done = await db.pools.admin.query('SELECT count(*)::int AS n FROM proof_attempts WHERE completed AND start_event_id IS NOT NULL')
    assert.equal(done.rows[0].n, 6)
  })
})

test('coarsens last_seen and last_received_at so unchanged rows are not rewritten', { skip }, async () => {
  await withWriter({ env: { LAST_SEEN_RESOLUTION_MS: '60000', LAST_RECEIVED_RESOLUTION_MS: '60000' } }, async ({ writer, db }) => {
    const events = attemptEvents({ steps: 4 })
    await writer.writeEvents(events.slice(0, 2))
    const before = await snapshot(db.pools.admin)
    await writer.writeEvents(events.slice(2))
    const after = await snapshot(db.pools.admin)
    assert.equal(after.users[0].version, before.users[0].version, 'last_seen within the resolution: no update')
    assert.equal(after.attempts[0].version, before.attempts[0].version, 'last_received_at within the resolution: no update')

    const later = event({ user_uuid: events[0].userId, attempt_uuid: events[0].attemptId, sequence: 9, ts: '2026-08-04T13:00:00Z' })
    await db.pools.admin.query(`UPDATE proof_attempts SET last_received_at = now() - interval '2 minutes'`)
    await writer.writeEvents([later])
    const [user] = (await db.pools.admin.query(`SELECT ${sqlMicros('last_seen')} AS seen FROM anonymous_users`)).rows
    assert.equal(Number(user.seen), later.clientTsUs)
    const [attempt] = (await db.pools.admin.query(`SELECT now() - last_received_at < interval '10 seconds' AS fresh FROM proof_attempts`)).rows
    assert.equal(attempt.fresh, true)
  })
})

test('the late-event policy rejects new events of long-idle attempts but still recognises duplicates', { skip }, async () => {
  await withWriter({ env: { LATE_EVENT_MAX_AGE_DAYS: '1' } }, async ({ writer, db }) => {
    const events = attemptEvents({ steps: 2 })
    await writer.writeEvents(events)
    await db.pools.admin.query(`UPDATE proof_attempts SET last_received_at = now() - interval '2 days'`)
    const shared = { user_uuid: events[0].userId, attempt_uuid: events[0].attemptId }
    assert.deepEqual(statuses(await writer.writeEvents([events[1], event({ ...shared, sequence: 7 })])), ['duplicate', 'rejected:late_event'])
    assert.deepEqual(statuses(await writer.writeEvents([event()])), ['accepted'], 'new attempts are not late')
  })
})

test('stores feedback once and tells duplicates from conflicts', { skip }, async () => {
  await withWriter({}, async ({ writer, db }) => {
    const report = {
      reportId: crypto.randomUUID(), userId: crypto.randomUUID(), gameId: 'g/local/NNG4', worldId: 'Tutorial', levelId: 2,
      mode: 'visual', message: 'Drop target ∀ 🎉 broken', proofState: { b: [1, 'x'], a: { nested: true } },
      clientTsUs: Date.UTC(2026, 7, 12) * 1000 + 7, build: { site: '3c14d15a1b2c' },
    }
    assert.equal(await writer.storeFeedback(report), 'accepted')
    assert.equal(await writer.storeFeedback({ ...report, proofState: { a: { nested: true }, b: [1, 'x'] }, build: null }), 'duplicate')
    assert.equal(await writer.storeFeedback({ ...report, message: 'changed' }), 'conflict')
    assert.equal(await writer.storeFeedback({ ...report, reportId: crypto.randomUUID(), userId: null }), 'accepted')
    const rows = (await db.pools.admin.query(`SELECT message, attributes, ${sqlMicros('client_ts')} AS ts FROM feedback_reports ORDER BY received_at`)).rows
    assert.equal(rows.length, 2)
    assert.equal(rows[0].message, report.message)
    assert.deepEqual(rows[0].attributes, { build: { site: '3c14d15a1b2c' } })
    assert.equal(Number(rows[0].ts), report.clientTsUs)
  })
})

test('an attempt keeps the build and platform of the event that created it', { skip }, async () => {
  await withWriter({}, async ({ writer, db }) => {
    const shared = { user_uuid: crypto.randomUUID(), attempt_uuid: crypto.randomUUID() }
    const build = { site: '3c14d15a1b2c' }
    // The step precedes the start in the batch; the start still creates the attempt.
    const step = event({ ...shared, sequence: 1, platform: { browser: 'firefox', device: 'desktop' } })
    const start = event({ ...shared, event_type: 'level_start', sequence: 0, elapsed_ms: 0, build,
      platform: { browser: 'safari', device: 'mobile', model: 'iPhone' } })
    assert.deepEqual(statuses(await writer.writeEvents([step, start])), ['accepted', 'accepted'])
    // Later events with another platform, and a retry differing only in platform, change nothing.
    const later = event({ ...shared, sequence: 2, platform: { browser: 'chrome', device: 'desktop' } })
    assert.deepEqual(statuses(await writer.writeEvents([later, { ...start, platform: null, build: null }])), ['accepted', 'duplicate'])
    const rows = (await db.pools.admin.query('SELECT attributes FROM proof_attempts')).rows
    assert.deepEqual(rows, [{ attributes: { build, platform: { browser: 'safari', device: 'mobile' } } }])

    // Clients before October 2026 send neither: the attempt has empty attributes.
    const legacy = event({ sequence: 1 })
    assert.deepEqual(statuses(await writer.writeEvents([legacy])), ['accepted'])
    const old = await db.pools.admin.query('SELECT attributes FROM proof_attempts WHERE attempt_id = $1', [legacy.attemptId])
    assert.deepEqual(old.rows[0].attributes, {})
  })
})

test('feedback keeps its build and platform outside its identity', { skip }, async () => {
  await withWriter({}, async ({ writer, db }) => {
    const report = {
      reportId: crypto.randomUUID(), userId: null, gameId: 'g/local/NNG4', worldId: 'Tutorial', levelId: 2,
      mode: 'classic', message: 'Hint unclear', proofState: { proofBody: 'intro n' }, clientTsUs: Date.UTC(2026, 9, 12) * 1000,
      build: null, platform: { browser: 'samsung', device: 'mobile' },
    }
    assert.equal(await writer.storeFeedback(report), 'accepted')
    assert.equal(await writer.storeFeedback({ ...report, platform: { browser: 'chrome', device: 'desktop' } }), 'duplicate')
    const rows = (await db.pools.admin.query('SELECT attributes FROM feedback_reports')).rows
    assert.deepEqual(rows, [{ attributes: { platform: { browser: 'samsung', device: 'mobile' } } }])
  })
})
