import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import { createHealth } from '../../src/health.js'
import { writerFixture } from '../helpers/collector.js'
import { skipWithoutDatabase } from '../helpers/database.js'
import { ORIGIN, rawRequest, request, startApp, waitFor, wireEvent, wireFeedback } from '../helpers/http.js'

/** The HTTP layer against a real PostgreSQL: crash resistance, deadlines,
 * readiness and acknowledgement only after commit. */

const skip = skipWithoutDatabase

async function withStack({ env = {} } = {}, run) {
  const fixture = await writerFixture({ env })
  const health = createHealth({ intervalMs: 200, maxAgeMs: 2000, check: () => fixture.database.checkReady(), metrics: fixture.metrics })
  fixture.database.observe({ success: () => health.recordSuccess(), failure: () => health.recordFailure() })
  health.setSchema('compatible')
  const instance = await startApp({ config: fixture.config, writer: fixture.writer, health, metrics: fixture.metrics })
  try {
    await run({ ...instance, fixture, health, admin: fixture.db.pools.admin })
  } finally {
    await instance.close()
    await fixture.close()
  }
}

async function count(pool, table) {
  return (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n
}

test('acknowledges v1 and v2 only after commit, and v2 reports duplicates on retry', { skip }, async () => {
  await withStack({}, async ({ port, admin }) => {
    const user = wireEvent().user_uuid
    const attempt = wireEvent().attempt_uuid
    const events = [
      wireEvent({ user_uuid: user, attempt_uuid: attempt, event_type: 'level_start', sequence: 0, initial_script: '' }),
      wireEvent({ user_uuid: user, attempt_uuid: attempt, sequence: 1, command: 'induction n with ∀ 🎉' }),
    ]
    assert.equal((await request(port, { body: { events } })).status, 204)
    assert.equal(await count(admin, 'proof_steps'), 1)
    const v2 = await request(port, { path: '/v2/events', body: { events: [...events,
      wireEvent({ user_uuid: user, attempt_uuid: attempt, sequence: 1 }), { ...events[1], command: 'changed' }] } })
    assert.equal(v2.status, 200)
    assert.deepEqual(v2.json.results.map(result => result.reason ?? result.status),
      ['duplicate', 'duplicate', 'sequence_conflict', 'id_conflict'])
    const stored = await admin.query('SELECT command FROM proof_steps')
    assert.equal(stored.rows[0].command, 'induction n with ∀ 🎉')

    const report = wireFeedback()
    assert.equal((await request(port, { path: '/v1/feedback', body: report })).status, 204)
    assert.equal((await request(port, { path: '/v1/feedback', body: report })).status, 204)
    assert.equal((await request(port, { path: '/v1/feedback', body: { ...report, message: 'other' } })).status, 409)
    assert.equal(await count(admin, 'feedback_reports'), 1)
  })
})

test('partial uploads and disconnects do not disturb concurrent requests', { skip }, async () => {
  await withStack({}, async ({ port, app, admin }) => {
    const partials = [1, 2, 3].map(() => rawRequest(port,
      `POST /v1/events HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\nContent-Length: 4000\r\n\r\n{"events":[{"event_id":"`, { timeoutMs: 100 }))
    const complete = await Promise.all(Array.from({ length: 5 }, () => request(port, { body: { events: [wireEvent()] } })))
    assert.deepEqual(complete.map(response => response.status), [204, 204, 204, 204, 204])
    await Promise.all(partials)
    await waitFor(() => app.active === 0)
    assert.equal(await count(admin, 'proof_steps'), 5)
    assert.equal(app.gates.events.active, 0)
    assert.equal((await request(port, { method: 'GET', path: '/readyz' })).status, 200)
  })
})

test('an idle connection terminated by the server does not crash the process; readiness recovers', { skip }, async () => {
  await withStack({}, async ({ port, admin, fixture, health }) => {
    assert.equal((await request(port, { body: { events: [wireEvent()] } })).status, 204)
    assert.ok(fixture.database.pool.idleCount >= 1)
    const terminated = await admin.query(`
      SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND usename = 'telemetry_writer'`)
    assert.ok(terminated.rows[0].n >= 1)
    await waitFor(() => fixture.metrics.dbErrors.get({ class: 'idle_client' }) >= 1, { message: 'idle client error' })
    await health.settled()
    await waitFor(async () => (await request(port, { method: 'GET', path: '/readyz' })).status === 200, { message: 'ready again' })
    assert.equal((await request(port, { body: { events: [wireEvent()] } })).status, 204)
    assert.equal(await count(admin, 'proof_steps'), 2)
  })
})

test('a stalled database yields prompt 503 responses with Retry-After, then recovers', { skip }, async () => {
  await withStack({}, async ({ port, admin, app }) => {
    const holder = await admin.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('LOCK TABLE proof_attempts IN ACCESS EXCLUSIVE MODE')
      const started = Date.now()
      const responses = await Promise.all(Array.from({ length: 6 }, () => request(port, { body: { events: [wireEvent()] } })))
      const elapsed = Date.now() - started
      assert.deepEqual(responses.map(response => response.status), [503, 503, 503, 503, 503, 503])
      for (const response of responses) {
        assert.ok(Number(response.headers['retry-after']) >= 1)
        assert.equal(response.headers['access-control-expose-headers'], 'Retry-After')
        assert.ok(['db_unavailable', 'queue_full', 'queue_timeout'].includes(response.json.error), response.json.error)
      }
      assert.ok(elapsed < 5000, `answered within ${elapsed} ms`)
      assert.equal(app.metrics.events.get({ outcome: 'accepted' }), 0)
      // Overload and lock waits do not make the collector unready.
      assert.equal((await request(port, { method: 'GET', path: '/readyz' })).status, 200)
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      holder.release()
    }
    assert.equal((await request(port, { body: { events: [wireEvent()] } })).status, 204)
    assert.equal(await count(admin, 'proof_steps'), 1)
  })
})

