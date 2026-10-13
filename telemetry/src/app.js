import { STATUS_CODES } from 'node:http'
import { performance } from 'node:perf_hooks'
import { InflightGate, WriterQueue } from './admission.js'
import { createCollectorMetrics } from './collector-metrics.js'
import { createHealth } from './health.js'
import { checkDeclaredLength, parseJsonBody, readBody } from './http/body.js'
import { clientIdentity } from './http/client-identity.js'
import {
  abortErrorFrom, AbortError, describeError, HttpError, OverloadError, RequestAbortedError, RETRY_AFTER, toHttpError,
} from './http/errors.js'
import { corsHeaders, send, SUBMISSION_METHODS } from './http/respond.js'
import { createMicrobatcher } from './microbatch.js'
import { createRateLimits, takeAll } from './rate-limit.js'
import { validateEnvelope, validateEvent, validateFeedback } from './validation.js'

/** The collector's HTTP layer, with every dependency injected so it can be
 * tested without a database (docs/design.md sections 4-9).
 *
 * Each request runs inside one async boundary (handle) that never rejects:
 * URL parsing, routing, body reading, validation and persistence failures all
 * become a classified response, or nothing when the client is gone. Cleanup
 * (in-flight slots, timers, listeners) runs exactly once in `finally`. There
 * is deliberately no process-wide catch-all: a programming error outside a
 * request still crashes the process. */

const ROUTES = new Map([
  ['/v1/events', { name: 'v1_events', kind: 'events', version: 1 }],
  ['/v2/events', { name: 'v2_events', kind: 'events', version: 2 }],
  ['/v1/feedback', { name: 'v1_feedback', kind: 'feedback' }],
  ['/healthz', { name: 'health', kind: 'live' }],
  ['/livez', { name: 'health', kind: 'live' }],
  ['/readyz', { name: 'ready', kind: 'ready' }],
])
const OVERLOAD_WINDOW_MS = 10000
const LOG_INTERVAL_MS = 10000

/** The path of an origin-form or absolute-form request target, or null when
 * it is malformed ('//x', '*', garbage). Only exact paths are routed; nothing
 * is percent-decoded, so '/%zz' is simply an unknown path. */
