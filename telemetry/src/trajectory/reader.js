import fs from 'node:fs/promises'
import path from 'node:path'
import {
  decodeChunk, DEFAULT_LIMITS, microsFromSql, sameAction, sqlMicros, TrajectoryFormatError,
} from './codec.js'

/** The shared trajectory reader (docs/design.md section 10,
 * docs/replay-contract.md).
 *
 * An attempt's steps live in up to three places: live proof_steps rows,
 * published trajectory_chunks (base and late 'delta' chunks) and, after an
 * explicit retention policy, an archive directory. readAttempt() merges them
 * and returns every accepted action exactly once, in sequence order, in the
 * codec's canonical form. Shadow chunks are ignored: their sources are still
 * live and authoritative. Nothing is hidden: missing sequences, corrupt or
 * unavailable chunks and disagreements between copies are reported. */

export const DEFAULT_READ_LIMITS = Object.freeze({
  ...DEFAULT_LIMITS,
  maxActionsPerAttempt: 100000,
  maxDecodedBytesPerAttempt: 64 * 1024 * 1024,
  maxMissingListed: 1000,
})

export const ATTEMPT_COLUMNS = `
  a.attempt_id::text, a.user_id::text, a.source_attempt_id::text, a.game_id, a.world_id, a.level_id,
  a.mode::text AS mode, ${sqlMicros('a.started_at')} AS started_at_us, ${sqlMicros('a.completed_at')} AS completed_at_us,
  a.duration_ms, a.completed, a.initial_script, a.play_script, a.lean_script, a.attributes,
  ${sqlMicros('a.received_at')} AS received_at_us, ${sqlMicros('a.last_received_at')} AS last_received_at_us,
  a.start_event_id::text, a.start_sequence, ${sqlMicros('a.start_client_ts')} AS start_client_ts_us, a.start_elapsed_ms,
  a.completion_event_id::text, a.completion_sequence,
  ${sqlMicros('a.completion_received_at')} AS completion_received_at_us,
  a.later_completion_sequences, a.compacted_through, ${sqlMicros('a.detail_expired_at')} AS detail_expired_at_us,
  ${sqlMicros('u.first_seen')} AS user_first_seen_us, ${sqlMicros('u.last_seen')} AS user_last_seen_us`

const ATTEMPT_SQL = `
  SELECT ${ATTEMPT_COLUMNS}
  FROM proof_attempts a LEFT JOIN anonymous_users u ON u.user_id = a.user_id
  WHERE a.attempt_id = $1`

const LIVE_SQL = `
  SELECT event_id::text, sequence, ${sqlMicros('client_ts')} AS client_ts_us, elapsed_ms, step_type::text,
         command, from_line, removed_lines, attributes, ${sqlMicros('received_at')} AS received_at_us,
         octet_length(command) AS command_bytes
  FROM proof_steps WHERE attempt_id = $1 ORDER BY sequence LIMIT $2`

const CHUNKS_SQL = `
  SELECT chunk_id::text, kind, format, codec, seq_first, seq_last, event_count, uncompressed_bytes,
         compressed_bytes, checksum, payload, sources_removed_at IS NOT NULL AS sources_removed
  FROM trajectory_chunks WHERE attempt_id = $1 AND state = 'published' ORDER BY seq_first, chunk_id`

/** Convert one attempts row (ATTEMPT_COLUMNS) to the reader's attempt object. */
export function attemptFromRow(row) {
  return {
    attemptId: row.attempt_id,
    userId: row.user_id,
    sourceAttemptId: row.source_attempt_id,
    gameId: row.game_id,
    worldId: row.world_id,
    levelId: row.level_id,
    mode: row.mode,
    startedAtUs: microsFromSql(row.started_at_us),
    completedAtUs: microsFromSql(row.completed_at_us),
    durationMs: row.duration_ms,
    completed: row.completed,
    initialScript: row.initial_script,
    playScript: row.play_script,
    leanScript: row.lean_script,
    attributes: row.attributes ?? {},
    receivedAtUs: microsFromSql(row.received_at_us),
    lastReceivedAtUs: microsFromSql(row.last_received_at_us),
    startEventId: row.start_event_id,
    startSequence: row.start_sequence,
    startClientTsUs: microsFromSql(row.start_client_ts_us),
    startElapsedMs: row.start_elapsed_ms,
    completionEventId: row.completion_event_id,
    completionSequence: row.completion_sequence,
    completionReceivedAtUs: microsFromSql(row.completion_received_at_us),
    laterCompletionSequences: [...(row.later_completion_sequences ?? [])],
    compactedThrough: row.compacted_through,
    detailExpiredAtUs: microsFromSql(row.detail_expired_at_us),
    userFirstSeenUs: microsFromSql(row.user_first_seen_us),
    userLastSeenUs: microsFromSql(row.user_last_seen_us),
  }
}

