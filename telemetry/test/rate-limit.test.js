import assert from 'node:assert/strict'
import test from 'node:test'
import { loadConfig } from '../src/config.js'
import { createRateLimits, GlobalBudget, takeAll, TokenBucketLimiter } from '../src/rate-limit.js'

function clock(start = 0) {
  const state = { time: start }
  return { now: () => state.time, advance: ms => { state.time += ms } }
}

test('refuses past the burst and reports whole seconds until a token refills', () => {
  const time = clock()
  const limiter = new TokenBucketLimiter({ ratePerSecond: 2, capacity: 4, now: time.now })
  for (let index = 0; index < 4; index++) assert.equal(limiter.take('a').ok, true)
  assert.deepEqual(limiter.take('a'), { ok: false, retryAfter: 1, limiter })
  time.advance(499)
  assert.equal(limiter.take('a').ok, false)
  time.advance(1)
  assert.equal(limiter.take('a').ok, true)
  assert.equal(limiter.take('b').ok, true, 'other keys have their own bucket')

  const slow = new TokenBucketLimiter({ ratePerSecond: 0.1, capacity: 1, now: time.now })
  assert.equal(slow.take('a').ok, true)
  assert.equal(slow.take('a').retryAfter, 10)
  time.advance(2500)
  assert.equal(slow.take('a').retryAfter, 8)
})

test('holds at most maxKeys keys, evicting the least recently used', () => {
  const time = clock()
  const limiter = new TokenBucketLimiter({ ratePerSecond: 1, capacity: 1, maxKeys: 3, now: time.now })
  for (const key of ['a', 'b', 'c']) limiter.take(key)
  time.advance(1)
  // A refused key counts as used: evicting it would hand it a full bucket.
  assert.equal(limiter.take('a').ok, false)
  limiter.take('d')
  assert.equal(limiter.size, 3)
  assert.deepEqual([...limiter.buckets.keys()], ['c', 'a', 'd'])
  assert.equal(limiter.evictions, 1)
  assert.equal(limiter.take('a').ok, false, 'the limited key kept its empty bucket')
  // A flood of client-chosen keys cannot grow the map.
  for (let index = 0; index < 10000; index++) limiter.take(`flood-${index}`)
  assert.equal(limiter.size, 3)
})

test('expires idle keys incrementally', () => {
  const time = clock()
  const limiter = new TokenBucketLimiter({ ratePerSecond: 1, capacity: 1, idleMs: 1000, now: time.now })
  for (let index = 0; index < 20; index++) limiter.take(`k${index}`)
  time.advance(1001)
  limiter.take('fresh')
  assert.ok(limiter.size < 21, 'one call sweeps a bounded number of idle keys')
  for (let index = 0; index < 5; index++) limiter.take('fresh')
  assert.equal(limiter.size, 1)
  assert.equal(limiter.peek('k0'), 1, 'an expired key starts again full')
})

test('charges several buckets all or nothing', () => {
  const time = clock()
  const ip = new TokenBucketLimiter({ ratePerSecond: 1, capacity: 10, now: time.now })
  const user = new TokenBucketLimiter({ ratePerSecond: 1, capacity: 3, now: time.now })
  const global = new GlobalBudget({ ratePerSecond: 1, capacity: 100, now: time.now })
  const charge = cost => takeAll([{ limiter: ip, key: 'ip', cost }, { limiter: user, key: 'u', cost }, { limiter: global, key: 'global', cost }])
  assert.equal(charge(3).ok, true)
  const refused = charge(2)
  assert.equal(refused.ok, false)
  assert.equal(refused.limiter, user)
  assert.equal(refused.retryAfter, 2)
  assert.equal(ip.peek('ip'), 7, 'a refused charge takes nothing from the other buckets')
  assert.equal(global.peek(), 97)
})

test('a request costing more than a whole bucket needs a full bucket instead of failing forever', () => {
  const time = clock()
  const limiter = new TokenBucketLimiter({ ratePerSecond: 1, capacity: 5, now: time.now })
  assert.equal(limiter.take('a', 50).ok, true)
  assert.equal(limiter.take('a', 50).retryAfter, 5)
})

test('builds bounded limiters from configuration', () => {
  const config = loadConfig({}, { requireDatabase: false })
  const limits = createRateLimits(config.rate)
  assert.equal(limits.ipRequests.capacity, 200)
  assert.equal(limits.ipRequests.maxKeys, 100000)
  assert.equal(limits.globalRequests.capacity, 5000)
  assert.equal(limits.feedbackUser.capacity, Math.max(1, 10 / 60 * 10))
  assert.equal(limits.ipRequests.scope, 'ip')
  assert.equal(limits.userEvents.scope, 'user')
  assert.equal(limits.feedbackUser.scope, 'user')
  assert.equal(limits.feedbackIp.scope, 'ip')
  assert.equal(limits.globalBytes.scope, 'global')
})
