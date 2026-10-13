import { performance } from 'node:perf_hooks'
import { abortErrorFrom, AbortError, OverloadError } from './http/errors.js'

export { AbortError, OverloadError }

/** Admission control: how much work the collector holds at once.
 *
 * Rate limits bound arrival rates; they do not bound simultaneous slow
 * requests. InflightGate bounds submissions that are uploading or processing,
 * and WriterQueue bounds the work waiting for a database writer by request
 * count, event count, accounted bytes and age. Every bound is checked before
 * work is accepted, so saturation produces a prompt, retryable 503 instead of
 * a growing backlog. */

export class InflightGate {
  constructor(limit) {
    this.limit = limit
    this.active = 0
  }

  /** A release function (idempotent), or null when the gate is full. */
  tryAcquire() {
    if (this.active >= this.limit) return null
    this.active++
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
    }
  }
}

/** A bounded FIFO in front of `writers` concurrent jobs.
 *
 * run(job, { events, bytes, signal }) starts `job(signal)` when a writer is
 * free, or queues it when all four bounds allow. A waiter older than
 * `maxAgeMs` is removed and rejected (queue_timeout); a waiter whose signal
 * aborts is removed and rejected with the abort reason, releasing its
 * reservation. Once started, a job keeps its writer until it settles: the
 * database work it started is bounded by PostgreSQL deadlines, not by the
 * caller giving up. */
export class WriterQueue {
  constructor({ name = 'events', writers, maxRequests, maxEvents, maxBytes, maxAgeMs, metrics = null, now = () => performance.now() }) {
    this.name = name
    this.writers = writers
    this.maxRequests = maxRequests
    this.maxEvents = maxEvents
    this.maxBytes = maxBytes
    this.maxAgeMs = maxAgeMs
    this.metrics = metrics
    this.now = now
    this.running = 0
    this.waiting = []
    this.queuedEvents = 0
    this.queuedBytes = 0
    this.idleWaiters = []
  }

  get queuedRequests() {
    return this.waiting.length
  }

  /** Fraction of the tightest queue bound in use. */
  pressure() {
    return Math.min(1, Math.max(
      this.waiting.length / this.maxRequests,
      this.queuedEvents / this.maxEvents,
      this.queuedBytes / this.maxBytes))
  }

  /** Whether a request of this size could be admitted right now. Used to
   * refuse before buffering a body when the queue is already full. */
  canAdmit(events = 0, bytes = 0) {
    if (this.running < this.writers && this.waiting.length === 0) return true
    return this.waiting.length + 1 <= this.maxRequests &&
      this.queuedEvents + events <= this.maxEvents &&
      this.queuedBytes + bytes <= this.maxBytes
  }

  run(job, { events = 0, bytes = 0, signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortErrorFrom(signal))
    if (this.running < this.writers && this.waiting.length === 0) {
      this.metrics?.writerQueueWait.observe({ queue: this.name }, 0)
      return this.start(job, signal)
    }
    if (!this.canAdmit(events, bytes)) return Promise.reject(new OverloadError('queue_full'))
    return new Promise((resolve, reject) => {
      const waiter = { job, events, bytes, signal, resolve, reject, enqueuedAt: this.now(), timer: null, onAbort: null }
      waiter.timer = setTimeout(() => this.remove(waiter, new OverloadError('queue_timeout')), this.maxAgeMs)
      waiter.onAbort = () => this.remove(waiter, abortErrorFrom(signal))
      signal?.addEventListener('abort', waiter.onAbort, { once: true })
      this.waiting.push(waiter)
      this.queuedEvents += events
      this.queuedBytes += bytes
      this.report()
    })
  }

  start(job, signal) {
    this.running++
    let promise
    try {
      promise = Promise.resolve(job(signal))
    } catch (error) {
      promise = Promise.reject(error)
    }
    return promise.finally(() => {
      this.running--
      this.next()
    })
  }

  /** Remove a waiter (timeout or abort) and release its reservation. */
  remove(waiter, error) {
    const index = this.waiting.indexOf(waiter)
    if (index === -1) return
    this.waiting.splice(index, 1)
    this.release(waiter)
    waiter.reject(error)
    this.notifyIdle()
  }

  release(waiter) {
    clearTimeout(waiter.timer)
    waiter.signal?.removeEventListener('abort', waiter.onAbort)
    this.queuedEvents -= waiter.events
    this.queuedBytes -= waiter.bytes
    this.report()
  }

  next() {
    while (this.running < this.writers && this.waiting.length > 0) {
      const waiter = this.waiting.shift()
      this.release(waiter)
      const waited = this.now() - waiter.enqueuedAt
      if (waited > this.maxAgeMs) {
        waiter.reject(new OverloadError('queue_timeout'))
        continue
      }
      if (waiter.signal?.aborted) {
        waiter.reject(abortErrorFrom(waiter.signal))
        continue
      }
      this.metrics?.writerQueueWait.observe({ queue: this.name }, waited / 1000)
      this.start(waiter.job, waiter.signal).then(waiter.resolve, waiter.reject)
    }
    this.notifyIdle()
  }

  report() {
    if (!this.metrics) return
    this.metrics.writerQueueRequests.set({ queue: this.name }, this.waiting.length)
    this.metrics.writerQueueEvents.set({ queue: this.name }, this.queuedEvents)
    this.metrics.writerQueueBytes.set({ queue: this.name }, this.queuedBytes)
  }

  get idle() {
    return this.running === 0 && this.waiting.length === 0
  }

  notifyIdle() {
    if (!this.idle) return
    const waiters = this.idleWaiters.splice(0)
    for (const resolve of waiters) resolve()
  }

  /** Resolves once nothing runs or waits. */
  whenIdle() {
    if (this.idle) return Promise.resolve()
    return new Promise(resolve => this.idleWaiters.push(resolve))
  }
}
