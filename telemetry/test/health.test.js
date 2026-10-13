import assert from 'node:assert/strict'
import test from 'node:test'
import { createHealth } from '../src/health.js'

function clock() {
  const state = { time: 1000000 }
  return { now: () => state.time, advance: ms => { state.time += ms } }
}

test('is ready only with a compatible schema, a recent database check, no drain and no disk pause', async () => {
  const time = clock()
  const health = createHealth({ intervalMs: 5000, maxAgeMs: 15000, check: async () => {}, now: time.now })
  let state = await health.readiness()
  assert.equal(state.ready, false)
  assert.equal(state.body.schema, 'unknown')
  assert.equal(state.body.database, 'ok')
  health.setSchema('compatible')
  assert.equal((await health.readiness()).ready, true)
  assert.equal((await health.readiness({ draining: true })).ready, false)
  assert.equal((await health.readiness({ disk: 'pause' })).ready, false)
  state = await health.readiness({ disk: 'throttle', overload: { inflight: 64, queued: 64 } })
  assert.equal(state.ready, true, 'overload and disk throttle are reported, not unready')
  assert.deepEqual(state.body.overload, { inflight: 64, queued: 64 })
  health.setSchema('incompatible')
  assert.equal((await health.readiness()).body.status, 'unready')
})

test('caches and coalesces database checks; recent writes count as checks', async () => {
  const time = clock()
  let checks = 0
  const health = createHealth({ intervalMs: 5000, maxAgeMs: 15000, check: async () => { checks++ }, now: time.now })
  health.setSchema('compatible')
  await Promise.all([health.readiness(), health.readiness(), health.readiness()])
  assert.equal(checks, 1)
  time.advance(4000)
  await health.readiness()
  assert.equal(checks, 1, 'within the interval the cached result is used')
  time.advance(2000)
  health.recordSuccess()
  await health.readiness()
  assert.equal(checks, 1, 'a committed write is as good as a check')
  time.advance(5001)
  await health.readiness()
  assert.equal(checks, 2)
})

test('reports database errors and staleness, and recovers after a lost connection', async () => {
  const time = clock()
  let healthy = false
  const health = createHealth({ intervalMs: 5000, maxAgeMs: 15000, now: time.now, check: async () => {
    if (!healthy) throw new Error('ECONNREFUSED')
  } })
  health.setSchema('compatible')
  assert.equal((await health.readiness()).body.database, 'error')
  healthy = true
  time.advance(1)
  assert.equal((await health.readiness()).body.database, 'ok', 'an unhealthy state is re-checked on every probe')
  health.recordFailure()
  await health.settled()
  assert.equal(health.database(), 'ok', 'a lost idle connection triggers an immediate re-check')
  healthy = false
  health.recordFailure()
  await health.settled()
  assert.equal(health.database(), 'error')
  healthy = true
  time.advance(16000)
  assert.equal((await health.readiness()).ready, true)
})

test('answers within a bounded time when the check hangs', async () => {
  const health = createHealth({ intervalMs: 5000, maxAgeMs: 15000, check: () => new Promise(() => {}) })
  health.setSchema('compatible')
  const started = Date.now()
  const state = await health.readiness()
  assert.ok(Date.now() - started < 2000)
  assert.equal(state.ready, false)
  assert.equal(state.body.database, 'stale')
})