function liveAction(row) {
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

/** Manifest fields of a chunk row, as decodeChunk() expects them. */
export function chunkManifest(row, attemptId) {
  return {
    format: row.format,
    codec: row.codec,
    attemptId,
    eventCount: row.event_count,
    seqFirst: row.seq_first,
    seqLast: row.seq_last,
    uncompressedBytes: row.uncompressed_bytes,
    checksum: row.checksum,
  }
}

/** Sequences an attempt is expected to have and which of them are missing.
 * Clients number level_start (normally 0), every step and every completion
 * from one counter; steps are expected at each sequence from 1 to the highest
 * known one, except those held by the recorded start, completion and later
 * (rejected) completions. Arrival order is never evidence of completeness. */
export function completenessOf(attempt, actions, errors, limits = DEFAULT_READ_LIMITS) {
  const held = new Set(actions.map(action => action.sequence))
  if (attempt.startSequence !== null) held.add(attempt.startSequence)
  if (attempt.completionSequence !== null) held.add(attempt.completionSequence)
  for (const sequence of attempt.laterCompletionSequences) held.add(sequence)
  const highest = Math.max(0, ...held)
  const missing = []
  let missingCount = 0
  for (let sequence = 1; sequence <= highest; sequence++) {
    if (held.has(sequence)) continue
    missingCount++
    if (missing.length < limits.maxMissingListed) missing.push(sequence)
  }
  const startRecorded = attempt.startEventId !== null
  const completionRecorded = attempt.completionEventId !== null
  // Completions accepted before migration 006 consumed a sequence number that
  // was never stored; one gap may be that completion rather than a lost step.
  const legacyCompletion = attempt.completed && attempt.completionSequence === null
  const detailExpired = attempt.detailExpiredAtUs !== null
  return {
    stepCount: actions.length,
    firstSequence: actions[0]?.sequence ?? null,
    lastSequence: actions.at(-1)?.sequence ?? null,
    highestKnownSequence: highest,
    missingSequences: missing,
    missingCount,
    startRecorded,
    completionRecorded,
    legacyCompletionUnknownSequence: legacyCompletion,
    detailExpired,
    complete: !detailExpired && errors.length === 0 && missingCount === 0 && startRecorded &&
      (!attempt.completed || completionRecorded),
  }
}

/** A directory written by src/jobs/archive.js, read one attempt at a time. */
export function archiveSource(directory) {
  const root = path.resolve(directory)
  return {
    directory: root,
    attemptDirectory(attemptId) {
      return path.join(root, 'attempts', attemptId.slice(0, 2), attemptId)
    },
    /** Chunk rows (same shape as CHUNKS_SQL) for an attempt, or [] if absent. */
    async chunksFor(attemptId) {
      const directoryPath = this.attemptDirectory(attemptId)
      let names
      try {
        names = await fs.readdir(directoryPath)
      } catch (error) {
        if (error.code === 'ENOENT') return []
        throw error
      }
      const rows = []
      for (const name of names.filter(item => /^chunk-\d+\.json$/u.test(item)).sort()) {
        const manifest = JSON.parse(await fs.readFile(path.join(directoryPath, name), 'utf8'))
        if (manifest.attempt_id !== attemptId) throw new TrajectoryFormatError('corrupt_archive', 'archive manifest attempt mismatch')
        rows.push({
          chunk_id: String(manifest.chunk_id),
          kind: manifest.kind,
          format: manifest.format,
          codec: manifest.codec,
          seq_first: manifest.seq_first,
          seq_last: manifest.seq_last,
          event_count: manifest.event_count,
          uncompressed_bytes: manifest.uncompressed_bytes,
          compressed_bytes: manifest.compressed_bytes,
          checksum: Buffer.from(manifest.checksum_sha256, 'hex'),
          // Read lazily: only chunks actually needed are loaded.
          loadPayload: () => fs.readFile(path.join(directoryPath, manifest.payload_file)),
          sources_removed: true,
          archived: true,
        })
      }
      return rows
    },
  }
}

/** Read one attempt. Options: { limits, archive (archiveSource), compareLive (default true) }.
 * Returns null if the attempt does not exist (and is not in the archive). */
export async function readAttempt(queryable, attemptId, { limits = DEFAULT_READ_LIMITS, archive = null } = {}) {
  const attemptResult = await queryable.query(ATTEMPT_SQL, [attemptId])
  if (attemptResult.rows.length === 0) return null
  const attempt = attemptFromRow(attemptResult.rows[0])
  return readAttemptDetail(queryable, attempt, { limits, archive })
}

/** Steps of an attempt whose row was already read (see attemptFromRow). */
export async function readAttemptDetail(queryable, attempt, { limits = DEFAULT_READ_LIMITS, archive = null } = {}) {
  const errors = []
  const bySequence = new Map()
  const sourceOf = new Map()
  const chunks = []
  let decodedBytes = 0
  let liveRows = 0

  const chunkRows = (await queryable.query(CHUNKS_SQL, [attempt.attemptId])).rows
  if (archive) {
    const known = new Map(chunkRows.map(row => [row.chunk_id, row]))
    for (const row of await archive.chunksFor(attempt.attemptId)) {
      const local = known.get(row.chunk_id)
      if (!local) chunkRows.push(row)
      else if (!local.checksum.equals(row.checksum)) {
        errors.push({ code: 'archive_mismatch', chunkId: row.chunk_id, message: 'archived chunk differs from the database copy' })
      }
    }
    chunkRows.sort((left, right) => left.seq_first - right.seq_first)
  }

  for (const row of chunkRows) {
    const reference = { chunkId: row.chunk_id, kind: row.kind, seqFirst: row.seq_first, seqLast: row.seq_last,
      eventCount: row.event_count, archived: Boolean(row.archived), sourcesRemoved: row.sources_removed }
    chunks.push(reference)
    if (decodedBytes + row.uncompressed_bytes > limits.maxDecodedBytesPerAttempt) {
      errors.push({ code: 'attempt_too_large', chunkId: row.chunk_id, message: 'decoded bytes per attempt limit reached' })
      break
    }
    let actions
    try {
      const payload = row.payload ?? await row.loadPayload()
      actions = decodeChunk(payload, chunkManifest(row, attempt.attemptId), limits)
    } catch (error) {
      errors.push({
        code: error instanceof TrajectoryFormatError ? error.code : (error.code === 'ENOENT' ? 'chunk_unavailable' : 'chunk_unreadable'),
        chunkId: row.chunk_id,
        message: error instanceof TrajectoryFormatError ? error.message : 'chunk could not be read',
      })
      continue
    }
    decodedBytes += row.uncompressed_bytes
    for (const action of actions) {
      const existing = bySequence.get(action.sequence)
      if (existing) {
        if (!sameAction(existing, action)) {
          errors.push({ code: 'chunk_overlap', chunkId: row.chunk_id, sequence: action.sequence,
            message: 'two chunks hold different actions for one sequence' })
        }
        continue
      }
      bySequence.set(action.sequence, action)
      sourceOf.set(action.sequence, `chunk:${row.chunk_id}`)
    }
  }

  const liveLimit = Math.max(0, limits.maxActionsPerAttempt - bySequence.size) + 1
  const live = (await queryable.query(LIVE_SQL, [attempt.attemptId, liveLimit])).rows
  if (live.length >= liveLimit) {
    errors.push({ code: 'attempt_too_large', message: 'actions per attempt limit reached' })
    live.length = liveLimit - 1
  }
  for (const row of live) {
    liveRows++
    const action = liveAction(row)
    const existing = bySequence.get(action.sequence)
    if (existing) {
      // Before replacement a published chunk and its sources coexist and must agree.
      if (!sameAction(existing, action)) {
        errors.push({ code: 'chunk_live_mismatch', chunkId: sourceOf.get(action.sequence).slice(6),
          sequence: action.sequence, message: 'a live row differs from the published chunk holding its sequence' })
      }
      continue
    }
    bySequence.set(action.sequence, action)
    sourceOf.set(action.sequence, 'live')
  }

  const actions = [...bySequence.values()].sort((left, right) => left.sequence - right.sequence)
  const ids = new Map()
  for (const action of actions) {
    const previous = ids.get(action.eventId)
    if (previous !== undefined) {
      errors.push({ code: 'duplicate_event_id', sequence: action.sequence, message: `event id also at sequence ${previous}` })
    } else {
      ids.set(action.eventId, action.sequence)
    }
  }
  return {
    attempt,
    actions,
    sources: {
      liveRows,
      fromChunks: actions.filter(action => sourceOf.get(action.sequence) !== 'live').length,
      chunks,
    },
    completeness: completenessOf(attempt, actions, errors, limits),
    errors,
  }
}

function encodeCursor(values) {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url')
}

function decodeCursor(cursor) {
  try {
    const values = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (Array.isArray(values)) return values
  } catch {}
  throw new Error('invalid cursor')
}

/** Keyset orders. 'user' follows proof_attempts_user_idx (user_id, started_at)
 * so exports group a user's attempts without a global sort; 'attempt' is the
 * primary key order. */
const ORDERS = {
  user: {
    columns: ['a.user_id', 'a.started_at', 'a.attempt_id'],
    key: row => [row.user_id, String(row.started_at_us), row.attempt_id],
    after: '(a.user_id, a.started_at, a.attempt_id) > ($CURSOR1::uuid, timestamptz \'epoch\' + $CURSOR2::bigint * interval \'1 microsecond\', $CURSOR3::uuid)',
  },
  attempt: {
    columns: ['a.attempt_id'],
    key: row => [row.attempt_id],
    after: 'a.attempt_id > $CURSOR1::uuid',
  },
}

/** Iterate attempts in keyset order. Filter: { order ('user' | 'attempt'),
 * since/until (Date or ISO; trusted activity time: last_received_at, else
 * received_at, else migration 005's applied_at for historic rows), gameId,
 * attemptIds, cursor, batchSize, limits, archive }. Yields
 * { ...readAttemptDetail result, cursor } where `cursor` resumes after it. */
export async function* readAttempts(queryable, filter = {}) {
  const order = ORDERS[filter.order ?? 'user']
  if (!order) throw new Error(`unknown order ${filter.order}`)
  const batchSize = Math.min(Math.max(filter.batchSize ?? 100, 1), 1000)
  let cursor = filter.cursor ? decodeCursor(filter.cursor) : null
  for (;;) {
    const params = []
    const where = []
    const add = value => {
      params.push(value)
      return `$${params.length}`
    }
    const activity = `COALESCE(a.last_received_at, a.received_at, (SELECT applied_at FROM schema_migrations WHERE version = '005'))`
    if (filter.since) where.push(`${activity} >= ${add(new Date(filter.since))}::timestamptz`)
    if (filter.until) where.push(`${activity} < ${add(new Date(filter.until))}::timestamptz`)
    if (filter.gameId) where.push(`a.game_id = ${add(filter.gameId)}`)
    if (filter.attemptIds) where.push(`a.attempt_id = ANY(${add(filter.attemptIds)}::uuid[])`)
    if (cursor) {
      let clause = order.after
      cursor.forEach((value, index) => { clause = clause.replace(`$CURSOR${index + 1}`, add(value)) })
      where.push(clause)
    }
    const sql = `SELECT ${ATTEMPT_COLUMNS}
      FROM proof_attempts a LEFT JOIN anonymous_users u ON u.user_id = a.user_id
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${order.columns.join(', ')} LIMIT ${add(batchSize)}`
    const page = (await queryable.query(sql, params)).rows
    for (const row of page) {
      const result = await readAttemptDetail(queryable, attemptFromRow(row), filter)
      cursor = order.key(row)
      yield { ...result, cursor: encodeCursor(cursor) }
    }
    if (page.length < batchSize) return
  }
}
