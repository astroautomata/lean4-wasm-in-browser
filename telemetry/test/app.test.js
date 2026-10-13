import assert from 'node:assert/strict'
import test from 'node:test'
import { createHealth } from '../src/health.js'
import {
  deferred, ORIGIN, rawRequest, request, startApp, testConfig, uuid, waitFor, wireEvent, wireFeedback,
} from './helpers/http.js'

/** A writer that records calls; `block` holds every write until resolved. */
function fakeWriter({ outcome = () => ({ status: 'accepted' }), block = null, fail = null, feedback = 'accepted' } = {}) {
  const writer = {
    calls: [],
    feedback: [],
    signals: [],
    async writeEvents(events, { signal } = {}) {
      writer.calls.push(events)
      writer.signals.push(signal)
      if (block) await block.promise
      if (fail) throw fail
      return events.map(outcome)
    },
    async storeFeedback(report) {
      writer.feedback.push(report)
      return typeof feedback === 'function' ? feedback(report) : feedback
    },
  }
  return writer
}

async function withApp(options, run) {
  const instance = await startApp(options)
  try {
    await run(instance)
  } finally {
    await instance.close()
  }
}

test('serves liveness without I/O and reports readiness', async () => {
  await withApp({ writer: fakeWriter() }, async ({ port }) => {
    for (const path of ['/healthz', '/livez']) {
      const response = await request(port, { method: 'GET', path, origin: null })
      assert.equal(response.status, 200)
      assert.deepEqual(response.json, { status: 'ok' })
    }
    const ready = await request(port, { method: 'GET', path: '/readyz', origin: null })
    assert.equal(ready.status, 200)
    assert.equal(ready.json.status, 'ready')
    assert.deepEqual(ready.json.overload, { inflight: 0, queued: 0 })
    assert.equal((await request(port, { method: 'HEAD', path: '/livez', origin: null })).status, 200)
  })
})

