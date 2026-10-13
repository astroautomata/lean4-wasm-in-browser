import { ConfigError, connection, integer, list, number, string } from './env.js'
import { parseCidr } from './http/client-identity.js'

export { ConfigError }

/** Collector configuration (docs/design.md section 3). Defaults are the
 * provisional staging values from the remediation plan: guardrails to revise
 * from measurements, not capacity claims. */

function origins(env) {
  const values = list(env, 'ALLOWED_ORIGINS', ['https://leangame.autumnofautumn.com'])
  for (const value of values) {
    let parsed
    try {
      parsed = new URL(value)
    } catch {
      throw new ConfigError(`ALLOWED_ORIGINS entry is not an origin: ${value}`)
    }
    if (parsed.origin !== value) throw new ConfigError(`ALLOWED_ORIGINS entries must be exact origins like https://example.org: ${value}`)
  }
  return new Set(values)
}

function trustedProxies(env) {
  return list(env, 'TRUSTED_PROXY_CIDRS').map(value => {
    const cidr = parseCidr(value)
    if (!cidr) throw new ConfigError(`TRUSTED_PROXY_CIDRS entry is not an IP address or CIDR: ${value}`)
    return cidr
  })
}

function headerName(env) {
  const value = string(env, 'CLIENT_IP_HEADER', 'x-telemetry-client-ip').toLowerCase()
  if (!/^[a-z0-9-]{1,64}$/u.test(value)) throw new ConfigError('CLIENT_IP_HEADER must be a header name')
  return value
}

function check(condition, message) {
  if (!condition) throw new ConfigError(message)
}

/** Load and validate the collector configuration. Throws ConfigError naming
 * the offending variable. Deprecation notices are returned in `warnings`. */
