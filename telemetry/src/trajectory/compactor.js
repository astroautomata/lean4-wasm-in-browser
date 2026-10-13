import {
  decodeChunk, DEFAULT_LIMITS, encodeChunk, microsFromSql, sameAction, sqlFromMicros, sqlMicros, TrajectoryFormatError,
} from './codec.js'
import { chunkManifest } from './reader.js'

/** Trajectory compaction (docs/compaction.md, docs/design.md section 10).
 *
 * Moves completed or inactive attempts' step rows into immutable, verified,
 * lossless chunks without ever leaving fewer than one readable copy:
 *
 *   build    read a bounded, ordered set of eligible live rows; encode outside
 *            any transaction; insert as 'shadow'; read the stored chunk back,
 *            decode it and compare every field with the sources
 *   publish  one short transaction under the attempt lock: re-read the exact
 *            sources and require them unchanged, require no overlap, mark the
 *            chunk 'published' and advance compacted_through
 *   replace  (mode 'replace' only, after a delay, canary-bounded) one short
 *            transaction under the attempt lock: re-read the sources, require
 *            exact equality with the decoded chunk, delete exactly those rows
 *   recover  shadow chunks a crash left behind are verified and published, or
 *            deleted when their sources no longer match
 *
 * The attempt lock (FOR NO KEY UPDATE on proof_attempts) conflicts with the
 * collector writer's FOR UPDATE, so a writer deciding a retried step always
 * sees either the live row or the published chunk, never neither. */

export const MODES = Object.freeze(['off', 'shadow', 'replace'])

export const DEFAULT_SETTINGS = Object.freeze({
  mode: 'shadow',
  minAgeSeconds: 86400,
  inactiveSeconds: 3600,
  activeChunkThreshold: 2000,
  chunkMaxEvents: 1000,
  chunkMaxBytes: 1024 * 1024,
  attemptsPerCycle: 20,
  replaceDelaySeconds: 86400,
  replaceLimit: 100,
  recoverAfterSeconds: 3600,
  limits: DEFAULT_LIMITS,
})

// Rows not yet in any chunk (shadow chunks included, so in-progress work is not
// chunked twice). receipt_event_ids holds the ids of a chunk's rows until a
// retention policy clears it, which it only does after the rows were removed.
const SOURCE_COLUMNS = `s.event_id::text, s.sequence, ${sqlMicros('s.client_ts')} AS client_ts_us, s.elapsed_ms,
  s.step_type::text, s.command, s.from_line, s.removed_lines, s.attributes, ${sqlMicros('s.received_at')} AS received_at_us`

const ELIGIBLE_ROWS_SQL = `
  SELECT ${SOURCE_COLUMNS}
  FROM proof_steps s
  WHERE s.attempt_id = $1
    AND COALESCE(s.received_at, $2::timestamptz) < now() - $3 * interval '1 second'
    AND NOT EXISTS (SELECT 1 FROM trajectory_chunks c
                    WHERE c.attempt_id = s.attempt_id AND s.event_id = ANY(c.receipt_event_ids))
  ORDER BY s.sequence
  LIMIT $4`

// Sweep attempts in primary-key order, resuming after `$1`; candidate filter is
// cheap and index-friendly, the per-attempt query above decides precisely.
const CANDIDATES_SQL = `
  SELECT a.attempt_id::text, a.completed,
         COALESCE(a.last_received_at, a.received_at, $2::timestamptz) < now() - $3 * interval '1 second' AS inactive,
         a.detail_expired_at IS NOT NULL AS detail_expired
  FROM proof_attempts a
  WHERE a.attempt_id > $1::uuid
    AND EXISTS (SELECT 1 FROM proof_steps s WHERE s.attempt_id = a.attempt_id)
  ORDER BY a.attempt_id
  LIMIT $4`

const SOURCES_BY_ID_SQL = `
  SELECT ${SOURCE_COLUMNS} FROM proof_steps s
  WHERE s.attempt_id = $1 AND s.event_id = ANY($2::uuid[])
  ORDER BY s.sequence`

const INSERT_CHUNK_SQL = `
  INSERT INTO trajectory_chunks
    (attempt_id, format, codec, kind, state, seq_first, seq_last, event_count, uncompressed_bytes, compressed_bytes,
     checksum, payload, receipt_event_ids, min_source_received_at, max_source_received_at, historic_sources)
  VALUES ($1, $2, $3, $4, 'shadow', $5, $6, $7, $8, $9, $10, $11, $12::uuid[],
          ${sqlFromMicros('$13')}, ${sqlFromMicros('$14')}, $15)
  RETURNING chunk_id::text`

