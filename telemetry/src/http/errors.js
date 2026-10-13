/** Request failures and their HTTP classification (docs/protocol.md).
 *
 * The rule: permanently invalid input is a terminal 4xx; anything that might
 * succeed later (overload, deadlines, an unavailable database) is a 503 with
 * Retry-After; only genuinely unexpected faults are 500. A transaction that
 * failed is never reported as stored, whatever its class. */

/** A failure with a definite response. `code` is from the bounded vocabulary
 * that also labels telemetry_requests_rejected_total; it never echoes input. */
export class HttpError extends Error {
  constructor(status, code, { retryAfter = null, cause } = {}) {
    super(code, cause ? { cause } : undefined)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
  }
}

/** Retryable refusal by admission control (queue_full, queue_timeout, inflight_full, ...). */
export class OverloadError extends HttpError {
  constructor(code, retryAfter = 2) {
    super(503, code, { retryAfter })
    this.name = 'OverloadError'
  }
}

/** Work abandoned before it started or between statements: the client went
 * away (`client_gone`), or the request deadline passed (`deadline`). */
export class AbortError extends Error {
  constructor(reason = 'aborted') {
    super(`aborted: ${reason}`)
    this.name = 'AbortError'
    this.reason = reason
  }
}

/** The request body stream ended without being complete. No response is possible. */
export class RequestAbortedError extends Error {
  constructor() {
    super('request aborted by the client')
    this.name = 'RequestAbortedError'
    this.code = 'aborted'
  }
}

export const RETRY_AFTER = Object.freeze({
  overload: 2,
  database: 5,
  deadline: 5,
  draining: 5,
  diskPause: 300,
})

/** The reason an AbortSignal was aborted, as an AbortError. */
export function abortErrorFrom(signal) {
  const reason = signal?.reason
  if (reason instanceof AbortError) return reason
  return new AbortError(typeof reason === 'string' ? reason : 'aborted')
}

const SOCKET_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED', 'ENETDOWN', 'EHOSTDOWN'])
// node-postgres reports these as plain Errors without a SQLSTATE.
const CONNECTION_MESSAGES = [
  /^Connection terminated/u,
  /not queryable/u,
  /^Client was closed/u,
  /^Cannot use a pool after calling end/u,
  /^Connection timeout/iu,
]

/** A bounded class for one database error, used for metrics, the HTTP status
 * and whether the connection may be reused. Classes:
 *   connection, shutdown   the connection is gone or the server is restarting
 *   pool_timeout           no pool client within POOL_ACQUIRE_TIMEOUT_MS
 *   query_timeout          client-side backstop fired; the server may still run the query
 *   statement_timeout, lock_timeout, idle_in_transaction, deadlock, serialization,
 *   resources              PostgreSQL refused or cancelled the work
 *   race                   a unique/foreign-key race with a concurrent transaction
 *   data                   a value PostgreSQL rejects (22xxx): validation should prevent it
 *   chunk                  a published trajectory chunk needed for a decision is unreadable
 *   other                  anything else */
export function databaseErrorClass(error) {
  if (error?.name === 'ChunkUnavailableError') return 'chunk'
  const code = typeof error?.code === 'string' ? error.code : ''
  const message = typeof error?.message === 'string' ? error.message : ''
  if (/^\d{2}[0-9A-Z]{3}$/u.test(code)) {
    if (code.startsWith('08')) return 'connection'
    if (code === '57P01' || code === '57P02' || code === '57P03') return 'shutdown'
    if (code === '57014') return 'statement_timeout'
    if (code === '55P03') return 'lock_timeout'
    if (code === '25P03' || code === '57P05') return 'idle_in_transaction'
    if (code === '40P01') return 'deadlock'
    if (code === '40001') return 'serialization'
    if (code.startsWith('53')) return 'resources'
    if (code === '23505' || code === '23503') return 'race'
    if (code.startsWith('22')) return 'data'
    return 'other'
  }
  if (SOCKET_ERRORS.has(code)) return 'connection'
  if (message === 'timeout exceeded when trying to connect') return 'pool_timeout'
  if (message === 'Query read timeout') return 'query_timeout'
  if (CONNECTION_MESSAGES.some(pattern => pattern.test(message))) return 'connection'
  return 'other'
}

const RETRYABLE_CLASSES = new Set(['connection', 'shutdown', 'pool_timeout', 'query_timeout', 'statement_timeout',
  'lock_timeout', 'idle_in_transaction', 'deadlock', 'serialization', 'resources'])

/** Classes after which the connection's state is unknown: destroy it rather
 * than return it to the pool. */
export function connectionUnusable(error) {
  const errorClass = databaseErrorClass(error)
  return errorClass === 'connection' || errorClass === 'shutdown' || errorClass === 'query_timeout' ||
    errorClass === 'idle_in_transaction'
}

/** Classes worth one immediate retry of the whole transaction. */
export function transientConflict(error) {
  const errorClass = databaseErrorClass(error)
  return errorClass === 'deadlock' || errorClass === 'serialization' || errorClass === 'race'
}

/** The HttpError that answers `error`. */
export function toHttpError(error) {
  if (error instanceof HttpError) return error
  if (error instanceof AbortError) {
    return new HttpError(503, error.reason === 'draining' ? 'draining' : 'deadline', { retryAfter: RETRY_AFTER.deadline })
  }
  const errorClass = databaseErrorClass(error)
  if (RETRYABLE_CLASSES.has(errorClass)) {
    return new HttpError(503, 'db_unavailable', { retryAfter: RETRY_AFTER.database, cause: error })
  }
  if (errorClass === 'data') return new HttpError(400, 'invalid_event', { cause: error })
  return new HttpError(500, 'internal', { cause: error })
}

/** Log-safe description: SQLSTATE or errno and the class, never the message
 * (PostgreSQL messages can quote submitted values). */
export function describeError(error) {
  const code = typeof error?.code === 'string' ? error.code : 'none'
  return `${error?.name ?? 'Error'} code=${code} class=${databaseErrorClass(error)}`
}