export function loadConfig(env = process.env, { requireDatabase = true } = {}) {
  const positive = { min: 1 }
  const statementTimeoutMs = integer(env, 'STATEMENT_TIMEOUT_MS', 3000, positive)
  const config = {
    host: string(env, 'HOST', '0.0.0.0'),
    port: integer(env, 'PORT', 8080, { min: 0, max: 65535 }),
    metricsHost: string(env, 'METRICS_HOST', '0.0.0.0'),
    metricsPort: integer(env, 'METRICS_PORT', 9464, { min: 0, max: 65535 }),
    connection: requireDatabase ? connection(env) : null,
    allowedOrigins: origins(env),
    trustedProxies: trustedProxies(env),
    clientIpHeader: headerName(env),
    maxBodyBytes: integer(env, 'MAX_BODY_BYTES', 524288, { min: 1024, max: 64 * 1024 * 1024 }),
    maxEventsPerBatch: integer(env, 'MAX_EVENTS_PER_BATCH', 50, { min: 1, max: 1000 }),
    bodyTimeoutMs: integer(env, 'BODY_TIMEOUT_MS', 10000, positive),
    requestTimeoutMs: integer(env, 'REQUEST_TIMEOUT_MS', 15000, positive),
    headersTimeoutMs: integer(env, 'HEADERS_TIMEOUT_MS', 65000, positive),
    keepAliveTimeoutMs: integer(env, 'KEEP_ALIVE_TIMEOUT_MS', 60000, positive),
    poolSize: integer(env, 'PG_POOL_SIZE', 4, { min: 2, max: 100 }),
    eventWriters: integer(env, 'EVENT_WRITERS', 3, positive),
    feedbackWriters: integer(env, 'FEEDBACK_WRITERS', 1, positive),
    poolAcquireTimeoutMs: integer(env, 'POOL_ACQUIRE_TIMEOUT_MS', 500, positive),
    statementTimeoutMs,
    lockTimeoutMs: integer(env, 'LOCK_TIMEOUT_MS', 500, positive),
    idleInTxTimeoutMs: integer(env, 'IDLE_IN_TX_TIMEOUT_MS', 5000, positive),
    queryTimeoutMs: integer(env, 'QUERY_TIMEOUT_MS', statementTimeoutMs + 2000, positive),
    maxInflightSubmissions: integer(env, 'MAX_INFLIGHT_SUBMISSIONS', 64, positive),
    feedbackInflight: integer(env, 'FEEDBACK_INFLIGHT', 8, positive),
    queueMaxRequests: integer(env, 'QUEUE_MAX_REQUESTS', 64, positive),
    queueMaxEvents: integer(env, 'QUEUE_MAX_EVENTS', 1000, positive),
    queueMaxBytes: integer(env, 'QUEUE_MAX_BYTES', 16777216, positive),
    queueMaxAgeMs: integer(env, 'QUEUE_MAX_AGE_MS', 500, positive),
    accountingFactor: number(env, 'ACCOUNTING_FACTOR', 3, { min: 1, max: 100 }),
    rate: {
      burstSeconds: number(env, 'RATE_BURST_SECONDS', 10, { min: 0.001, max: 3600 }),
      ipRequestsPerMinute: number(env, 'RATE_IP_REQUESTS_PER_MINUTE', 1200, { min: 0.001 }),
      ipEventsPerMinute: number(env, 'RATE_IP_EVENTS_PER_MINUTE', 12000, { min: 0.001 }),
      userRequestsPerMinute: number(env, 'RATE_USER_REQUESTS_PER_MINUTE', 120, { min: 0.001 }),
      userEventsPerMinute: number(env, 'RATE_USER_EVENTS_PER_MINUTE', 1500, { min: 0.001 }),
      feedbackIpPerMinute: number(env, 'RATE_FEEDBACK_IP_PER_MINUTE', 20, { min: 0.001 }),
      feedbackUserPerMinute: number(env, 'RATE_FEEDBACK_USER_PER_MINUTE', 10, { min: 0.001 }),
      globalRequestsPerSecond: number(env, 'GLOBAL_REQUESTS_PER_SECOND', 500, { min: 0.001 }),
      globalEventsPerSecond: number(env, 'GLOBAL_EVENTS_PER_SECOND', 2500, { min: 0.001 }),
      globalBytesPerSecond: number(env, 'GLOBAL_BYTES_PER_SECOND', 16777216, { min: 1 }),
      globalFeedbackPerSecond: number(env, 'GLOBAL_FEEDBACK_PER_SECOND', 5, { min: 0.001 }),
      maxKeys: integer(env, 'RATE_LIMIT_MAX_KEYS', 100000, { min: 1, max: 10000000 }),
      idleMs: integer(env, 'RATE_LIMIT_IDLE_MS', 600000, positive),
    },
    microbatch: {
      windowMs: integer(env, 'MICROBATCH_WINDOW_MS', 0, { min: 0, max: 1000 }),
      maxEvents: integer(env, 'MICROBATCH_MAX_EVENTS', 200, positive),
      maxBytes: integer(env, 'MICROBATCH_MAX_BYTES', 2097152, positive),
    },
    lastSeenResolutionMs: integer(env, 'LAST_SEEN_RESOLUTION_MS', 0, { min: 0 }),
    lastReceivedResolutionMs: integer(env, 'LAST_RECEIVED_RESOLUTION_MS', 60000, { min: 0 }),
    lateEventMaxAgeDays: number(env, 'LATE_EVENT_MAX_AGE_DAYS', null, { min: 0.001 }),
    disk: {
      probePath: string(env, 'DISK_PROBE_PATH'),
      intervalMs: integer(env, 'DISK_PROBE_INTERVAL_MS', 15000, { min: 100 }),
      alertRatio: number(env, 'DISK_ALERT_RATIO', 0.7, { min: 0, max: 1 }),
      throttleRatio: number(env, 'DISK_THROTTLE_RATIO', 0.8, { min: 0, max: 1 }),
      pauseRatio: number(env, 'DISK_PAUSE_RATIO', 0.85, { min: 0, max: 1 }),
    },
    readinessIntervalMs: integer(env, 'READINESS_INTERVAL_MS', 5000, { min: 100 }),
    readinessMaxAgeMs: integer(env, 'READINESS_MAX_AGE_MS', 15000, { min: 100 }),
    drainTimeoutMs: integer(env, 'DRAIN_TIMEOUT_MS', 20000, { min: 0 }),
    warnings: [],
  }

  check(config.eventWriters + config.feedbackWriters <= config.poolSize,
    'EVENT_WRITERS + FEEDBACK_WRITERS must not exceed PG_POOL_SIZE')
  check(config.bodyTimeoutMs < config.requestTimeoutMs, 'BODY_TIMEOUT_MS must be below REQUEST_TIMEOUT_MS')
  check(config.queueMaxAgeMs < config.requestTimeoutMs, 'QUEUE_MAX_AGE_MS must be below REQUEST_TIMEOUT_MS')
  check(config.poolAcquireTimeoutMs < config.requestTimeoutMs, 'POOL_ACQUIRE_TIMEOUT_MS must be below REQUEST_TIMEOUT_MS')
  check(config.statementTimeoutMs < config.requestTimeoutMs, 'STATEMENT_TIMEOUT_MS must be below REQUEST_TIMEOUT_MS')
  check(config.lockTimeoutMs <= config.statementTimeoutMs, 'LOCK_TIMEOUT_MS must not exceed STATEMENT_TIMEOUT_MS')
  check(config.queryTimeoutMs > config.statementTimeoutMs,
    'QUERY_TIMEOUT_MS must exceed STATEMENT_TIMEOUT_MS so PostgreSQL cancels first')
  check(config.headersTimeoutMs > config.keepAliveTimeoutMs, 'HEADERS_TIMEOUT_MS must exceed KEEP_ALIVE_TIMEOUT_MS')
  check(config.maxEventsPerBatch <= config.queueMaxEvents, 'MAX_EVENTS_PER_BATCH must not exceed QUEUE_MAX_EVENTS')
  check(config.maxBodyBytes * config.accountingFactor <= config.queueMaxBytes,
    'QUEUE_MAX_BYTES must hold at least one maximum body times ACCOUNTING_FACTOR')
  check(config.rate.idleMs >= config.rate.burstSeconds * 1000,
    'RATE_LIMIT_IDLE_MS must be at least RATE_BURST_SECONDS, or expiry would refill buckets early')
  check(config.readinessMaxAgeMs >= config.readinessIntervalMs, 'READINESS_MAX_AGE_MS must be at least READINESS_INTERVAL_MS')
  check(config.disk.alertRatio <= config.disk.throttleRatio && config.disk.throttleRatio <= config.disk.pauseRatio,
    'DISK_ALERT_RATIO <= DISK_THROTTLE_RATIO <= DISK_PAUSE_RATIO is required')
  check(config.port === 0 || config.port !== config.metricsPort, 'PORT and METRICS_PORT must differ')

  if (string(env, 'REQUESTS_PER_MINUTE') !== null) {
    config.warnings.push('REQUESTS_PER_MINUTE is deprecated and ignored; use RATE_IP_REQUESTS_PER_MINUTE, ' +
      'RATE_USER_REQUESTS_PER_MINUTE and the GLOBAL_* budgets (docs/protocol.md)')
  }
  return config
}