const CHUNK_SQL = `
  SELECT chunk_id::text, attempt_id::text, kind, state, format, codec, seq_first, seq_last, event_count,
         uncompressed_bytes, compressed_bytes, checksum, payload, receipt_event_ids::text[] AS receipts,
         published_at IS NOT NULL AS published, sources_removed_at IS NOT NULL AS sources_removed
  FROM trajectory_chunks WHERE chunk_id = $1`

function sourceAction(row) {
  return {
    eventId: row.event_id,
    sequence: row.sequence,
    clientTsUs: microsFromSql(row.client_ts_us),
    elapsedMs: row.elapsed_ms,
    stepType: row.step_type,
    command: row.command,
    fromLine: row.from_line,
    removedLines: row.removed_lines,
    attributes: row.attributes ?? {},
    receivedAtUs: microsFromSql(row.received_at_us),
  }
}

/** Rough encoded size of one action, used to split groups before encoding. */
function estimatedBytes(action) {
  return Buffer.byteLength(action.command, 'utf8') * 1.2 + 120 +
    (Object.keys(action.attributes).length > 0 ? Buffer.byteLength(JSON.stringify(action.attributes), 'utf8') : 0)
}

/** Split ordered actions into groups of at most maxEvents and about maxBytes.
 * An action is never split; a single action larger than maxBytes is its own group. */
export function groupActions(actions, { chunkMaxEvents, chunkMaxBytes }) {
  const groups = []
  let current = []
  let bytes = 0
  for (const action of actions) {
    const size = estimatedBytes(action)
    if (current.length > 0 && (current.length >= chunkMaxEvents || bytes + size > chunkMaxBytes)) {
      groups.push(current)
      current = []
      bytes = 0
    }
    current.push(action)
    bytes += size
  }
  if (current.length > 0) groups.push(current)
  return groups
}

export class CompactionError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const noop = () => {}

/** createCompactor({ pool, settings, metrics, log, hooks, historicBound }).
 * `hooks` (tests only) are awaited at each crash boundary: afterShadowInsert,
 * afterVerify, beforePublishCommit, afterPublish, beforeReplaceCommit, afterReplace.
 * `historicBound` is migration 005's applied_at (Date), the trusted upper
 * bound on the ingestion time of rows with NULL received_at. */