export function requestPath(url) {
  if (typeof url !== 'string' || url.length === 0) return null
  if (url.startsWith('/')) {
    if (url.startsWith('//')) return null
    const end = url.search(/[?#]/u)
    return end === -1 ? url : url.slice(0, end)
  }
  if (/^https?:\/\//iu.test(url)) {
    try {
      return new URL(url).pathname
    } catch {
      return null
    }
  }
  return null
}

/** Resolve or reject with `promise`, or reject as soon as `signal` aborts.
 * The abandoned work keeps its own resources until it settles. */
function untilAborted(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortErrorFrom(signal))
    if (signal.aborted) {
      onAbort()
      promise.catch(() => {})
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(value => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }, error => {
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
  })
}

function hasBody(request) {
  const length = request.headers['content-length']
  return request.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0')
}

function rateLimitError(result) {
  return new HttpError(429, `rate_${result.limiter.scope}`, { retryAfter: result.retryAfter })
}

/** A logger that writes each distinct message at most once per interval, so a
 * database outage cannot flood the logs. */
function throttledLog(log, now) {
  const last = new Map()
  return message => {
    const time = now()
    if (time - (last.get(message) ?? -Infinity) < LOG_INTERVAL_MS) return
    if (last.size > 1000) last.clear()
    last.set(message, time)
    log(message)
  }
}

/** Stack frames without the message line: locates a bug without echoing data. */
function frames(error) {
  return typeof error?.stack === 'string' ? error.stack.split('\n').filter(line => line.startsWith('    at ')).slice(0, 8).join('\n') : ''
}

/** createApp(deps) → { handle, metricsHandler, startDraining, drained, pressure, overload, ... }
 *   config     loadConfig() result (connection may be null)
 *   writer     { writeEvents(events, { signal }), storeFeedback(feedback, { signal }) }
 *   health     createHealth() result; a permissive one is created when omitted
 *   metrics    createCollectorMetrics() result
 *   disk       { state: { level } } (createDiskMonitor) */
export function createApp({
  config,
  writer,
  health = null,
  metrics = createCollectorMetrics(),
  disk = { state: { level: 'ok' } },
  rateLimits = createRateLimits(config.rate),
  log = message => console.error(message),
  now = () => performance.now(),
}) {
  if (!health) {
    // Without a database dependency (tests), readiness depends on draining and disk only.
    health = createHealth({ check: async () => {}, metrics })
    health.setSchema('compatible')
  }
  const logOnce = throttledLog(log, now)
  const gates = {
    events: new InflightGate(config.maxInflightSubmissions),
    feedback: new InflightGate(config.feedbackInflight),
  }
  const queues = {
    events: new WriterQueue({
      name: 'events', writers: config.eventWriters, maxRequests: config.queueMaxRequests, maxEvents: config.queueMaxEvents,
      maxBytes: config.queueMaxBytes, maxAgeMs: config.queueMaxAgeMs, metrics,
    }),
    feedback: new WriterQueue({
      name: 'feedback', writers: config.feedbackWriters, maxRequests: config.feedbackInflight, maxEvents: config.feedbackInflight,
      maxBytes: config.feedbackInflight * config.maxBodyBytes * config.accountingFactor, maxAgeMs: config.queueMaxAgeMs, metrics,
    }),
  }
  const writeChecked = (events, options) => {
    // The watermark may have been crossed while this request waited.
    if (disk.state.level === 'pause') throw new HttpError(503, 'disk_pause', { retryAfter: RETRY_AFTER.diskPause })
    return writer.writeEvents(events, options)
  }
  const batcher = createMicrobatcher({ ...config.microbatch, queue: queues.events, write: writeChecked, metrics })
  let draining = false
  let active = 0
  let lastOverload = null
  const drainWaiters = []

  metrics.registry.onCollect(() => {
    for (const limiter of Object.values(rateLimits)) metrics.rateLimitKeys.set({ scope: limiter.name }, limiter.size)
    // The cached state only: a scrape never adds a database round trip.
    const ready = health.schema === 'compatible' && health.database() === 'ok' && !draining && disk.state.level !== 'pause'
    metrics.ready.set(ready ? 1 : 0)
  })

  function noteOverload(code) {
    if (['inflight_full', 'queue_full', 'queue_timeout', 'deadline', 'rate_global'].includes(code)) lastOverload = now()
  }

  function overload() {
    return {
      inflight: gates.events.active + gates.feedback.active,
      queued: queues.events.queuedRequests + queues.feedback.queuedRequests,
    }
  }

  /** 0..1 for the compactor: 1 means stop background work now. */
  function pressure() {
    if (draining || disk.state.level === 'pause') return 1
    const recent = lastOverload !== null && now() - lastOverload < OVERLOAD_WINDOW_MS ? 1 : 0
    return Math.max(
      gates.events.active / gates.events.limit,
      gates.feedback.active / gates.feedback.limit,
      queues.events.pressure(),
      queues.feedback.pressure(),
      recent)
  }

  function respond(response, context, status, options = {}) {
    const headers = { ...context.headers, ...options.headers }
    if (draining || context.unreadBody) headers.connection = 'close'
    if (send(response, status, { ...options, headers })) context.status = status
  }

  function fail(response, context, error) {
    if (error instanceof RequestAbortedError || (error instanceof AbortError && error.reason === 'client_gone')) {
      metrics.requestsRejected.inc({ reason: 'aborted' })
      return
    }
    const httpError = toHttpError(error)
    if (httpError.status === 500) {
      logOnce(`telemetry: internal error on ${context.route} (${describeError(error)})\n${frames(error)}`)
    } else if (httpError.code === 'db_unavailable') {
      logOnce(`telemetry: database unavailable (${describeError(httpError.cause ?? error)})`)
    }
    if (httpError.status !== 404 && httpError.status !== 405 && httpError.status !== 409) {
      metrics.requestsRejected.inc({ reason: httpError.code })
    }
    noteOverload(httpError.code)
    const headers = {}
    if (httpError.status === 405) headers.allow = context.allow
    if (httpError.retryAfter != null) headers['retry-after'] = String(Math.max(1, Math.ceil(httpError.retryAfter)))
    respond(response, context, httpError.status, { headers, body: { error: httpError.code } })
  }

  function chargeRequest(route, identity) {
    const charges = route.kind === 'feedback'
      ? [{ limiter: rateLimits.feedbackIp, key: identity.key, cost: 1 }, { limiter: rateLimits.globalFeedback, key: 'global', cost: 1 }]
      : [{ limiter: rateLimits.ipRequests, key: identity.key, cost: 1 }, { limiter: rateLimits.globalRequests, key: 'global', cost: 1 }]
    const result = takeAll(charges)
    if (!result.ok) throw rateLimitError(result)
  }

  async function submission(request, response, context, route) {
    const origin = request.headers.origin
    if (draining) throw new HttpError(503, 'draining', { retryAfter: RETRY_AFTER.draining })
    if (!origin || !config.allowedOrigins.has(origin)) throw new HttpError(403, 'origin')
    if (health.schema !== 'compatible') throw new HttpError(503, 'db_unavailable', { retryAfter: RETRY_AFTER.database })
    const identity = clientIdentity(request, { trustedProxies: config.trustedProxies, header: config.clientIpHeader })
    if (identity.source === 'fallback') metrics.identityFallback.inc()
    if (disk.state.level === 'pause') throw new HttpError(503, 'disk_pause', { retryAfter: RETRY_AFTER.diskPause })
    chargeRequest(route, identity)
    checkDeclaredLength(request, config.maxBodyBytes)
    const kind = route.kind
    const release = gates[kind].tryAcquire()
    if (!release) throw new OverloadError('inflight_full')
    metrics.inflight.inc({ kind })
    context.cleanups.push(() => {
      release()
      metrics.inflight.dec({ kind })
    })
    // Refuse before buffering a body the queue could not take anyway.
    if (!queues[kind].canAdmit()) throw new OverloadError('queue_full')

    const body = await readBody(request, { limit: config.maxBodyBytes, timeoutMs: config.bodyTimeoutMs, signal: context.signal })
    context.unreadBody = false
    const value = parseJsonBody(body)
    const accounted = Math.ceil(body.byteLength * config.accountingFactor)
    if (kind === 'feedback') await feedback(response, context, value, accounted)
    else await events(response, context, route, identity, value, body.byteLength, accounted)
  }

  async function events(response, context, route, identity, value, bodyBytes, accounted) {
    const envelope = validateEnvelope(value, { maxEvents: config.maxEventsPerBatch })
    if (!envelope.ok) throw new HttpError(400, 'invalid_envelope')
    const results = envelope.events.map(validateEvent)
    metrics.events.inc({ outcome: 'received' }, results.length)
    const valid = []
    for (let index = 0; index < results.length; index++) {
      if (results[index].ok) valid.push(index)
      else countRejected(results[index].reason)
    }
    if (route.version === 1 && valid.length === 0) throw new HttpError(400, 'no_valid_events')

    const perUser = new Map()
    for (const index of valid) {
      const user = results[index].event.userId
      perUser.set(user, (perUser.get(user) ?? 0) + 1)
    }
    const limited = takeAll([
      { limiter: rateLimits.ipEvents, key: identity.key, cost: results.length },
      { limiter: rateLimits.globalEvents, key: 'global', cost: results.length },
      { limiter: rateLimits.globalBytes, key: 'global', cost: bodyBytes },
      ...[...perUser].flatMap(([user, count]) => [
        { limiter: rateLimits.userRequests, key: user, cost: 1 },
        { limiter: rateLimits.userEvents, key: user, cost: count },
      ]),
    ])
    if (!limited.ok) {
      metrics.events.inc({ outcome: 'rate_limited' }, valid.length)
      throw rateLimitError(limited)
    }

    let outcomes = []
    if (valid.length > 0) {
      try {
        outcomes = await untilAborted(
          batcher.submit(valid.map(index => results[index].event), { bytes: accounted, signal: context.signal }),
          context.signal)
      } catch (error) {
        const overloaded = error instanceof OverloadError || toHttpError(error).code === 'disk_pause'
        metrics.events.inc({ outcome: overloaded ? 'overloaded' : 'dropped' }, valid.length)
        throw error
      }
    }
    const final = results.map(result => (result.ok ? null : { status: 'rejected', reason: result.reason }))
    valid.forEach((index, position) => {
      final[index] = outcomes[position]
      if (outcomes[position].status === 'rejected') countRejected(outcomes[position].reason)
      else metrics.events.inc({ outcome: outcomes[position].status })
    })
    if (envelope.clientHealth && route.version === 2) {
      metrics.clientHealthReports.inc()
      for (const [counter, amount] of Object.entries(envelope.clientHealth)) metrics.clientHealth.inc({ counter }, amount)
    }
    if (route.version === 1) {
      respond(response, context, 204)
      return
    }
    respond(response, context, 200, {
      body: {
        protocol: 2,
        results: final.map((outcome, index) => ({
          index,
          event_id: results[index].ok ? results[index].event.eventId : results[index].eventId,
          status: outcome.status,
          ...(outcome.status === 'rejected' ? { reason: outcome.reason } : {}),
        })),
      },
    })
  }

  function countRejected(reason) {
    metrics.events.inc({ outcome: 'rejected' })
    metrics.eventsRejected.inc({ reason })
  }

  async function feedback(response, context, value, accounted) {
    const result = validateFeedback(value)
    if (!result.ok) {
      metrics.feedback.inc({ outcome: 'rejected' })
      throw new HttpError(400, 'invalid_feedback')
    }
    if (result.feedback.userId) {
      const limited = rateLimits.feedbackUser.take(result.feedback.userId, 1)
      if (!limited.ok) {
        metrics.feedback.inc({ outcome: 'rate_limited' })
        throw rateLimitError(limited)
      }
    }
    let outcome
    try {
      outcome = await untilAborted(queues.feedback.run(signal => {
        if (disk.state.level === 'pause') throw new HttpError(503, 'disk_pause', { retryAfter: RETRY_AFTER.diskPause })
        return writer.storeFeedback(result.feedback, { signal })
      }, { events: 1, bytes: accounted, signal: context.signal }), context.signal)
    } catch (error) {
      metrics.feedback.inc({ outcome: error instanceof OverloadError ? 'overloaded' : 'dropped' })
      throw error
    }
    metrics.feedback.inc({ outcome })
    if (outcome === 'conflict') throw new HttpError(409, 'feedback_conflict')
    respond(response, context, 204)
  }

  async function dispatch(request, response, context) {
    context.headers = corsHeaders(request.headers.origin, config.allowedOrigins)
    const path = requestPath(request.url)
    if (path === null) throw new HttpError(400, 'invalid_url')
    const route = ROUTES.get(path)
    if (!route) throw new HttpError(404, 'not_found')
    context.route = route.name
    const method = request.method
    if (route.kind === 'live') {
      if (method !== 'GET' && method !== 'HEAD') {
        context.allow = 'GET, HEAD'
        throw new HttpError(405, 'method_not_allowed')
      }
      respond(response, context, 200, { body: { status: 'ok' } })
      return
    }
    if (route.kind === 'ready') {
      if (method !== 'GET' && method !== 'HEAD') {
        context.allow = 'GET, HEAD'
        throw new HttpError(405, 'method_not_allowed')
      }
      const state = await health.readiness({ draining, disk: disk.state.level, overload: overload() })
      respond(response, context, state.ready ? 200 : 503, { body: state.body })
      return
    }
    if (method === 'OPTIONS') {
      context.route = 'preflight'
      const origin = request.headers.origin
      if (!origin || !config.allowedOrigins.has(origin)) throw new HttpError(403, 'origin')
      respond(response, context, 204, { headers: corsHeaders(origin, config.allowedOrigins, { preflight: true }) })
      return
    }
    if (method !== 'POST') {
      context.allow = SUBMISSION_METHODS
      throw new HttpError(405, 'method_not_allowed')
    }
    await submission(request, response, context, route)
  }

  /** The request handler for http.createServer. Never rejects. */
  async function handle(request, response) {
    const stopTimer = metrics.httpDuration.startTimer()
    const controller = new AbortController()
    const context = {
      route: 'other',
      status: null,
      headers: {},
      allow: null,
      signal: controller.signal,
      cleanups: [],
      // A body we never read is discarded by closing the connection.
      unreadBody: hasBody(request),
    }
    active++
    const deadline = setTimeout(() => controller.abort(new AbortError('deadline')), config.requestTimeoutMs)
    const onClose = () => {
      if (!response.writableFinished) controller.abort(new AbortError('client_gone'))
    }
    response.on('close', onClose)
    try {
      await dispatch(request, response, context)
    } catch (error) {
      try {
        fail(response, context, error)
      } catch (failure) {
        // Reporting must not throw out of the request boundary.
        logOnce(`telemetry: failed to answer a request (${describeError(failure)})`)
      }
    } finally {
      clearTimeout(deadline)
      response.off('close', onClose)
      for (const cleanup of context.cleanups.reverse()) cleanup()
      if (context.status === null && !response.writableEnded) {
        // Nothing could be answered (client gone): make sure the socket is released.
        if (!response.headersSent && !response.destroyed) response.destroy()
      }
      metrics.httpRequests.inc({ route: context.route, status: context.status === null ? 'none' : String(context.status) })
      stopTimer({ route: context.route })
      active--
      if (active === 0) for (const resolve of drainWaiters.splice(0)) resolve()
    }
  }

  /** Handler for the private metrics port. */
  async function metricsHandler(request, response) {
    const path = requestPath(request.url)
    if (request.method === 'GET' && path === '/metrics') {
      const text = await metrics.registry.render()
      send(response, 200, { headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }, body: text })
    } else if (request.method === 'GET' && path === '/internal/pressure') {
      send(response, 200, { body: { pressure: pressure(), draining, disk: disk.state.level, ...overload() } })
    } else {
      send(response, 404, { body: { error: 'not_found' } })
    }
  }

  return {
    handle,
    metricsHandler,
    pressure,
    overload,
    health,
    metrics,
    queues,
    gates,
    get draining() {
      return draining
    },
    get active() {
      return active
    },
    startDraining() {
      draining = true
      metrics.draining.set(1)
    },
    /** Resolves true when no request is in progress and no write is queued or
     * running, or false after `timeoutMs`. */
    async drained(timeoutMs) {
      let timer
      const idle = (async () => {
        if (active > 0) await new Promise(resolve => drainWaiters.push(resolve))
        await Promise.all([queues.events.whenIdle(), queues.feedback.whenIdle()])
        return true
      })()
      const timeout = new Promise(resolve => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      })
      try {
        return await Promise.race([idle, timeout])
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/** Node server settings and the malformed-request handler shared by
 * server.js and the tests. */
export function configureServer(server, config, metrics = null) {
  server.headersTimeout = config.headersTimeoutMs
  server.keepAliveTimeout = config.keepAliveTimeoutMs
  // Node's own whole-request backstop, above BODY_TIMEOUT_MS.
  server.requestTimeout = config.requestTimeoutMs
  server.on('clientError', (error, socket) => {
    metrics?.requestsRejected.inc({ reason: 'malformed_request' })
    if (error.code === 'ECONNRESET' || !socket.writable || socket.destroyed) {
      socket.destroy()
      return
    }
    const status = error.code === 'HPE_HEADER_OVERFLOW' ? 431 : error.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? 408 : 400
    socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  })
  return server
}
