import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { createDiskMonitor } from '../disk.js'
import { boolean, connection, integer, number, oneOf, string } from '../env.js'
import { historicIngestionBound } from '../migrate.js'
import { Registry } from '../metrics.js'
import { createCompactor, DEFAULT_SETTINGS, MODES, observeBacklog } from '../trajectory/compactor.js'

/** The compaction worker process (docs/compaction.md). One worker, its own
 * small pool and the telemetry_compactor role. It pauses building (which
 * temporarily needs extra space and I/O) while the collector reports intake
 * pressure or the disk is at the throttle watermark; replacement, which frees
 * space, continues unless the disk monitor cannot read the disk at all. */

export function loadCompactorConfig(env = process.env) {
  const replaceLimitRaw = string(env, 'COMPACTION_REPLACE_LIMIT')
  return {
    connection: connection(env, 'COMPACTOR_'),
    poolSize: integer(env, 'COMPACTOR_POOL_SIZE', 2, { min: 1, max: 4 }),
    metricsPort: integer(env, 'METRICS_PORT', 9465, { min: 0, max: 65535 }),
    pressureUrl: string(env, 'COMPACTOR_PRESSURE_URL'),
    pressureThreshold: number(env, 'COMPACTOR_PRESSURE_THRESHOLD', 0.5, { min: 0, max: 1 }),
    dutyCycle: number(env, 'COMPACTION_DUTY_CYCLE', 0.25, { min: 0.01, max: 1 }),
    idleSleepMs: integer(env, 'COMPACTION_IDLE_SLEEP_MS', 30000, { min: 100 }),
    observeIntervalMs: integer(env, 'COMPACTION_OBSERVE_INTERVAL_MS', 300000, { min: 1000 }),
    statementTimeoutMs: integer(env, 'COMPACTOR_STATEMENT_TIMEOUT_MS', 30000, { min: 100 }),
    disk: {
      path: string(env, 'DISK_PROBE_PATH'),
      thresholds: {
        alertRatio: number(env, 'DISK_ALERT_RATIO', 0.7, { min: 0, max: 1 }),
        throttleRatio: number(env, 'DISK_THROTTLE_RATIO', 0.8, { min: 0, max: 1 }),
        pauseRatio: number(env, 'DISK_PAUSE_RATIO', 0.85, { min: 0, max: 1 }),
      },
    },
    once: boolean(env, 'COMPACTION_ONCE', false),
    settings: {
      mode: oneOf(env, 'COMPACTION_MODE', MODES, DEFAULT_SETTINGS.mode),
      minAgeSeconds: integer(env, 'COMPACTION_MIN_AGE_SECONDS', DEFAULT_SETTINGS.minAgeSeconds, { min: 0 }),
      inactiveSeconds: integer(env, 'COMPACTION_INACTIVE_SECONDS', DEFAULT_SETTINGS.inactiveSeconds, { min: 0 }),
      activeChunkThreshold: integer(env, 'COMPACTION_ACTIVE_CHUNK_THRESHOLD', DEFAULT_SETTINGS.activeChunkThreshold, { min: 1 }),
      chunkMaxEvents: integer(env, 'COMPACTION_CHUNK_MAX_EVENTS', DEFAULT_SETTINGS.chunkMaxEvents,
        { min: 1, max: DEFAULT_SETTINGS.limits.maxEvents }),
      chunkMaxBytes: integer(env, 'COMPACTION_CHUNK_MAX_BYTES', DEFAULT_SETTINGS.chunkMaxBytes,
        { min: 1024, max: DEFAULT_SETTINGS.limits.maxUncompressedBytes }),
      attemptsPerCycle: integer(env, 'COMPACTION_ATTEMPTS_PER_CYCLE', DEFAULT_SETTINGS.attemptsPerCycle, { min: 1, max: 1000 }),
      replaceDelaySeconds: integer(env, 'COMPACTION_REPLACE_DELAY_SECONDS', DEFAULT_SETTINGS.replaceDelaySeconds, { min: 0 }),
      replaceLimit: replaceLimitRaw === 'unlimited'
        ? Infinity : integer(env, 'COMPACTION_REPLACE_LIMIT', DEFAULT_SETTINGS.replaceLimit, { min: 0 }),
      recoverAfterSeconds: integer(env, 'COMPACTION_RECOVER_AFTER_SECONDS', DEFAULT_SETTINGS.recoverAfterSeconds, { min: 0 }),
    },
  }
}

