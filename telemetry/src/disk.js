import fs from 'node:fs/promises'

/** Disk watermarks for the filesystem holding PostgreSQL's data.
 *
 * `path` is any directory on that filesystem: in Compose, a small named volume
 * lives in the same Docker data root as the database volume, so statfs() on it
 * reports the database's filesystem without exposing any data files.
 *
 * Levels (provisional thresholds, docs/operations.md):
 *   ok        below alertRatio
 *   alert     >= alertRatio     (default 0.70) metrics/alerts only
 *   throttle  >= throttleRatio  (default 0.80) pause space-consuming background
 *                               work (shadow compaction, backfill, exports)
 *   pause     >= pauseRatio     (default 0.85) stop accepting new detail: the
 *                               collector answers 503 and acknowledges nothing
 * A failed probe reports level 'unknown' and never blocks intake by itself. */

export const DISK_LEVELS = Object.freeze(['ok', 'alert', 'throttle', 'pause', 'unknown'])

export function diskLevel(ratio, { alertRatio = 0.7, throttleRatio = 0.8, pauseRatio = 0.85 } = {}) {
  if (!Number.isFinite(ratio)) return 'unknown'
  if (ratio >= pauseRatio) return 'pause'
  if (ratio >= throttleRatio) return 'throttle'
  if (ratio >= alertRatio) return 'alert'
  return 'ok'
}

export async function probeDisk(path) {
  const stats = await fs.statfs(path)
  const total = stats.blocks * stats.bsize
  // Space available to unprivileged writers; PostgreSQL runs unprivileged.
  const available = stats.bavail * stats.bsize
  return { totalBytes: total, availableBytes: available, ratio: total > 0 ? 1 - available / total : NaN }
}

/** Polls `path` every `intervalMs`. Disabled (always 'ok') when path is null.
 * `onSample` receives every sample for metrics. */
export function createDiskMonitor({ path = null, intervalMs = 15000, thresholds = {}, onSample = () => {}, probe = probeDisk } = {}) {
  let state = { level: path ? 'unknown' : 'ok', ratio: null, totalBytes: null, availableBytes: null, checkedAt: null, error: null }
  let timer = null

  async function check() {
    if (!path) return state
    try {
      const sample = await probe(path)
      state = { ...sample, level: diskLevel(sample.ratio, thresholds), checkedAt: Date.now(), error: null }
    } catch (error) {
      state = { ...state, level: 'unknown', checkedAt: Date.now(), error: error.code ?? 'probe_failed' }
    }
    onSample(state)
    return state
  }

  return {
    enabled: Boolean(path),
    get state() { return state },
    check,
    start() {
      if (!path || timer) return
      void check()
      timer = setInterval(() => void check(), intervalMs)
      timer.unref()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