test('answers malformed request targets without crashing (regression)', async () => {
  await withApp({ writer: fakeWriter() }, async ({ port }) => {
    const target = path => rawRequest(port, `GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)
    assert.equal((await target('//')).status, 400)
    assert.equal((await target('//evil.example/v1/events')).status, 400)
    assert.equal((await target('/%zz')).status, 404)
    assert.equal((await target('/%')).status, 404)
    assert.equal((await target('/v1/events/../healthz')).status, 404)
    assert.equal((await target('http://collector.test/livez')).status, 200)
    assert.equal((await rawRequest(port, 'OPTIONS * HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')).status, 400)
    assert.equal((await rawRequest(port, 'GARBAGE\r\n\r\n')).status, 400)
    assert.equal((await rawRequest(port, 'GET /livez HTTP/1.1\r\nHost: x\r\nBad Header\r\n\r\n')).status, 400)
    // The process keeps serving.
    assert.equal((await request(port, { method: 'GET', path: '/livez' })).status, 200)
  })
})

test('routes 404, 405 and 403 with bounded error codes and CORS for allowed origins', async () => {
  await withApp({ writer: fakeWriter() }, async ({ port }) => {
    const missing = await request(port, { method: 'GET', path: '/v3/events' })
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.json, { error: 'not_found' })
    assert.equal(missing.headers['access-control-allow-origin'], ORIGIN)

    const wrongMethod = await request(port, { method: 'GET', path: '/v1/events' })
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.headers.allow, 'POST, OPTIONS')
    assert.equal((await request(port, { method: 'POST', path: '/livez' })).status, 405)

    const forbidden = await request(port, { body: { events: [wireEvent()] }, origin: 'https://evil.test' })
    assert.equal(forbidden.status, 403)
    assert.equal(forbidden.headers['access-control-allow-origin'], undefined)
    assert.equal((await request(port, { body: { events: [wireEvent()] }, origin: null })).status, 403)
    assert.equal((await request(port, { path: '/metrics', method: 'GET' })).status, 404, 'metrics are not public')
  })
})

test('answers CORS preflight only for allowed origins and exposes Retry-After', async () => {
  await withApp({ writer: fakeWriter() }, async ({ port }) => {
    for (const path of ['/v1/events', '/v2/events', '/v1/feedback']) {
      const allowed = await request(port, { method: 'OPTIONS', path })
      assert.equal(allowed.status, 204, path)
      assert.equal(allowed.headers['access-control-allow-origin'], ORIGIN)
      assert.equal(allowed.headers['access-control-allow-methods'], 'POST, OPTIONS')
      assert.equal(allowed.headers['access-control-allow-headers'], 'content-type')
      assert.equal(allowed.headers['access-control-expose-headers'], 'Retry-After')
      assert.equal((await request(port, { method: 'OPTIONS', path, origin: 'https://evil.test' })).status, 403)
    }
    const accepted = await request(port, { body: { events: [wireEvent()] } })
    assert.equal(accepted.status, 204)
    assert.equal(accepted.headers['access-control-allow-origin'], ORIGIN)
    assert.equal(accepted.headers['access-control-expose-headers'], 'Retry-After')
    assert.equal(accepted.headers.vary, 'Origin')
  })
})

test('v1 writes the valid events of a partially invalid batch and answers 204', async () => {
  const writer = fakeWriter()
  await withApp({ writer }, async ({ port, app }) => {
    const good = wireEvent()
    const response = await request(port, { body: { events: [{ ...wireEvent(), sequence: -1 }, good, { ...wireEvent(), user_uuid: ['x'] }] } })
    assert.equal(response.status, 204)
    assert.equal(writer.calls.length, 1)
    assert.deepEqual(writer.calls[0].map(event => event.eventId), [good.event_id])

    const none = await request(port, { body: { events: [{ ...wireEvent(), sequence: -1 }] } })
    assert.equal(none.status, 400)
    assert.deepEqual(none.json, { error: 'no_valid_events' })
    assert.equal(writer.calls.length, 1, 'nothing invalid reaches the writer')
    assert.equal(app.metrics.events.get({ outcome: 'received' }), 4)
    assert.equal(app.metrics.events.get({ outcome: 'accepted' }), 1)
    assert.equal(app.metrics.eventsRejected.get({ reason: 'invalid_sequence' }), 2)
    assert.equal(app.metrics.eventsRejected.get({ reason: 'invalid_uuid' }), 1)

    // Duplicates and conflicts still answer 204 to old clients.
    const dupWriter = fakeWriter({ outcome: () => ({ status: 'rejected', reason: 'sequence_conflict' }) })
    await withApp({ writer: dupWriter }, async ({ port: otherPort }) => {
      assert.equal((await request(otherPort, { body: { events: [wireEvent()] } })).status, 204)
    })
  })
})

test('v2 returns one result per event, in order, after the write', async () => {
  const outcomes = [{ status: 'accepted' }, { status: 'duplicate' }, { status: 'rejected', reason: 'id_conflict' }]
  let next = 0
  const writer = fakeWriter({ outcome: () => outcomes[next++] })
  await withApp({ writer }, async ({ port, app }) => {
    const events = [wireEvent(), wireEvent({ event_id: uuid().toUpperCase() }), { ...wireEvent(), event_id: 'nope' },
      wireEvent(), { ...wireEvent(), command: 'x\u0000' }]
    const response = await request(port, { path: '/v2/events', body: { events, client: { health: { queue_events: 7, evicted: 1, bogus: 3 } } } })
    assert.equal(response.status, 200)
    assert.equal(response.headers['access-control-expose-headers'], 'Retry-After')
    assert.deepEqual(response.json, {
      protocol: 2,
      results: [
        { index: 0, event_id: events[0].event_id, status: 'accepted' },
        { index: 1, event_id: events[1].event_id.toLowerCase(), status: 'duplicate' },
        { index: 2, event_id: null, status: 'rejected', reason: 'invalid_uuid' },
        { index: 3, event_id: events[3].event_id, status: 'rejected', reason: 'id_conflict' },
        { index: 4, event_id: events[4].event_id, status: 'rejected', reason: 'invalid_text' },
      ],
    })
    assert.equal(app.metrics.clientHealth.get({ counter: 'queue_events' }), 7)
    assert.equal(app.metrics.clientHealth.get({ counter: 'evicted' }), 1)
    assert.equal(app.metrics.clientHealthReports.get(), 1)

    // v2 with only invalid events needs no database work.
    const invalidOnly = await request(port, { path: '/v2/events', body: { events: [{ bad: true }] } })
    assert.equal(invalidOnly.status, 200)
    assert.deepEqual(invalidOnly.json.results, [{ index: 0, event_id: null, status: 'rejected', reason: 'invalid_uuid' }])
    assert.equal(writer.calls.length, 1)
    assert.equal((await request(port, { path: '/v2/events', body: { events: [] } })).status, 400)
  })
})

test('client health is not counted when the write fails', async () => {
  const writer = fakeWriter({ fail: Object.assign(new Error('gone'), { code: '57P01' }) })
  await withApp({ writer }, async ({ port, app }) => {
    const response = await request(port, { path: '/v2/events', body: { events: [wireEvent()], client: { health: { sent: 5 } } } })
    assert.equal(response.status, 503)
    assert.equal(response.headers['retry-after'], '5')
    assert.deepEqual(response.json, { error: 'db_unavailable' })
    assert.equal(app.metrics.clientHealthReports.get(), 0)
    assert.equal(app.metrics.events.get({ outcome: 'dropped' }), 1)
  })
})

test('classifies malformed bodies and limits', async () => {
  await withApp({ writer: fakeWriter(), env: { MAX_BODY_BYTES: '2048' } }, async ({ port }) => {
    const utf8 = await request(port, { body: Buffer.from([0x7b, 0xc3, 0x28, 0x7d]) })
    assert.deepEqual([utf8.status, utf8.json], [400, { error: 'invalid_utf8' }])
    const json = await request(port, { body: '{"events": [' })
    assert.deepEqual([json.status, json.json], [400, { error: 'invalid_json' }])
    assert.deepEqual((await request(port, { body: { events: 'no' } })).json, { error: 'invalid_envelope' })
    assert.deepEqual((await request(port, { body: { events: new Array(51).fill(wireEvent()) } })).status, 413)
    const declared = await rawRequest(port, `POST /v1/events HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\nContent-Length: 999999\r\n\r\n{`)
    assert.equal(declared.status, 413)
    assert.match(declared.raw, /connection: close/iu)
    // Chunked upload without Content-Length is limited while streaming.
    const chunk = Buffer.alloc(1500, 0x20).toString('latin1')
    const streamed = await rawRequest(port, `POST /v1/events HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\nTransfer-Encoding: chunked\r\n\r\n` +
      `${(1500).toString(16)}\r\n${chunk}\r\n${(1500).toString(16)}\r\n${chunk}\r\n`)
    assert.equal(streamed.status, 413)
  })
})

test('keeps multi-byte characters exact across chunked transfer boundaries', async () => {
  const writer = fakeWriter()
  await withApp({ writer }, async ({ port }) => {
    const command = 'é ∀ n, 🎉 = 漢'
    const payload = Buffer.from(JSON.stringify({ events: [wireEvent({ command })] }), 'utf8')
    const head = `POST /v1/events HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`
    const pieces = [...payload].map(byte => Buffer.concat([Buffer.from('1\r\n'), Buffer.from([byte]), Buffer.from('\r\n')]))
    const response = await rawRequest(port, Buffer.concat([Buffer.from(head), ...pieces, Buffer.from('0\r\n\r\n')]))
    assert.equal(response.status, 204)
    assert.equal(writer.calls[0][0].command, command)
  })
})

test('times out a slow body with 408 and keeps serving others', async () => {
  await withApp({ writer: fakeWriter(), env: { BODY_TIMEOUT_MS: '100' } }, async ({ port }) => {
    const slow = rawRequest(port, `POST /v1/events HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\nContent-Length: 100\r\n\r\n{"ev`)
    assert.equal((await request(port, { body: { events: [wireEvent()] } })).status, 204)
    const response = await slow
    assert.equal(response.status, 408)
    assert.match(response.raw, /"body_timeout"/u)
  })
})

test('limits per IP without sharing a bucket between clients behind the trusted proxy', async () => {
  const env = { TRUSTED_PROXY_CIDRS: '127.0.0.1/32', RATE_IP_REQUESTS_PER_MINUTE: '60', RATE_BURST_SECONDS: '2', RATE_LIMIT_IDLE_MS: '10000' }
  await withApp({ writer: fakeWriter(), env }, async ({ port, app }) => {
    const from = ip => ({ 'x-telemetry-client-ip': ip })
    assert.equal((await request(port, { headers: from('203.0.113.1'), body: { events: [wireEvent()] } })).status, 204)
    assert.equal((await request(port, { headers: from('203.0.113.1'), body: { events: [wireEvent()] } })).status, 204)
    const limited = await request(port, { headers: from('203.0.113.1'), body: { events: [wireEvent()] } })
    assert.equal(limited.status, 429)
    assert.deepEqual(limited.json, { error: 'rate_ip' })
    assert.equal(limited.headers['retry-after'], '1')
    assert.equal(limited.headers['access-control-allow-origin'], ORIGIN)
    assert.equal(limited.headers['access-control-expose-headers'], 'Retry-After')
    // Another client behind the same proxy has its own bucket.
    assert.equal((await request(port, { headers: from('203.0.113.2'), body: { events: [wireEvent()] } })).status, 204)
    // A trusted proxy without the header falls back to its own address and is counted.
    assert.equal((await request(port, { body: { events: [wireEvent()] } })).status, 204)
    assert.equal(app.metrics.identityFallback.get(), 1)
  })
})

test('spoofed forwarding headers from an untrusted peer do not change its bucket', async () => {
  const env = { RATE_IP_REQUESTS_PER_MINUTE: '60', RATE_BURST_SECONDS: '2', RATE_LIMIT_IDLE_MS: '10000' }
  await withApp({ writer: fakeWriter(), env }, async ({ port }) => {
    const statuses = []
    for (let index = 0; index < 4; index++) {
      const response = await request(port, {
        headers: { 'x-telemetry-client-ip': `198.51.100.${index}`, 'x-forwarded-for': `198.51.100.${index}` },
        body: { events: [wireEvent()] },
      })
      statuses.push(response.status)
    }
    assert.deepEqual(statuses, [204, 204, 429, 429])
  })
})

test('a large NAT cohort shares one generous IP budget while per-user and global budgets apply', async () => {
  // Default IP budget (1200/min, 10 s burst); one request of burst per user.
  const env = { RATE_USER_REQUESTS_PER_MINUTE: '6' }
  await withApp({ writer: fakeWriter(), env }, async ({ port }) => {
    // 40 classmates behind one address each send once: all accepted.
    for (let index = 0; index < 40; index++) assert.equal((await request(port, { body: { events: [wireEvent()] } })).status, 204)
    const user = uuid()
    assert.equal((await request(port, { body: { events: [wireEvent({ user_uuid: user })] } })).status, 204)
    const limited = await request(port, { body: { events: [wireEvent({ user_uuid: user })] } })
    assert.deepEqual([limited.status, limited.json], [429, { error: 'rate_user' }])
  })
  await withApp({ writer: fakeWriter(), env: { GLOBAL_EVENTS_PER_SECOND: '3', RATE_BURST_SECONDS: '1', RATE_LIMIT_IDLE_MS: '10000' } }, async ({ port }) => {
    assert.equal((await request(port, { body: { events: [wireEvent(), wireEvent(), wireEvent()] } })).status, 204)
    const limited = await request(port, { body: { events: [wireEvent()] } })
    assert.deepEqual([limited.status, limited.json], [429, { error: 'rate_global' }])
  })
})

test('a full in-flight gate answers 503 before reading the body, and feedback keeps its own allowance', async () => {
  const block = deferred()
  const writer = fakeWriter({ block })
  await withApp({ writer, env: { MAX_INFLIGHT_SUBMISSIONS: '1' } }, async ({ port, app }) => {
    const first = request(port, { body: { events: [wireEvent()] } })
    await waitFor(() => writer.calls.length === 1)
    const refused = await request(port, { body: { events: [wireEvent()] } })
    assert.deepEqual([refused.status, refused.json, refused.headers['retry-after']], [503, { error: 'inflight_full' }, '2'])
    assert.equal(refused.headers['access-control-allow-origin'], ORIGIN)
    // Event overload does not starve feedback.
    assert.equal((await request(port, { path: '/v1/feedback', body: wireFeedback() })).status, 204)
    assert.ok(app.pressure() >= 1)
    block.resolve()
    assert.equal((await first).status, 204)
  })
})

test('a full writer queue answers 503 promptly instead of growing a backlog', async () => {
  const block = deferred()
  const writer = fakeWriter({ block })
  const env = { EVENT_WRITERS: '1', QUEUE_MAX_REQUESTS: '1', QUEUE_MAX_AGE_MS: '5000', REQUEST_TIMEOUT_MS: '10000', BODY_TIMEOUT_MS: '5000' }
  await withApp({ writer, env }, async ({ port, app }) => {
    const running = request(port, { body: { events: [wireEvent()] } })
    await waitFor(() => writer.calls.length === 1)
    const queued = request(port, { body: { events: [wireEvent()] } })
    await waitFor(() => app.queues.events.queuedRequests === 1)
    const started = Date.now()
    const refused = await request(port, { body: { events: [wireEvent()] } })
    assert.deepEqual([refused.status, refused.json], [503, { error: 'queue_full' }])
    assert.ok(Date.now() - started < 1000)
    assert.equal(app.metrics.events.get({ outcome: 'overloaded' }), 0, 'refused before reading the body')
    block.resolve()
    assert.deepEqual([(await running).status, (await queued).status], [204, 204])
  })
})

test('expires queued work after QUEUE_MAX_AGE_MS', async () => {
  const block = deferred()
  const writer = fakeWriter({ block })
  await withApp({ writer, env: { EVENT_WRITERS: '1', QUEUE_MAX_AGE_MS: '50' } }, async ({ port, app }) => {
    const running = request(port, { body: { events: [wireEvent()] } })
    await waitFor(() => writer.calls.length === 1)
    const expired = await request(port, { body: { events: [wireEvent()] } })
    assert.deepEqual([expired.status, expired.json], [503, { error: 'queue_timeout' }])
    assert.equal(app.metrics.events.get({ outcome: 'overloaded' }), 1)
    block.resolve()
    await running
  })
})

test('answers 503 at the request deadline while the write is still running', async () => {
  const block = deferred()
  const writer = fakeWriter({ block })
  await withApp({ writer, env: { REQUEST_TIMEOUT_MS: '300', BODY_TIMEOUT_MS: '200', QUEUE_MAX_AGE_MS: '100',
    POOL_ACQUIRE_TIMEOUT_MS: '100', STATEMENT_TIMEOUT_MS: '200', LOCK_TIMEOUT_MS: '100' } }, async ({ port, app }) => {
    const started = Date.now()
    const response = await request(port, { body: { events: [wireEvent()] } })
    assert.deepEqual([response.status, response.json, response.headers['retry-after']], [503, { error: 'deadline' }, '5'])
    assert.ok(Date.now() - started < 2000)
    assert.equal(writer.signals[0].aborted, true, 'the writer is told to stop at its next statement')
    assert.equal(app.queues.events.running, 1, 'the writer slot stays held until the job settles')
    block.resolve()
    await waitFor(() => app.queues.events.idle)
  })
})

test('guards the response after a client disconnect and keeps serving (regression)', async () => {
  const block = deferred()
  const writer = fakeWriter({ block })
  await withApp({ writer }, async ({ port, app }) => {
    const payload = JSON.stringify({ events: [wireEvent()] })
    const gone = rawRequest(port, `POST /v1/events HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`,
      { timeoutMs: 100 })
    await waitFor(() => writer.calls.length === 1)
    await gone
    await waitFor(() => writer.signals[0].aborted)
    block.resolve()
    await waitFor(() => app.active === 0)
    assert.equal(app.metrics.httpRequests.get({ route: 'v1_events', status: 'none' }), 1)
    assert.equal(app.metrics.requestsRejected.get({ reason: 'aborted' }), 1)
    assert.equal((await request(port, { body: { events: [wireEvent()] } })).status, 204)
  })
})

test('a partial upload followed by a disconnect does not disturb other requests', async () => {
  await withApp({ writer: fakeWriter() }, async ({ port, app }) => {
    const partial = rawRequest(port, `POST /v1/events HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\nContent-Length: 1000\r\n\r\n{"events":[`,
      { timeoutMs: 50 })
    const others = await Promise.all([1, 2, 3].map(() => request(port, { body: { events: [wireEvent()] } })))
    assert.deepEqual(others.map(response => response.status), [204, 204, 204])
    await partial
    await waitFor(() => app.active === 0)
    assert.equal(app.metrics.requestsRejected.get({ reason: 'aborted' }), 1)
    assert.equal(app.gates.events.active, 0)
  })
})

test('an unexpected writer failure is a 500 that echoes nothing; data errors are terminal 400', async () => {
  const logs = []
  const secret = 'rw [my_secret_lemma]'
  await withApp({ writer: fakeWriter({ fail: new TypeError(`cannot read ${secret}`) }), log: message => logs.push(message) }, async ({ port }) => {
    const response = await request(port, { body: { events: [wireEvent({ command: secret })] } })
    assert.deepEqual([response.status, response.json], [500, { error: 'internal' }])
    assert.equal(response.headers['retry-after'], undefined)
    assert.equal(logs.length, 1)
    assert.doesNotMatch(logs[0], /secret/u)
  })
  await withApp({ writer: fakeWriter({ fail: Object.assign(new Error('bad'), { code: '22P05' }) }) }, async ({ port }) => {
    assert.deepEqual((await request(port, { body: { events: [wireEvent()] } })).status, 400)
  })
})

test('stores feedback, distinguishes conflicts, and validates it', async () => {
  const writer = fakeWriter({ feedback: report => (report.message === 'conflict' ? 'conflict' : 'accepted') })
  await withApp({ writer }, async ({ port, app }) => {
    const report = wireFeedback({ user_uuid: uuid() })
    const accepted = await request(port, { path: '/v1/feedback', body: report })
    assert.equal(accepted.status, 204)
    assert.equal(accepted.headers['access-control-allow-origin'], ORIGIN)
    assert.equal(writer.feedback[0].reportId, report.report_id)
    const conflict = await request(port, { path: '/v1/feedback', body: wireFeedback({ message: 'conflict' }) })
    assert.deepEqual([conflict.status, conflict.json], [409, { error: 'feedback_conflict' }])
    const invalid = await request(port, { path: '/v1/feedback', body: wireFeedback({ proof_state: 'x' }) })
    assert.deepEqual([invalid.status, invalid.json], [400, { error: 'invalid_feedback' }])
    assert.equal(app.metrics.feedback.get({ outcome: 'accepted' }), 1)
    assert.equal(app.metrics.feedback.get({ outcome: 'conflict' }), 1)
    assert.equal(app.metrics.feedback.get({ outcome: 'rejected' }), 1)
  })
})

test('feedback has separate modest rate budgets', async () => {
  const env = { RATE_FEEDBACK_IP_PER_MINUTE: '60', RATE_BURST_SECONDS: '2', RATE_LIMIT_IDLE_MS: '10000' }
  await withApp({ writer: fakeWriter(), env }, async ({ port }) => {
    assert.equal((await request(port, { path: '/v1/feedback', body: wireFeedback() })).status, 204)
    assert.equal((await request(port, { path: '/v1/feedback', body: wireFeedback() })).status, 204)
    const limited = await request(port, { path: '/v1/feedback', body: wireFeedback() })
    assert.deepEqual([limited.status, limited.json], [429, { error: 'rate_ip' }])
    // Event submissions from the same address are unaffected.
    assert.equal((await request(port, { body: { events: [wireEvent()] } })).status, 204)
  })
})

test('refuses new submissions with 503 while draining and reports unready', async () => {
  const block = deferred()
  const writer = fakeWriter({ block })
  await withApp({ writer }, async ({ port, app }) => {
    const inflight = request(port, { body: { events: [wireEvent()] } })
    await waitFor(() => writer.calls.length === 1)
    app.startDraining()
    const refused = await request(port, { body: { events: [wireEvent()] } })
    assert.deepEqual([refused.status, refused.json, refused.headers['retry-after']], [503, { error: 'draining' }, '5'])
    assert.equal(refused.headers.connection, 'close')
    const ready = await request(port, { method: 'GET', path: '/readyz' })
    assert.equal(ready.status, 503)
    assert.equal(ready.json.draining, true)
    const drained = app.drained(5000)
    block.resolve()
    assert.equal((await inflight).status, 204, 'accepted work finishes during the drain')
    assert.equal(await drained, true)
    assert.equal(app.pressure(), 1)
  })
})

test('the drain deadline returns false while work is stuck', async () => {
  const block = deferred()
  const writer = fakeWriter({ block })
  await withApp({ writer }, async ({ port, app }) => {
    const inflight = request(port, { body: { events: [wireEvent()] } }).catch(() => null)
    await waitFor(() => writer.calls.length === 1)
    app.startDraining()
    assert.equal(await app.drained(50), false)
    block.resolve()
    await inflight
  })
})

test('a disk pause refuses to acknowledge anything', async () => {
  const disk = { state: { level: 'pause' } }
  const writer = fakeWriter()
  await withApp({ writer, disk }, async ({ port }) => {
    const response = await request(port, { body: { events: [wireEvent()] } })
    assert.deepEqual([response.status, response.json, response.headers['retry-after']], [503, { error: 'disk_pause' }, '300'])
    assert.equal((await request(port, { path: '/v1/feedback', body: wireFeedback() })).status, 503)
    assert.equal(writer.calls.length, 0)
    assert.equal((await request(port, { method: 'GET', path: '/readyz' })).status, 503)
    disk.state.level = 'throttle'
    assert.equal((await request(port, { body: { events: [wireEvent()] } })).status, 204)
    assert.equal((await request(port, { method: 'GET', path: '/readyz' })).json.disk, 'throttle')
  })
})

test('a disk pause reached while a request waits stops it before the write', async () => {
  const disk = { state: { level: 'ok' } }
  const block = deferred()
  const writer = fakeWriter({ block })
  await withApp({ writer, disk, env: { EVENT_WRITERS: '1', QUEUE_MAX_AGE_MS: '5000', REQUEST_TIMEOUT_MS: '10000', BODY_TIMEOUT_MS: '5000' } },
    async ({ port, app }) => {
      const first = request(port, { body: { events: [wireEvent()] } })
      await waitFor(() => writer.calls.length === 1)
      const second = request(port, { body: { events: [wireEvent()] } })
      await waitFor(() => app.queues.events.queuedRequests === 1)
      disk.state.level = 'pause'
      block.resolve()
      assert.equal((await first).status, 204)
      assert.equal((await second).status, 503)
      assert.equal(writer.calls.length, 1)
    })
})

test('reports unready until the schema is compatible and refuses submissions meanwhile', async () => {
  const config = testConfig()
  const health = createHealth({ check: async () => {}, intervalMs: 1000, maxAgeMs: 5000 })
  await withApp({ writer: fakeWriter(), health, config }, async ({ port }) => {
    const unready = await request(port, { method: 'GET', path: '/readyz' })
    assert.equal(unready.status, 503)
    assert.equal(unready.json.schema, 'unknown')
    assert.equal(unready.json.database, 'ok')
    const refused = await request(port, { body: { events: [wireEvent()] } })
    assert.deepEqual([refused.status, refused.json], [503, { error: 'db_unavailable' }])
    health.setSchema('compatible')
    assert.equal((await request(port, { method: 'GET', path: '/readyz' })).status, 200)
    assert.equal((await request(port, { body: { events: [wireEvent()] } })).status, 204)
  })
})

test('serves bounded metrics and pressure on the private handler without client data', async () => {
  const writer = fakeWriter()
  await withApp({ writer }, async ({ port, app }) => {
    const event = wireEvent({ command: 'rw [very_private]' })
    await request(port, { body: { events: [event] } })
    await request(port, { body: { events: [{ ...wireEvent(), sequence: -1 }] } })
    const responses = []
    const fakeResponse = () => {
      const state = { headers: null, body: '', status: null }
      responses.push(state)
      return {
        headersSent: false, writableEnded: false, destroyed: false, socket: { destroyed: false },
        writeHead(status, headers) { state.status = status; state.headers = headers },
        end(body) { state.body = String(body ?? '') },
      }
    }
    await app.metricsHandler({ method: 'GET', url: '/metrics' }, fakeResponse())
    await app.metricsHandler({ method: 'GET', url: '/internal/pressure' }, fakeResponse())
    await app.metricsHandler({ method: 'GET', url: '/other' }, fakeResponse())
    const [metrics, pressure, missing] = responses
    assert.equal(metrics.status, 200)
    assert.match(metrics.body, /telemetry_http_requests_total\{route="v1_events",status="204"\} 1/u)
    assert.match(metrics.body, /telemetry_events_total\{outcome="accepted"\} 1/u)
    assert.match(metrics.body, /telemetry_events_rejected_total\{reason="invalid_sequence"\} 1/u)
    assert.match(metrics.body, /telemetry_rate_limit_keys\{scope="ip_requests"\} 1/u)
    assert.doesNotMatch(metrics.body, /very_private|127\.0\.0\.1|[0-9a-f]{8}-[0-9a-f]{4}-/u)
    assert.deepEqual(JSON.parse(pressure.body), { pressure: 0, draining: false, disk: 'ok', inflight: 0, queued: 0 })
    assert.equal(missing.status, 404)
  })
})
