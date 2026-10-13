import { performance } from 'node:perf_hooks'

/** In-process token buckets with bounded memory.
 *
 * Each limiter keeps its buckets in a Map in least-recently-used order
 * (touching a key moves it to the end). Past `maxKeys` the oldest key is
 * evicted, and keys idle longer than `idleMs` are swept incrementally from the
 * front on every call, so client-chosen keys such as user UUIDs cannot grow
 * memory without bound. An evicted or expired key simply starts again with a
 * full bucket; the global budgets still bound the total.
 *
 * One collector process enforces its own budgets. Multiple collectors or
 * ingresses must share enforcement (documented in docs/protocol.md). */

const SWEEP_PER_CALL = 8

export class TokenBucketLimiter {
  /** `ratePerSecond` tokens refill continuously up to `capacity`. */
  constructor({ name = 'limiter', ratePerSecond, capacity, maxKeys = 100000, idleMs = 600000, now = () => performance.now() }) {
    if (!(ratePerSecond > 0) || !(capacity >= 1)) throw new Error(`${name}: rate and capacity must be positive`)
    this.name = name
    this.ratePerSecond = ratePerSecond
    this.capacity = capacity
    this.maxKeys = maxKeys
    this.idleMs = idleMs
    this.now = now
    this.buckets = new Map()
    this.evictions = 0
  }

  get size() {
    return this.buckets.size
  }

  sweep(now = this.now(), limit = SWEEP_PER_CALL) {
    for (let index = 0; index < limit; index++) {
      const first = this.buckets.entries().next()
      if (first.done || now - first.value[1].touched < this.idleMs) return
      this.buckets.delete(first.value[0])
    }
  }

  /** Tokens available for `key` now (refilled), without consuming. */
  peek(key, now = this.now()) {
    const bucket = this.buckets.get(key)
    if (!bucket) return this.capacity
    return Math.min(this.capacity, bucket.tokens + ((now - bucket.updated) / 1000) * this.ratePerSecond)
  }

  /** A request may cost more than the whole bucket only when misconfigured; it
   * then needs (and drains) a full bucket rather than being refused forever. */
  cost(cost) {
    return Math.min(cost, this.capacity)
  }

  /** Seconds until `cost` tokens are available (0 when available now). */
  wait(key, cost, now = this.now()) {
    const missing = this.cost(cost) - this.peek(key, now)
    return missing <= 0 ? 0 : missing / this.ratePerSecond
  }

  /** Mark `key` as recently used without charging it: a key that keeps being
   * refused must not become the least recently used and be evicted, which
   * would hand it a full bucket. */
  touch(key, now = this.now()) {
    const bucket = this.buckets.get(key)
    if (!bucket) return
    this.buckets.delete(key)
    this.buckets.set(key, { ...bucket, touched: now })
  }

  charge(key, cost, now = this.now()) {
    const tokens = this.peek(key, now) - this.cost(cost)
    this.buckets.delete(key)
    this.buckets.set(key, { tokens, updated: now, touched: now })
    while (this.buckets.size > this.maxKeys) {
      this.buckets.delete(this.buckets.keys().next().value)
      this.evictions++
    }
  }

  /** Charge `cost` if available: `{ ok: true }` or `{ ok: false, retryAfter }`. */
  take(key, cost = 1) {
    return takeAll([{ limiter: this, key, cost }])
  }
}

/** All-or-nothing charge across several buckets: either every bucket has
 * enough tokens and all are charged, or none is. `retryAfter` is the whole
 * seconds until the slowest refusing bucket has enough (at least 1), and
 * `limiter` names that bucket. */
export function takeAll(charges) {
  let worst = null
  const now = new Map()
  for (const charge of charges) {
    if (!(charge.cost > 0)) continue
    const time = charge.limiter.now()
    now.set(charge, time)
    charge.limiter.sweep(time)
    const wait = charge.limiter.wait(charge.key, charge.cost, time)
    if (wait > 0 && (!worst || wait > worst.wait)) worst = { wait, limiter: charge.limiter }
  }
  if (worst) {
    for (const charge of charges) {
      if (charge.cost > 0) charge.limiter.touch(charge.key, now.get(charge))
    }
    return { ok: false, retryAfter: Math.max(1, Math.ceil(worst.wait)), limiter: worst.limiter }
  }
  for (const charge of charges) {
    if (charge.cost > 0) charge.limiter.charge(charge.key, charge.cost, now.get(charge))
  }
  return { ok: true }
}

const GLOBAL_KEY = 'global'

/** A single process-wide bucket. */
export class GlobalBudget extends TokenBucketLimiter {
  constructor(options) {
    super({ ...options, maxKeys: 1, idleMs: Infinity })
  }

  charge(_key, cost, now) {
    super.charge(GLOBAL_KEY, cost, now)
  }

  touch() {}

  peek(_key, now) {
    return super.peek(GLOBAL_KEY, now)
  }

  wait(_key, cost, now) {
    return super.wait(GLOBAL_KEY, cost, now)
  }
}

function perMinute(name, perMinuteRate, burstSeconds, options) {
  const ratePerSecond = perMinuteRate / 60
  return new TokenBucketLimiter({ name, ratePerSecond, capacity: Math.max(1, ratePerSecond * burstSeconds), ...options })
}

function perSecond(name, ratePerSecond, burstSeconds, options) {
  return new GlobalBudget({ name, ratePerSecond, capacity: Math.max(1, ratePerSecond * burstSeconds), ...options })
}

/** Every limiter the collector uses, from loadConfig().rate. Each limiter's
 * `scope` is the bounded label for telemetry_rate_limit_keys and the 429 reason
 * (rate_ip, rate_user or rate_global). */
export function createRateLimits(rate, { now } = {}) {
  const keyed = { maxKeys: rate.maxKeys, idleMs: rate.idleMs, ...(now ? { now } : {}) }
  const global = now ? { now } : {}
  const limits = {
    ipRequests: perMinute('ip_requests', rate.ipRequestsPerMinute, rate.burstSeconds, keyed),
    ipEvents: perMinute('ip_events', rate.ipEventsPerMinute, rate.burstSeconds, keyed),
    userRequests: perMinute('user_requests', rate.userRequestsPerMinute, rate.burstSeconds, keyed),
    userEvents: perMinute('user_events', rate.userEventsPerMinute, rate.burstSeconds, keyed),
    feedbackIp: perMinute('feedback_ip', rate.feedbackIpPerMinute, rate.burstSeconds, keyed),
    feedbackUser: perMinute('feedback_user', rate.feedbackUserPerMinute, rate.burstSeconds, keyed),
    globalRequests: perSecond('global_requests', rate.globalRequestsPerSecond, rate.burstSeconds, global),
    globalEvents: perSecond('global_events', rate.globalEventsPerSecond, rate.burstSeconds, global),
    globalBytes: perSecond('global_bytes', rate.globalBytesPerSecond, rate.burstSeconds, global),
    globalFeedback: perSecond('global_feedback', rate.globalFeedbackPerSecond, rate.burstSeconds, global),
  }
  for (const [name, limiter] of Object.entries(limits)) {
    limiter.scope = name.startsWith('global') ? 'global' : name.startsWith('feedbackUser') || name.startsWith('user') ? 'user' : 'ip'
  }
  return limits
}