function compactorMetrics(registry) {
  return {
    chunks: registry.counter('telemetry_compaction_chunks_total', 'Chunks built, published or discarded.', ['event', 'kind']),
    rows: registry.counter('telemetry_compaction_rows_total', 'Step rows chunked or replaced (removed after verification).', ['event']),
    inputBytes: registry.counter('telemetry_compaction_input_bytes_total', 'Command bytes read into chunks.'),
    outputBytes: registry.counter('telemetry_compaction_output_bytes_total', 'Compressed chunk bytes written.'),
    cpuSeconds: registry.counter('telemetry_compaction_cpu_seconds_total', 'CPU time spent encoding and verifying chunks.'),
    verificationFailures: registry.counter('telemetry_compaction_verification_failures_total',
      'Chunks that failed verification, by stage.', ['stage']),
    orphanChunks: registry.gauge('telemetry_compaction_orphan_chunks', 'Stale shadow chunks recovery could not resolve this cycle.'),
    eligibleRows: registry.gauge('telemetry_compaction_eligible_rows', 'Step rows older than the recent-row window and not yet in a chunk.'),
    oldestSeconds: registry.gauge('telemetry_compaction_backlog_oldest_seconds', 'Age of the oldest step row not yet in a chunk.'),
    shadowChunks: registry.gauge('telemetry_compaction_shadow_chunks', 'Chunks built but not yet published.'),
    awaitingReplace: registry.gauge('telemetry_compaction_awaiting_replace_chunks', 'Published chunks whose sources are still live.'),
    cycles: registry.counter('telemetry_compaction_cycles_total', 'Worker cycles by result.', ['result']),
    paused: registry.gauge('telemetry_compaction_paused', 'Whether building is paused, by reason (1 = paused).', ['reason']),
    replaceLimited: registry.gauge('telemetry_compaction_replace_limit_reached', 'The canary replacement limit was reached.'),
    relationBytes: registry.gauge('telemetry_db_relation_bytes', 'Heap, index and TOAST bytes per telemetry table.', ['relation', 'part']),
    deadTuples: registry.gauge('telemetry_db_dead_tuples', 'Dead tuples per telemetry table.', ['relation']),
    autovacuumAge: registry.gauge('telemetry_db_last_autovacuum_age_seconds', 'Seconds since the last (auto)vacuum.', ['relation']),
    walBytes: registry.gauge('telemetry_db_wal_bytes', 'WAL bytes generated since statistics reset (pg_stat_wal).'),
    tempBytes: registry.gauge('telemetry_db_temp_bytes', 'Temporary file bytes since statistics reset (pg_stat_database).'),
    diskRatio: registry.gauge('telemetry_disk_utilization_ratio', 'Used fraction of the database filesystem.'),
    observationErrors: registry.counter('telemetry_compaction_observation_errors_total', 'Failed backlog/database observations.'),
  }
}

const TABLES = ['anonymous_users', 'proof_attempts', 'proof_steps', 'trajectory_chunks', 'feedback_reports']

async function observeDatabase(pool, metrics) {
  const sizes = await pool.query(`
    SELECT c.relname, pg_relation_size(c.oid) AS heap, pg_indexes_size(c.oid) AS indexes,
           COALESCE(pg_total_relation_size(c.reltoastrelid), 0) AS toast
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = ANY($1)`, [TABLES])
  for (const row of sizes.rows) {
    for (const part of ['heap', 'indexes', 'toast']) metrics.relationBytes.set({ relation: row.relname, part }, Number(row[part]))
  }
  const stats = await pool.query(`
    SELECT relname, n_dead_tup,
           extract(epoch FROM now() - GREATEST(last_vacuum, last_autovacuum)) AS vacuum_age
    FROM pg_stat_user_tables WHERE relname = ANY($1)`, [TABLES])
  for (const row of stats.rows) {
    metrics.deadTuples.set({ relation: row.relname }, Number(row.n_dead_tup))
    if (row.vacuum_age !== null) metrics.autovacuumAge.set({ relation: row.relname }, Number(row.vacuum_age))
  }
  const wal = await pool.query('SELECT wal_bytes FROM pg_stat_wal')
  metrics.walBytes.set(Number(wal.rows[0]?.wal_bytes ?? 0))
  const temp = await pool.query('SELECT temp_bytes FROM pg_stat_database WHERE datname = current_database()')
  metrics.tempBytes.set(Number(temp.rows[0]?.temp_bytes ?? 0))
}

async function intakePressure(url) {
  if (!url) return 0
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
    if (!response.ok) return 1
    const body = await response.json()
    return Number.isFinite(body.pressure) ? body.pressure : 1
  } catch {
    // An unreachable collector is treated as busy: compaction is never urgent.
    return 1
  }
}

function sleep(ms, signal) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