test('the lock deadline cancels the waiting statement in PostgreSQL, not only in JavaScript', { skip }, async () => {
  await withStack({ env: { LOCK_TIMEOUT_MS: '300', STATEMENT_TIMEOUT_MS: '300', QUERY_TIMEOUT_MS: '2300' } }, async ({ port, admin }) => {
    const holder = await admin.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('LOCK TABLE proof_attempts IN ACCESS EXCLUSIVE MODE')
      const response = await request(port, { body: { events: [wireEvent()] } })
      assert.equal(response.status, 503)
      const waiting = await admin.query(`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND usename = 'telemetry_writer' AND wait_event_type = 'Lock'`)
      assert.equal(waiting.rows[0].n, 0, 'no writer backend is left waiting on the lock')
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      holder.release()
    }
  })
})

test('a disconnect during the write leaves the event retryable, never duplicated', { skip }, async () => {
  await withStack({}, async ({ port, admin, app }) => {
    const holder = await admin.connect()
    const event = wireEvent()
    try {
      await holder.query('BEGIN')
      await holder.query('LOCK TABLE proof_attempts IN ACCESS EXCLUSIVE MODE')
      const body = JSON.stringify({ events: [event] })
      await rawRequest(port, `POST /v2/events HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
        { timeoutMs: 100 })
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      holder.release()
    }
    await waitFor(() => app.active === 0 && app.queues.events.idle)
    const retry = await request(port, { path: '/v2/events', body: { events: [event] } })
    assert.ok(['accepted', 'duplicate'].includes(retry.json.results[0].status))
    assert.equal(await count(admin, 'proof_steps'), 1)
  })
})

test('a disconnect after commit loses only the response: the retry is a duplicate', { skip }, async () => {
  await withStack({}, async ({ port, admin, app }) => {
    const event = wireEvent()
    const body = JSON.stringify({ events: [event] })
    const lost = await rawRequest(port, `POST /v2/events HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
      { timeoutMs: 2000 })
    assert.equal(lost.status, 200)
    await waitFor(() => app.active === 0)
    const retry = await request(port, { path: '/v2/events', body: { events: [event] } })
    assert.equal(retry.json.results[0].status, 'duplicate')
    assert.equal(await count(admin, 'proof_steps'), 1)
  })
})

test('the runtime role in use cannot change the schema', { skip }, async () => {
  await withStack({}, async ({ fixture }) => {
    const client = new pg.Client({ connectionString: fixture.db.url('telemetry_writer') })
    await client.connect()
    try {
      await assert.rejects(client.query('DROP TABLE proof_steps'), error => error.code === '42501' || /must be owner/u.test(error.message))
      await assert.rejects(client.query('CREATE ROLE intruder SUPERUSER'), error => error.code === '42501')
    } finally {
      await client.end()
    }
  })
})
