import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ConfigError, loadConfig } from '../src/config.js'

const database = { PGHOST: 'postgres', PGUSER: 'telemetry_writer', PGPASSWORD: 'x'.repeat(20) }

test('defaults to the provisional staging values from the plan', () => {
  const config = loadConfig(database)
  assert.equal(config.poolSize, 4)
  assert.equal(config.eventWriters + config.feedbackWriters, 4)
  assert.equal(config.maxInflightSubmissions, 64)
  assert.equal(config.queueMaxRequests, 64)
  assert.equal(config.queueMaxEvents, 1000)
  assert.equal(config.queueMaxBytes, 16 * 1024 * 1024)
  assert.equal(config.queueMaxAgeMs, 500)
  assert.equal(config.poolAcquireTimeoutMs, 500)
  assert.equal(config.bodyTimeoutMs, 10000)
  assert.equal(config.statementTimeoutMs, 3000)
  assert.equal(config.lockTimeoutMs, 500)
  assert.equal(config.idleInTxTimeoutMs, 5000)
  assert.equal(config.queryTimeoutMs, 5000)
  assert.equal(config.requestTimeoutMs, 15000)
  assert.equal(config.maxBodyBytes, 512 * 1024)
  assert.equal(config.microbatch.windowMs, 0)
  assert.equal(config.lateEventMaxAgeDays, null)
  assert.equal(config.disk.probePath, null)
  assert.ok(config.drainTimeoutMs < 30000)
  assert.deepEqual([...config.allowedOrigins], ['https://leangame.autumnofautumn.com'])
  assert.deepEqual(config.connection, { host: 'postgres', port: 5432, database: undefined, user: 'telemetry_writer', password: 'x'.repeat(20) })
  assert.deepEqual(config.warnings, [])
})

test('reads the writer password from a secret file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tlm-config-'))
  try {
    const file = path.join(directory, 'password')
    fs.writeFileSync(file, 'from-a-file-secret\n')
    const config = loadConfig({ PGHOST: 'postgres', PGUSER: 'telemetry_writer', PGPASSWORD_FILE: file })
    assert.equal(config.connection.password, 'from-a-file-secret')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('warns that REQUESTS_PER_MINUTE is deprecated and ignores it', () => {
  const config = loadConfig({ ...database, REQUESTS_PER_MINUTE: '5' })
  assert.equal(config.warnings.length, 1)
  assert.match(config.warnings[0], /REQUESTS_PER_MINUTE is deprecated/u)
  assert.equal(config.rate.ipRequestsPerMinute, 1200)
})

test('parses trusted proxies, origins and the client IP header', () => {
  const config = loadConfig({ ...database, TRUSTED_PROXY_CIDRS: '172.18.0.0/16, fd00::/8,10.0.0.1', ALLOWED_ORIGINS: 'https://a.test,http://localhost:5173',
    CLIENT_IP_HEADER: 'X-Real-Client' })
  assert.equal(config.trustedProxies.length, 3)
  assert.deepEqual([...config.allowedOrigins], ['https://a.test', 'http://localhost:5173'])
  assert.equal(config.clientIpHeader, 'x-real-client')
})

test('rejects invalid values naming the variable', () => {
  const cases = [
    [{ PORT: 'eighty' }, /PORT/u],
    [{ PG_POOL_SIZE: '0' }, /PG_POOL_SIZE/u],
    [{ TRUSTED_PROXY_CIDRS: '10.0.0.0/33' }, /TRUSTED_PROXY_CIDRS/u],
    [{ ALLOWED_ORIGINS: 'https://a.test/' }, /ALLOWED_ORIGINS/u],
    [{ ALLOWED_ORIGINS: '*' }, /ALLOWED_ORIGINS/u],
    [{ CLIENT_IP_HEADER: 'bad header' }, /CLIENT_IP_HEADER/u],
    [{ DISK_PAUSE_RATIO: '1.5' }, /DISK_PAUSE_RATIO/u],
    [{ MICROBATCH_WINDOW_MS: '-1' }, /MICROBATCH_WINDOW_MS/u],
  ]
  for (const [env, pattern] of cases) assert.throws(() => loadConfig({ ...database, ...env }), error => error instanceof ConfigError && pattern.test(error.message))
  assert.throws(() => loadConfig({}), /PGHOST/u)
})

test('validates cross-field constraints', () => {
  const cases = [
    [{ EVENT_WRITERS: '4' }, /EVENT_WRITERS/u],
    [{ BODY_TIMEOUT_MS: '15000' }, /BODY_TIMEOUT_MS/u],
    [{ QUEUE_MAX_AGE_MS: '20000' }, /QUEUE_MAX_AGE_MS/u],
    [{ QUERY_TIMEOUT_MS: '3000' }, /QUERY_TIMEOUT_MS/u],
    [{ LOCK_TIMEOUT_MS: '4000' }, /LOCK_TIMEOUT_MS/u],
    [{ KEEP_ALIVE_TIMEOUT_MS: '70000' }, /HEADERS_TIMEOUT_MS/u],
    [{ MAX_EVENTS_PER_BATCH: '2000', QUEUE_MAX_EVENTS: '1000' }, /MAX_EVENTS_PER_BATCH/u],
    [{ QUEUE_MAX_BYTES: '1000000' }, /QUEUE_MAX_BYTES/u],
    [{ RATE_LIMIT_IDLE_MS: '1000' }, /RATE_LIMIT_IDLE_MS/u],
    [{ DISK_ALERT_RATIO: '0.9' }, /DISK_ALERT_RATIO/u],
    [{ METRICS_PORT: '8080' }, /METRICS_PORT/u],
  ]
  for (const [env, pattern] of cases) assert.throws(() => loadConfig({ ...database, ...env }), pattern, JSON.stringify(env))
})