function logger(level, message, fields = {}) {
  console[level === 'error' ? 'error' : 'log'](JSON.stringify({ level, message, ...fields }))
}

export async function runCompactor(config, { signal }) {
  const pool = new pg.Pool({
    ...config.connection,
    max: config.poolSize,
    application_name: 'telemetry-compactor',
    statement_timeout: config.statementTimeoutMs,
    connectionTimeoutMillis: 10000,
  })
  pool.on('error', error => logger('error', 'idle database client failed', { code: error.code ?? 'unknown' }))
  const registry = new Registry()
  const metrics = compactorMetrics(registry)
  const disk = createDiskMonitor({
    path: config.disk.path, thresholds: config.disk.thresholds,
    onSample: state => { if (Number.isFinite(state.ratio)) metrics.diskRatio.set(state.ratio) },
  })
  disk.start()

  let server = null
  if (config.metricsPort > 0) {
    server = http.createServer(async (request, response) => {
      if (request.method === 'GET' && request.url === '/metrics') {
        response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
        response.end(await registry.render())
      } else {
        response.writeHead(404).end()
      }
    })
    await new Promise(resolve => server.listen(config.metricsPort, '0.0.0.0', resolve))
  }

  try {
    let historicBound = null
    while (!historicBound && !signal.aborted) {
      try {
        historicBound = await historicIngestionBound(pool)
        if (!historicBound) throw new Error('migration 005 is not applied')
      } catch (error) {
        logger('error', 'waiting for a migrated database', { reason: error.code ?? error.message })
        await sleep(config.idleSleepMs, signal)
      }
    }
    if (signal.aborted) return
    const compactor = createCompactor({ pool, settings: config.settings, metrics, log: logger, historicBound })
    signal.addEventListener('abort', () => compactor.stop(), { once: true })
    logger('info', 'compactor started', { mode: config.settings.mode })

    let lastObservation = 0
    while (!signal.aborted) {
      const started = Date.now()
      const pressure = await intakePressure(config.pressureUrl)
      const diskLevel = disk.state.level
      const reasons = {
        pressure: pressure > config.pressureThreshold,
        disk: diskLevel === 'throttle' || diskLevel === 'pause',
        disk_unknown: disk.enabled && diskLevel === 'unknown',
      }
      for (const [reason, active] of Object.entries(reasons)) metrics.paused.set({ reason }, active ? 1 : 0)
      let result = null
      try {
        result = reasons.disk_unknown
          ? null
          : await compactor.runOnce({ buildPaused: reasons.pressure || reasons.disk })
        metrics.cycles.inc({ result: result ? 'ok' : 'skipped' })
        metrics.replaceLimited.set(result?.replacement?.limited ? 1 : 0)
      } catch (error) {
        metrics.cycles.inc({ result: 'error' })
        logger('error', 'compaction cycle failed', { code: error.code ?? 'unknown', message: error.message })
      }
      if (Date.now() - lastObservation >= config.observeIntervalMs) {
        lastObservation = Date.now()
        try {
          const backlog = await observeBacklog(pool, { historicBound, minAgeSeconds: config.settings.minAgeSeconds })
          metrics.eligibleRows.set(backlog.eligibleRows)
          metrics.oldestSeconds.set(backlog.oldestUncompactedSeconds)
          metrics.shadowChunks.set(backlog.shadowChunks)
          metrics.awaitingReplace.set(backlog.awaitingReplace)
          await observeDatabase(pool, metrics)
        } catch {
          metrics.observationErrors.inc()
        }
      }
      if (config.once) break
      const busy = Date.now() - started
      const idle = !result || (result.build?.chunks === 0 && (result.replacement?.replaced ?? 0) === 0)
      // Duty cycle: rest proportionally to the work just done; rest longer when idle.
      await sleep(idle ? config.idleSleepMs : Math.max(100, busy * (1 / config.dutyCycle - 1)), signal)
    }
  } finally {
    disk.stop()
    if (server) await new Promise(resolve => server.close(resolve))
    await pool.end().catch(() => {})
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let config
  try {
    config = loadCompactorConfig()
  } catch (error) {
    console.error(`invalid compactor configuration: ${error.message}`)
    process.exit(1)
  }
  const controller = new AbortController()
  // Stop at the next safe boundary: every step is a complete transaction, and
  // an interrupted build leaves a shadow chunk that recovery resolves.
  process.once('SIGTERM', () => controller.abort())
  process.once('SIGINT', () => controller.abort())
  runCompactor(config, { signal: controller.signal }).then(
    () => { process.exitCode = 0 },
    error => {
      console.error(`compactor failed: ${error.message}`)
      process.exitCode = 1
    })
}
