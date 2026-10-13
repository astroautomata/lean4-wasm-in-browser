import assert from 'node:assert/strict'
import test from 'node:test'
import { AbortError, InflightGate, OverloadError, WriterQueue } from '../src/admission.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

const bounds = { writers: 1, maxRequests: 2, maxEvents: 10, maxBytes: 1000, maxAgeMs: 10000 }

test('the in-flight gate bounds concurrent submissions and releases once', () => {
  const gate = new InflightGate(2)
  const first = gate.tryAcquire()
  const second = gate.tryAcquire()
  assert.equal(gate.tryAcquire(), null)
  first()
  first()
  assert.equal(gate.active, 1)
  assert.notEqual(gate.tryAcquire(), null)
  second()
})

test('runs immediately while a writer is free and in order afterwards', async () => {
  const queue = new WriterQueue(bounds)
  const blocker = deferred()
  const order = []
  const first = queue.run(async () => { order.push('first'); await blocker.promise; return 1 })
  const second = queue.run(async () => { order.push('second'); return 2 }, { events: 1, bytes: 10 })
  assert.equal(queue.queuedRequests, 1)
  assert.deepEqual(order, ['first'])
  blocker.resolve()
  assert.deepEqual(await Promise.all([first, second]), [1, 2])
  assert.deepEqual(order, ['first', 'second'])
  assert.equal(queue.idle, true)
  assert.equal(queue.queuedEvents, 0)
  assert.equal(queue.queuedBytes, 0)
})

test('enforces the request, event and byte bounds at enqueue', async () => {
  for (const [name, waiting, extra] of [
    ['requests', [{ events: 1, bytes: 1 }, { events: 1, bytes: 1 }], { events: 1, bytes: 1 }],
    ['events', [{ events: 8, bytes: 1 }], { events: 3, bytes: 1 }],
    ['bytes', [{ events: 1, bytes: 900 }], { events: 1, bytes: 101 }],
  ]) {
    const queue = new WriterQueue(bounds)
    const blocker = deferred()
    const running = queue.run(() => blocker.promise)
    const queued = waiting.map(size => queue.run(async () => 'ok', size))
    await assert.rejects(queue.run(async () => 'no', extra), error => error instanceof OverloadError && error.code === 'queue_full', name)
    assert.equal(queue.canAdmit(extra.events, extra.bytes), false)
    blocker.resolve()
    await running
    await Promise.all(queued)
  }
})

test('expires waiters older than maxAgeMs and releases their reservation', async () => {
  const queue = new WriterQueue({ ...bounds, maxAgeMs: 30 })
  const blocker = deferred()
  const running = queue.run(() => blocker.promise)
  const started = Date.now()
  await assert.rejects(queue.run(async () => 'late', { events: 5, bytes: 500 }),
    error => error instanceof OverloadError && error.code === 'queue_timeout' && error.status === 503 && error.retryAfter > 0)
  assert.ok(Date.now() - started < 1000)
  assert.equal(queue.queuedEvents, 0)
  assert.equal(queue.queuedBytes, 0)
  assert.equal(queue.queuedRequests, 0)
  blocker.resolve()
  await running
})

test('an abort before the job starts removes it and releases everything', async () => {
  const queue = new WriterQueue(bounds)
  const blocker = deferred()
  const running = queue.run(() => blocker.promise)
  const controller = new AbortController()
  let ran = false
  const waiting = queue.run(async () => { ran = true }, { events: 4, bytes: 400, signal: controller.signal })
  assert.equal(queue.queuedEvents, 4)
  controller.abort(new AbortError('client_gone'))
  await assert.rejects(waiting, error => error instanceof AbortError && error.reason === 'client_gone')
  assert.equal(queue.queuedEvents, 0)
  assert.equal(queue.queuedBytes, 0)
  assert.equal(queue.queuedRequests, 0)
  blocker.resolve()
  await running
  assert.equal(ran, false)

  const already = new AbortController()
  already.abort(new AbortError('deadline'))
  await assert.rejects(queue.run(async () => {}, { signal: already.signal }), error => error.reason === 'deadline')
})

test('passes the signal to a started job and keeps the writer until the job settles', async () => {
  const queue = new WriterQueue(bounds)
  const controller = new AbortController()
  const blocker = deferred()
  let seen = null
  const job = queue.run(async signal => {
    seen = signal
    await blocker.promise
    return 'done'
  }, { signal: controller.signal })
  controller.abort(new AbortError('client_gone'))
  assert.equal(seen, controller.signal)
  assert.equal(queue.running, 1)
  blocker.resolve()
  assert.equal(await job, 'done')
  assert.equal(queue.running, 0)
})

test('a failing job frees its writer and whenIdle resolves after all work', async () => {
  const queue = new WriterQueue(bounds)
  await assert.rejects(queue.run(async () => { throw new Error('boom') }), /boom/u)
  assert.equal(queue.running, 0)
  assert.throws(() => { throw new Error('sync') })
  await assert.rejects(queue.run(() => { throw new Error('sync') }), /sync/u)
  const blocker = deferred()
  const running = queue.run(() => blocker.promise)
  let idle = false
  const whenIdle = queue.whenIdle().then(() => { idle = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(idle, false)
  blocker.resolve()
  await running
  await whenIdle
  assert.equal(idle, true)
})

test('reports pressure by its tightest bound', async () => {
  const queue = new WriterQueue(bounds)
  assert.equal(queue.pressure(), 0)
  const blocker = deferred()
  const running = queue.run(() => blocker.promise)
  const waiting = queue.run(async () => {}, { events: 9, bytes: 1 })
  assert.equal(queue.pressure(), 0.9)
  blocker.resolve()
  await Promise.all([running, waiting])
})
