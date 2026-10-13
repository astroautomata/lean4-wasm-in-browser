/** Liveness and cached readiness (docs/design.md section 9).
 *
 * Liveness does no I/O. Readiness combines schema compatibility, a recent
 * successful database round trip, draining and the disk watermark. The
 * database check is cached and coalesced: a committed write transaction counts
 * as a successful check, so probes only touch the pool when the collector is
 * otherwise idle, and never more often than every `intervalMs`. Overload is
 * reported but does not make the collector unready: a busy collector should
 * keep receiving traffic and answer 503 itself. */

const PROBE_WAIT_MS = 1000

export function createHealth({ intervalMs = 5000, maxAgeMs = 15000, check, metrics = null, now = () => Date.now() }) {
  let schema = 'unknown'
  let lastSuccess = null
  // Ordered by events, not timestamps: a failure and a success can share a millisecond.
  let failed = false
  let lastStarted = null
  let running = null
  let timer = null

  function succeeded() {
    lastSuccess = now()
    failed = false
  }

  function database() {
    if (failed) return 'error'
    if (lastSuccess === null || now() - lastSuccess > maxAgeMs) return 'stale'
    return 'ok'
  }

  function due() {
    const latest = Math.max(lastSuccess ?? -Infinity, lastStarted ?? -Infinity)
    return database() !== 'ok' || now() - latest >= intervalMs
  }

  /** One database check at a time; concurrent callers share it. */
  function runCheck() {
    if (running) return running
    lastStarted = now()
    running = (async () => {
      try {
        await check()
        succeeded()
      } catch {
        failed = true
      } finally {
        running = null
      }
    })()
    return running
  }

  return {
    get schema() {
      return schema
    },
    setSchema(state) {
      schema = state
    },
    database,
    recordSuccess: succeeded,
    /** A connection was lost: unready until a fresh check succeeds, which starts now. */
    recordFailure() {
      failed = true
      void runCheck()
    },
    /** `{ ready, body }` for /readyz. Waits briefly for a due check. */
    async readiness({ draining = false, disk = 'ok', overload = {} } = {}) {
      if (due()) await Promise.race([runCheck(), new Promise(resolve => setTimeout(resolve, PROBE_WAIT_MS))])
      const databaseState = database()
      const ready = schema === 'compatible' && databaseState === 'ok' && !draining && disk !== 'pause'
      metrics?.ready.set(ready ? 1 : 0)
      return {
        ready,
        body: { status: ready ? 'ready' : 'unready', database: databaseState, schema, draining, disk, overload },
      }
    },
    start() {
      if (timer) return
      timer = setInterval(() => {
        if (due()) void runCheck()
      }, intervalMs)
      timer.unref()
    },
    stop() {
      clearInterval(timer)
      timer = null
    },
    /** For tests: settle any running check. */
    settled() {
      return running ?? Promise.resolve()
    },
  }
}