export function createCompactor({ pool, settings: overrides = {}, metrics = null, log = noop, hooks = {}, historicBound }) {
  const settings = { ...DEFAULT_SETTINGS, ...overrides }
  if (!MODES.includes(settings.mode)) throw new Error(`unknown compaction mode ${settings.mode}`)
  if (!(historicBound instanceof Date)) throw new Error('historicBound (migration 005 applied_at) is required')
  let sweepCursor = '00000000-0000-0000-0000-000000000000'
  let replaced = 0
  let stopping = false

  async function hook(name, context) {
    if (hooks[name]) await hooks[name](context)
  }

  async function inTransaction(fn) {
    const client = await pool.connect()
    let broken = null
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch (rollbackError) {
        broken = rollbackError
      }
      throw error
    } finally {
      client.release(broken ?? undefined)
    }
  }

  async function loadChunk(queryable, chunkId) {
    const result = await queryable.query(CHUNK_SQL, [chunkId])
    return result.rows[0] ?? null
  }

  function decodeRow(row) {
    return decodeChunk(row.payload, chunkManifest(row, row.attempt_id), settings.limits)
  }

  /** Compare decoded actions with source rows exactly, in order. */
  function identical(decoded, sources) {
    return decoded.length === sources.length && decoded.every((action, index) => sameAction(action, sources[index]))
  }

  /** Build, store as shadow and verify one chunk. Returns its id, or null
   * when verification failed (the shadow chunk is then deleted). */
  async function buildChunk(attemptId, actions) {
    const started = process.cpuUsage()
    const encoded = encodeChunk({ attemptId, actions }, settings.limits)
    const kind = (await pool.query(
      `SELECT EXISTS (SELECT 1 FROM trajectory_chunks WHERE attempt_id = $1 AND state = 'published') AS has`, [attemptId],
    )).rows[0].has ? 'delta' : 'base'
    const inserted = await pool.query(INSERT_CHUNK_SQL, [
      attemptId, encoded.format, encoded.codec, kind, encoded.seqFirst, encoded.seqLast, encoded.eventCount,
      encoded.uncompressedBytes, encoded.compressedBytes, encoded.checksum, encoded.payload, encoded.eventIds,
      encoded.minSourceReceivedAtUs, encoded.maxSourceReceivedAtUs, encoded.historicSources,
    ])
    const chunkId = inserted.rows[0].chunk_id
    metrics?.chunks.inc({ event: 'built', kind })
    metrics?.inputBytes.inc(actions.reduce((sum, action) => sum + Buffer.byteLength(action.command, 'utf8'), 0))
    metrics?.outputBytes.inc(encoded.compressedBytes)
    metrics?.rows.inc({ event: 'chunked' }, actions.length)
    await hook('afterShadowInsert', { chunkId, attemptId })

    // Verify what is durably stored, not what is in memory.
    const stored = await loadChunk(pool, chunkId)
    let verified = false
    try {
      verified = identical(decodeRow(stored), actions)
    } catch (error) {
      if (!(error instanceof TrajectoryFormatError)) throw error
    }
    const used = process.cpuUsage(started)
    metrics?.cpuSeconds.inc((used.user + used.system) / 1e6)
    if (!verified) {
      metrics?.verificationFailures.inc({ stage: 'build' })
      log('error', 'chunk verification failed after build; shadow chunk deleted', { chunkId })
      await pool.query(`DELETE FROM trajectory_chunks WHERE chunk_id = $1 AND state = 'shadow'`, [chunkId])
      return null
    }
    await hook('afterVerify', { chunkId, attemptId })
    return chunkId
  }

  /** Publish a verified shadow chunk if its sources are still exactly as
   * encoded. Returns 'published', 'already' or 'stale' (sources changed or
   * an overlapping chunk exists; the caller deletes the shadow chunk). */
  async function publish(chunkId) {
    return inTransaction(async client => {
      const chunk = await loadChunk(client, chunkId)
      if (!chunk) return 'stale'
      if (chunk.state === 'published') return 'already'
      await client.query('SELECT 1 FROM proof_attempts WHERE attempt_id = $1 FOR NO KEY UPDATE', [chunk.attempt_id])
      const decoded = decodeRow(chunk)
      const sources = (await client.query(SOURCES_BY_ID_SQL, [chunk.attempt_id, decoded.map(action => action.eventId)]))
        .rows.map(sourceAction)
      if (!identical(decoded, sources)) {
        metrics?.verificationFailures.inc({ stage: 'publish' })
        return 'stale'
      }
      const overlap = await client.query(`
        SELECT 1 FROM trajectory_chunks
        WHERE attempt_id = $1 AND chunk_id <> $2 AND state = 'published'
          AND (receipt_event_ids && $3::uuid[]
               OR (receipt_event_ids IS NULL AND seq_first <= $5 AND seq_last >= $4))
        LIMIT 1`, [chunk.attempt_id, chunkId, decoded.map(action => action.eventId), chunk.seq_first, chunk.seq_last])
      if (overlap.rows.length > 0) {
        metrics?.verificationFailures.inc({ stage: 'overlap' })
        return 'stale'
      }
      await hook('beforePublishCommit', { chunkId, attemptId: chunk.attempt_id })
      await client.query(`UPDATE trajectory_chunks SET state = 'published', published_at = now()
                          WHERE chunk_id = $1 AND state = 'shadow'`, [chunkId])
      await client.query(`UPDATE proof_attempts SET compacted_through = GREATEST(COALESCE(compacted_through, -1), $2)
                          WHERE attempt_id = $1`, [chunk.attempt_id, chunk.seq_last])
      return 'published'
    })
  }

  /** Remove the exact verified sources of a published chunk. Returns
   * 'replaced', 'already' or throws CompactionError on any disagreement. */
  async function replace(chunkId) {
    return inTransaction(async client => {
      const chunk = await loadChunk(client, chunkId)
      if (!chunk || chunk.state !== 'published') throw new CompactionError('not_published', `chunk ${chunkId} is not published`)
      if (chunk.sources_removed) return 'already'
      await client.query('SELECT 1 FROM proof_attempts WHERE attempt_id = $1 FOR NO KEY UPDATE', [chunk.attempt_id])
      const decoded = decodeRow(chunk)
      const ids = decoded.map(action => action.eventId)
      if (!chunk.receipts || chunk.receipts.length !== ids.length || chunk.receipts.some((id, index) => id !== ids[index])) {
        throw new CompactionError('receipt_mismatch', `chunk ${chunkId} receipts differ from its payload`)
      }
      const sources = (await client.query(SOURCES_BY_ID_SQL, [chunk.attempt_id, ids])).rows.map(sourceAction)
      if (!identical(decoded, sources)) {
        metrics?.verificationFailures.inc({ stage: 'replace' })
        throw new CompactionError('source_mismatch', `chunk ${chunkId} sources are missing or differ; nothing removed`)
      }
      await hook('beforeReplaceCommit', { chunkId, attemptId: chunk.attempt_id })
      const deleted = await client.query('DELETE FROM proof_steps WHERE attempt_id = $1 AND event_id = ANY($2::uuid[])',
        [chunk.attempt_id, ids])
      if (deleted.rowCount !== ids.length) {
        throw new CompactionError('delete_count', `chunk ${chunkId}: deleted ${deleted.rowCount} of ${ids.length} rows`)
      }
      await client.query('UPDATE trajectory_chunks SET sources_removed_at = now() WHERE chunk_id = $1', [chunkId])
      metrics?.rows.inc({ event: 'replaced' }, ids.length)
      return 'replaced'
    })
  }

  /** Delete a shadow chunk that cannot be published. Its sources are intact:
   * shadow chunks are never replaced. */
  async function discardShadow(chunkId, reason) {
    await pool.query(`DELETE FROM trajectory_chunks WHERE chunk_id = $1 AND state = 'shadow'`, [chunkId])
    metrics?.chunks.inc({ event: 'discarded', kind: 'shadow' })
    log('warn', 'shadow chunk discarded', { chunkId, reason })
  }

  /** Eligible, not yet chunked rows of one attempt, honouring the recent-row
   * window and (for active attempts) full chunks only. */
  async function eligibleActions(candidate) {
    const limit = Math.max(settings.activeChunkThreshold, settings.chunkMaxEvents) * 4
    const rows = (await pool.query(ELIGIBLE_ROWS_SQL, [candidate.attempt_id, historicBound, settings.minAgeSeconds, limit]))
      .rows.map(sourceAction)
    if (candidate.completed || candidate.inactive) return rows
    if (rows.length < settings.activeChunkThreshold) return []
    // Long active attempt: only full chunks; the remainder waits for more rows.
    return rows.slice(0, rows.length - (rows.length % settings.chunkMaxEvents))
  }

  async function compactAttempt(candidate) {
    const actions = await eligibleActions(candidate)
    if (actions.length === 0) return { chunks: 0 }
    let chunks = 0
    for (const group of groupActions(actions, settings)) {
      if (stopping) break
      let pieces = [group]
      const built = []
      while (pieces.length > 0) {
        const piece = pieces.shift()
        try {
          built.push(await buildChunk(candidate.attempt_id, piece))
        } catch (error) {
          if (error instanceof TrajectoryFormatError && error.code === 'chunk_too_large' && piece.length > 1) {
            const middle = Math.ceil(piece.length / 2)
            pieces = [piece.slice(0, middle), piece.slice(middle), ...pieces]
            continue
          }
          throw error
        }
      }
      for (const chunkId of built.filter(Boolean)) {
        const outcome = await publish(chunkId)
        if (outcome === 'stale') {
          await discardShadow(chunkId, 'sources changed before publication')
          continue
        }
        await hook('afterPublish', { chunkId, attemptId: candidate.attempt_id })
        metrics?.chunks.inc({ event: 'published', kind: 'any' })
        chunks++
      }
    }
    return { chunks }
  }

  /** One bounded build pass over the next attempts of the sweep. */
  async function buildPass() {
    const candidates = (await pool.query(CANDIDATES_SQL,
      [sweepCursor, historicBound, settings.inactiveSeconds, settings.attemptsPerCycle])).rows
    let chunks = 0
    for (const candidate of candidates) {
      if (stopping) break
      sweepCursor = candidate.attempt_id
      // Retention removed this attempt's detail: leave any late rows for the
      // operator's policy rather than building chunks the writer will refuse.
      if (candidate.detail_expired) continue
      chunks += (await compactAttempt(candidate)).chunks
    }
    const wrapped = candidates.length < settings.attemptsPerCycle
    if (wrapped) sweepCursor = '00000000-0000-0000-0000-000000000000'
    return { attempts: candidates.length, chunks, wrapped }
  }

  /** Replace sources of chunks published longer than the delay (mode replace),
   * stopping at the canary limit. */
  async function replacePass() {
    if (settings.mode !== 'replace') return { replaced: 0, limited: false }
    const remaining = settings.replaceLimit === Infinity ? 50 : Math.min(50, settings.replaceLimit - replaced)
    if (remaining <= 0) return { replaced: 0, limited: true }
    const due = (await pool.query(`
      SELECT chunk_id::text FROM trajectory_chunks
      WHERE state = 'published' AND sources_removed_at IS NULL
        AND published_at < now() - $1 * interval '1 second'
      ORDER BY published_at LIMIT $2`, [settings.replaceDelaySeconds, remaining])).rows
    let count = 0
    for (const { chunk_id: chunkId } of due) {
      if (stopping) break
      try {
        if (await replace(chunkId) === 'replaced') {
          count++
          replaced++
          await hook('afterReplace', { chunkId })
        }
      } catch (error) {
        if (!(error instanceof CompactionError)) throw error
        metrics?.verificationFailures.inc({ stage: 'replace' })
        log('error', 'replacement refused', { chunkId, code: error.code })
      }
    }
    return { replaced: count, limited: settings.replaceLimit !== Infinity && replaced >= settings.replaceLimit }
  }

  /** Shadow chunks left by a crash: verify and publish, or discard. */
  async function recover({ olderThanSeconds = settings.recoverAfterSeconds } = {}) {
    const stale = (await pool.query(`
      SELECT chunk_id::text, attempt_id::text FROM trajectory_chunks
      WHERE state = 'shadow' AND created_at < now() - $1 * interval '1 second'
      ORDER BY created_at LIMIT 100`, [olderThanSeconds])).rows
    let published = 0
    let discarded = 0
    for (const { chunk_id: chunkId } of stale) {
      let outcome = 'stale'
      try {
        outcome = await publish(chunkId)
      } catch (error) {
        if (!(error instanceof TrajectoryFormatError)) throw error
      }
      if (outcome === 'published' || outcome === 'already') {
        published++
      } else {
        await discardShadow(chunkId, 'recovery could not verify it')
        discarded++
      }
    }
    metrics?.orphanChunks.set(stale.length - published - discarded)
    return { published, discarded }
  }

  /** One full cycle: recovery, replacement, then (unless paused) building. */
  async function runOnce({ buildPaused = false } = {}) {
    if (settings.mode === 'off') return { mode: 'off' }
    const recovered = await recover()
    const replacement = await replacePass()
    const build = buildPaused || stopping ? { attempts: 0, chunks: 0, wrapped: false, paused: true } : await buildPass()
    return { recovered, replacement, build }
  }

  return {
    settings,
    runOnce,
    recover,
    buildPass,
    replacePass,
    compactAttempt,
    publish,
    replace,
    stop() { stopping = true },
    get stopping() { return stopping },
  }
}

