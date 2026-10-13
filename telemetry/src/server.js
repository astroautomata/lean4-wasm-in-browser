import http from 'node:http'
import { configureServer, createApp } from './app.js'
import { createCollectorMetrics, recordDisk, sampleProcess } from './collector-metrics.js'
import { loadConfig } from './config.js'
import { createDatabase } from './database.js'
import { createDiskMonitor } from './disk.js'
import { createHealth } from './health.js'
import { describeError } from './http/errors.js'
import { checkSchemaCompatibility } from './migrate.js'
import { createWriter } from './writer.js'

/** Collector entry point (docs/design.md section 9).
 *
 * Listen first so liveness works, then check schema compatibility with the
 * runtime writer role, retrying while the database is unreachable. An
 * incompatible schema exits 1: the collector never migrates; the migration
 * job does (npm run migrate). SIGTERM/SIGINT drain: unready and refusing new
 * submissions, finish accepted work up to DRAIN_TIMEOUT_MS, then close. */

const info = message => console.log(`telemetry: ${message}`)
const warn = message => console.error(`telemetry: ${message}`)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve(server.address().port)
    })
  })
}

async function main() {
  let config
  try {
    config = loadConfig(process.env)
  } catch (error) {
    warn(`configuration error: ${error.message}`)
    process.exitCode = 1
    return
  }
  for (const warning of config.warnings) warn(warning)

  const metrics = createCollectorMetrics()
  const stopSampling = sampleProcess(metrics)
  const database = createDatabase(config, { metrics, log: warn })
  metrics.registry.onCollect(() => database.sample())
  const health = createHealth({
    intervalMs: config.readinessIntervalMs,
    maxAgeMs: config.readinessMaxAgeMs,
    check: () => database.checkReady(),
    metrics,
  })
  database.observe({ success: () => health.recordSuccess(), failure: () => health.recordFailure() })
  const disk = createDiskMonitor({
    path: config.disk.probePath,
    intervalMs: config.disk.intervalMs,
    thresholds: { alertRatio: config.disk.alertRatio, throttleRatio: config.disk.throttleRatio, pauseRatio: config.disk.pauseRatio },
    onSample: state => recordDisk(metrics, state),
  })
  const writer = createWriter({ database, config, metrics })
  const app = createApp({ config, writer, health, metrics, disk, log: warn })

  const server = configureServer(http.createServer({ connectionsCheckingInterval: 1000 }, app.handle), config, metrics)
  const port = await listen(server, config.port, config.host)
  info(`collector listening on :${port}`)
  let metricsServer = null
  if (config.metricsPort > 0) {
    metricsServer = http.createServer(app.metricsHandler)
    const metricsPort = await listen(metricsServer, config.metricsPort, config.metricsHost)
    info(`metrics listening on :${metricsPort}`)
  }
  disk.start()
  health.start()

  let stopping = false
  async function stop(reason, code) {
    if (stopping) return
    stopping = true
    info(`${reason}: draining`)
    app.startDraining()
    health.stop()
    disk.stop()
    server.close()
    server.closeIdleConnections()
    const clean = await app.drained(config.drainTimeoutMs)
    // Whatever is still open loses its connection; those events stay
    // unacknowledged and the clients retry them.
    server.closeAllConnections()
    metricsServer?.close()
    metricsServer?.closeAllConnections()
    await Promise.race([database.close().catch(() => {}), sleep(3000)])
    stopSampling()
    info(clean ? 'drained' : 'drain deadline reached; unfinished requests were left unacknowledged')
    process.exitCode = code
    // Anything left (a stuck connection) must not keep the process alive.
    setTimeout(() => process.exit(code), 1000).unref()
  }

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (stopping) {
        warn(`${signal} again: exiting immediately`)
        process.exit(1)
      }
      void stop(signal, 0)
    })
  }

  let delay = 1000
  while (!stopping) {
    try {
      const result = await checkSchemaCompatibility(database.pool)
      if (result.compatible) {
        health.setSchema('compatible')
        info(`schema compatible${result.newer.length > 0 ? ` (newer migrations present: ${result.newer.join(', ')})` : ''}`)
        return
      }
      health.setSchema('incompatible')
      warn(`database schema is incompatible with this collector; missing: ${result.missing.join(', ') || 'none'}; ` +
        `changed after apply: ${result.mismatched.join(', ') || 'none'}. Run the migration job before this release.`)
      await stop('incompatible schema', 1)
      return
    } catch (error) {
      warn(`schema check failed (${describeError(error)}); retrying in ${delay} ms`)
      await sleep(delay)
      delay = Math.min(delay * 2, 30000)
    }
  }
}

await main()
