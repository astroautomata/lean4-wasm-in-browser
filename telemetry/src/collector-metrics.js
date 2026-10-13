import { monitorEventLoopDelay } from 'node:perf_hooks'
import { DISK_LEVELS } from './disk.js'
import { Registry } from './metrics.js'

/** The collector's metrics (docs/design.md section 9). Every label value comes
 * from a fixed vocabulary in this repository: routes, status codes, outcome
 * and reason codes, error classes. Nothing client-chosen becomes a label. */

const BATCH_BUCKETS = [1, 2, 5, 10, 20, 50, 100, 200, 500]
const FAST_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]

export function createCollectorMetrics(registry = new Registry()) {
  const metric = {
    registry,
    httpRequests: registry.counter('telemetry_http_requests_total', 'HTTP requests by route and response status.', ['route', 'status']),
    httpDuration: registry.histogram('telemetry_http_request_duration_seconds', 'Time from request start to response or abandonment.', ['route']),
    events: registry.counter('telemetry_events_total',
      'Events by outcome: received, accepted, duplicate, rejected, rate_limited, overloaded, dropped (admitted but not committed).', ['outcome']),
    eventsRejected: registry.counter('telemetry_events_rejected_total', 'Terminally rejected events by reason code.', ['reason']),
    requestsRejected: registry.counter('telemetry_requests_rejected_total', 'Whole requests refused or abandoned, by reason.', ['reason']),
    feedback: registry.counter('telemetry_feedback_total', 'Feedback reports by outcome.', ['outcome']),
    inflight: registry.gauge('telemetry_inflight_submissions', 'Submissions uploading or processing.', ['kind']),
    writerQueueRequests: registry.gauge('telemetry_writer_queue_requests', 'Requests waiting for a database writer.', ['queue']),
    writerQueueEvents: registry.gauge('telemetry_writer_queue_events', 'Events waiting for a database writer.', ['queue']),
    writerQueueBytes: registry.gauge('telemetry_writer_queue_bytes', 'Accounted bytes waiting for a database writer.', ['queue']),
    writerQueueWait: registry.histogram('telemetry_writer_queue_wait_seconds', 'Time spent waiting for a database writer.', ['queue'],
      { buckets: FAST_BUCKETS }),
    poolAcquire: registry.histogram('telemetry_pool_acquire_seconds', 'Time to acquire a pool connection.', [], { buckets: FAST_BUCKETS }),
    poolClients: registry.gauge('telemetry_pool_clients', 'Pool connections by state (total, idle, waiting).', ['state']),
    dbErrors: registry.counter('telemetry_db_errors_total', 'Database errors by class (SQLSTATE class, never the message).', ['class']),
    dbTransaction: registry.histogram('telemetry_db_transaction_seconds', 'Duration of write transactions.', [], { buckets: FAST_BUCKETS }),
    dbStatements: registry.counter('telemetry_db_statements_total', 'SQL statements sent by the writer, including BEGIN and COMMIT.'),
    batchEvents: registry.histogram('telemetry_batch_events', 'Events per write transaction.', [], { buckets: BATCH_BUCKETS }),
    eventLoopLag: registry.gauge('telemetry_event_loop_lag_seconds', 'Event loop delay since the previous scrape.', ['stat']),
    residentMemory: registry.gauge('telemetry_process_resident_memory_bytes', 'Resident set size.'),
    heapUsed: registry.gauge('telemetry_process_heap_used_bytes', 'V8 heap in use.'),
    diskRatio: registry.gauge('telemetry_disk_utilization_ratio', 'Used fraction of the database filesystem (DISK_PROBE_PATH).'),
    diskLevel: registry.gauge('telemetry_disk_level', '1 for the current disk watermark level.', ['level']),
    draining: registry.gauge('telemetry_draining', '1 while shutting down.'),
    ready: registry.gauge('telemetry_ready', '1 when /readyz reports ready.'),
    rateLimitKeys: registry.gauge('telemetry_rate_limit_keys', 'Keys held per rate limiter.', ['scope']),
    identityFallback: registry.counter('telemetry_client_identity_fallback_total',
      'Requests from a trusted proxy without one valid client IP header.'),
    clientHealth: registry.counter('telemetry_client_health_total', 'Sums of client-reported queue statistics.', ['counter']),
    clientHealthReports: registry.counter('telemetry_client_health_reports_total', 'Committed requests carrying client health.'),
    microbatchRequests: registry.histogram('telemetry_microbatch_requests', 'Requests combined per microbatch transaction.', [],
      { buckets: [1, 2, 4, 8, 16, 32, 64] }),
  }
  metric.draining.set(0)
  metric.ready.set(0)
  for (const level of DISK_LEVELS) metric.diskLevel.set({ level }, 0)
  return metric
}

/** Sampled process gauges, refreshed before each scrape. */
export function sampleProcess(metrics) {
  const delay = monitorEventLoopDelay({ resolution: 20 })
  delay.enable()
  metrics.registry.onCollect(() => {
    const memory = process.memoryUsage()
    metrics.residentMemory.set(memory.rss)
    metrics.heapUsed.set(memory.heapUsed)
    if (delay.count > 0) {
      metrics.eventLoopLag.set({ stat: 'p50' }, delay.percentile(50) / 1e9)
      metrics.eventLoopLag.set({ stat: 'p99' }, delay.percentile(99) / 1e9)
      metrics.eventLoopLag.set({ stat: 'max' }, delay.max / 1e9)
    }
    delay.reset()
  })
  return () => delay.disable()
}

/** Record one disk sample (createDiskMonitor's onSample). */
export function recordDisk(metrics, state) {
  for (const level of DISK_LEVELS) metrics.diskLevel.set({ level }, state.level === level ? 1 : 0)
  if (Number.isFinite(state.ratio)) metrics.diskRatio.set(state.ratio)
}