/** Backlog and storage observations for metrics; bounded by the role's
 * statement timeout. Returns null fields when a query fails. */
export async function observeBacklog(queryable, { historicBound, minAgeSeconds }) {
  const result = await queryable.query(`
    SELECT
      (SELECT count(*) FROM proof_steps s
        WHERE COALESCE(s.received_at, $1::timestamptz) < now() - $2 * interval '1 second')::bigint AS old_rows,
      (SELECT COALESCE(sum(event_count), 0) FROM trajectory_chunks WHERE sources_removed_at IS NULL)::bigint AS chunked_live_rows,
      (SELECT extract(epoch FROM now() - min(COALESCE(s.received_at, $1::timestamptz)))
         FROM proof_steps s
         WHERE NOT EXISTS (SELECT 1 FROM trajectory_chunks c
                           WHERE c.attempt_id = s.attempt_id AND s.event_id = ANY(c.receipt_event_ids))) AS oldest_uncompacted_seconds,
      (SELECT count(*) FROM trajectory_chunks WHERE state = 'shadow')::bigint AS shadow_chunks,
      (SELECT count(*) FROM trajectory_chunks WHERE state = 'published' AND sources_removed_at IS NULL)::bigint AS awaiting_replace`,
  [historicBound, minAgeSeconds])
  const row = result.rows[0]
  return {
    eligibleRows: Math.max(0, Number(row.old_rows) - Number(row.chunked_live_rows)),
    oldestUncompactedSeconds: row.oldest_uncompacted_seconds === null ? 0 : Number(row.oldest_uncompacted_seconds),
    shadowChunks: Number(row.shadow_chunks),
    awaitingReplace: Number(row.awaiting_replace),
  }
}
