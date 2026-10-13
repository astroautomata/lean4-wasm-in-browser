import assert from 'node:assert/strict'
import test from 'node:test'
import { AbortError, WriterQueue } from '../src/admission.js'
import { createMicrobatcher } from '../src/microbatch.js'

const queue = () => new WriterQueue({ writers: 2, maxRequests: 10, maxEvents: 1000, maxBytes: 1e6, maxAgeMs: 1000 })

function recordingWrite({ fail = () => null } = {}) {
  const calls = []
  const write = async events => {
    calls.push(events.map(event => event.id))
    const error = fail(events)
    if (error) throw error
    return events.map(event => ({ status: 'accepted', id: event.id }))
  }
  return { calls, write }
}

test('passes requests straight through when disabled', async () => {
  const { calls, write } = recordingWrite()
  const batcher = createMicrobatcher({ windowMs: 0, queue: queue(), write })
  const [first, second] = await Promise.all([batcher.submit([{ id: 1 }]), batcher.submit([{ id: 2 }])])
  assert.deepEqual(calls, [[1], [2]])
  assert.deepEqual(first.map(outcome => outcome.id), [1])
  assert.deepEqual(second.map(outcome => outcome.id), [2])
})

test('combines concurrent requests within the window and returns each its own outcomes', async () => {
  const { calls, write } = recordingWrite()
  const batcher = createMicrobatcher({ windowMs: 20, maxEvents: 100, queue: queue(), write })
  const results = await Promise.all([batcher.submit([{ id: 1 }, { id: 2 }]), batcher.submit([{ id: 3 }]), batcher.submit([{ id: 4 }])])
  assert.deepEqual(calls, [[1, 2, 3, 4]])
  assert.deepEqual(results.map(outcomes => outcomes.map(outcome => outcome.id)), [[1, 2], [3], [4]])
})

test('flushes early at the event and byte bounds', async () => {
  const { calls, write } = recordingWrite()
  const batcher = createMicrobatcher({ windowMs: 10000, maxEvents: 3, maxBytes: 100, queue: queue(), write })
  await Promise.all([batcher.submit([{ id: 1 }, { id: 2 }]), batcher.submit([{ id: 3 }])])
  assert.deepEqual(calls, [[1, 2, 3]])
  await Promise.all([batcher.submit([{ id: 4 }], { bytes: 60 }), batcher.submit([{ id: 5 }], { bytes: 60 }).then(() => null),
    new Promise(resolve => setTimeout(resolve, 5)).then(() => null)])
    .catch(() => {})
  assert.deepEqual(calls.slice(1, 2), [[4]], 'a member that would exceed the byte bound starts a new group')
})

test('a retryable failure fails every member', async () => {
  const unavailable = Object.assign(new Error('down'), { code: '57P01' })
  const { calls, write } = recordingWrite({ fail: () => unavailable })
  const batcher = createMicrobatcher({ windowMs: 10, queue: queue(), write })
  const results = await Promise.allSettled([batcher.submit([{ id: 1 }]), batcher.submit([{ id: 2 }])])
  assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected'])
  assert.deepEqual(calls, [[1, 2]], 'not retried one by one')
})

test('a non-retryable failure retries each request alone so one cannot poison the others', async () => {
  const { calls, write } = recordingWrite({ fail: events => (events.some(event => event.id === 'bad') ? new TypeError('bug') : null) })
  const batcher = createMicrobatcher({ windowMs: 10, queue: queue(), write })
  const results = await Promise.allSettled([batcher.submit([{ id: 1 }]), batcher.submit([{ id: 'bad' }]), batcher.submit([{ id: 3 }])])
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected', 'fulfilled'])
  assert.deepEqual(calls, [[1, 'bad', 3], [1], ['bad'], [3]])
})

test('a member that aborts before the flush leaves the group', async () => {
  const { calls, write } = recordingWrite()
  const batcher = createMicrobatcher({ windowMs: 30, queue: queue(), write })
  const controller = new AbortController()
  const leaving = batcher.submit([{ id: 1 }], { signal: controller.signal })
  const staying = batcher.submit([{ id: 2 }])
  controller.abort(new AbortError('client_gone'))
  await assert.rejects(leaving, error => error.reason === 'client_gone')
  assert.equal(batcher.pending, 1)
  assert.deepEqual((await staying).map(outcome => outcome.id), [2])
  assert.deepEqual(calls, [[2]])
})
