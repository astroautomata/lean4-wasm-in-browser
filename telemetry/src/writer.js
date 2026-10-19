import { abortErrorFrom, databaseErrorClass, transientConflict } from './http/errors.js'
import { rowAttributes, UPSERT_USERS_SQL } from './database.js'
import { decodeChunk, DEFAULT_LIMITS, microsFromSql, sqlFromMicros, sqlMicros } from './trajectory/codec.js'
import { canonicalEventContent } from './validation.js'

/** Bulk event writer (docs/design.md section 8, docs/replay-contract.md).
 *
 * One READ COMMITTED transaction per batch with a small fixed number of
 * statements, whatever the batch size: users, attempts, the attempt row lock,
 * one identity lookup, (chunk payloads), (step insert), (race recheck),
 * (attempt update). Every outcome is decided from database state read under
 * the attempt lock, which also serialises the writer with the compactor's
 * publish/replace transactions, so a step whose live row was compacted away is
 * still recognised as a duplicate or conflict and never inserted again. */

export const MAX_LATER_COMPLETIONS = 64

/** A published chunk needed for an identity decision could not be decoded.
 * The batch fails (500) rather than guess: an operator must restore the chunk. */
export class ChunkUnavailableError extends Error {
  constructor(chunkId, code) {
    super(`trajectory chunk ${chunkId} unavailable (${code})`)
    this.name = 'ChunkUnavailableError'
    this.chunkId = chunkId
    this.formatCode = code
  }
}

/** A concurrent transaction changed what this one relied on; retry it. */
function raceError(what) {
  return Object.assign(new Error(`concurrent change: ${what}`), { code: '40001' })
}

const ATTEMPTS_SQL = `
  INSERT INTO proof_attempts (attempt_id, user_id, game_id, world_id, level_id, mode, started_at, attributes)
  SELECT v.attempt_id, v.user_id, v.game_id, v.world_id, v.level_id, v.mode::telemetry_mode,
         ${sqlFromMicros('v.started_us')}, v.attributes::jsonb
  FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::int[], $6::text[], $7::bigint[], $8::text[])
    AS v(attempt_id, user_id, game_id, world_id, level_id, mode, started_us, attributes)
  ORDER BY v.attempt_id
  ON CONFLICT (attempt_id) DO NOTHING`

// Scripts are read back only for attempts with a start ($2) or completion ($3)
// in the batch: they are needed only to compare a retried start/completion.
const LOCK_SQL = `
  SELECT attempt_id::text, user_id::text, game_id, world_id, level_id, mode::text,
         start_event_id::text, start_sequence, ${sqlMicros('start_client_ts')} AS start_ts_us, start_elapsed_ms,
         CASE WHEN attempt_id = ANY($2::uuid[]) THEN initial_script END AS initial_script,
         source_attempt_id::text,
         completed, completion_event_id::text, completion_sequence,
         ${sqlMicros('completed_at')} AS completed_at_us, duration_ms,
         CASE WHEN attempt_id = ANY($3::uuid[]) THEN play_script END AS play_script,
         CASE WHEN attempt_id = ANY($3::uuid[]) THEN lean_script END AS lean_script,
         later_completion_sequences, compacted_through, detail_expired_at IS NOT NULL AS detail_expired,
         ${sqlMicros('last_received_at')} AS last_received_us, ${sqlMicros('now()')} AS now_us,
         CASE WHEN $4::boolean THEN (extract(epoch FROM now() - COALESCE(last_received_at, received_at,
           (SELECT applied_at FROM schema_migrations WHERE version = '005'))) * 1000)::bigint END AS idle_ms
  FROM proof_attempts
  WHERE attempt_id = ANY($1::uuid[])
  ORDER BY attempt_id
  FOR UPDATE`

const STEP_COLUMNS = `s.event_id::text AS event_id, s.attempt_id::text AS attempt_id, s.sequence,
  ${sqlMicros('s.client_ts')} AS ts_us, s.elapsed_ms, s.step_type::text AS step_type, s.command, s.from_line, s.removed_lines`

/** Every stored identity the batch could collide with, in one statement:
 * live steps by id ($1) and by (attempt, sequence) ($2, $3); attempts by start
 * and completion id; published chunks whose receipts hold one of the ids, and
 * chunks covering (attempt, sequence) pairs at or below compacted_through ($4, $5). */
const LOOKUP_SQL = `
  SELECT 'step' AS kind, ${STEP_COLUMNS}, NULL::bigint AS chunk_id, NULL::text[] AS matched
  FROM proof_steps s WHERE s.event_id = ANY($1::uuid[])
  UNION ALL
  SELECT 'step', ${STEP_COLUMNS}, NULL, NULL
  FROM unnest($2::uuid[], $3::int[]) AS p(attempt_id, sequence)
  JOIN proof_steps s ON s.attempt_id = p.attempt_id AND s.sequence = p.sequence
  UNION ALL
  SELECT 'start', a.start_event_id::text, a.attempt_id::text, a.start_sequence, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  FROM proof_attempts a WHERE a.start_event_id = ANY($1::uuid[])
  UNION ALL
  SELECT 'completion', a.completion_event_id::text, a.attempt_id::text, a.completion_sequence,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  FROM proof_attempts a WHERE a.completion_event_id = ANY($1::uuid[])
  UNION ALL
  SELECT 'chunk', NULL, c.attempt_id::text, NULL, NULL, NULL, NULL, NULL, NULL, NULL, c.chunk_id,
         ARRAY(SELECT r::text FROM unnest(c.receipt_event_ids) AS r WHERE r = ANY($1::uuid[]))
  FROM trajectory_chunks c WHERE c.state = 'published' AND c.receipt_event_ids && $1::uuid[]
  UNION ALL
  SELECT 'chunk', NULL, c.attempt_id::text, NULL, NULL, NULL, NULL, NULL, NULL, NULL, c.chunk_id, NULL
  FROM unnest($4::uuid[], $5::int[]) AS p(attempt_id, sequence)
  JOIN trajectory_chunks c ON c.attempt_id = p.attempt_id AND c.seq_first <= p.sequence AND c.seq_last >= p.sequence
  WHERE c.state = 'published'`

const CHUNKS_SQL = `
  SELECT chunk_id, attempt_id::text, format, codec, seq_first, seq_last, event_count, uncompressed_bytes, checksum, payload
  FROM trajectory_chunks WHERE chunk_id = ANY($1::bigint[]) AND state = 'published'`

const INSERT_STEPS_SQL = `
  INSERT INTO proof_steps (event_id, attempt_id, sequence, client_ts, elapsed_ms, step_type, command, from_line, removed_lines,
                           attributes)
  SELECT v.event_id, v.attempt_id, v.sequence, ${sqlFromMicros('v.ts_us')}, v.elapsed_ms, v.step_type::telemetry_step_type,
         v.command, v.from_line, v.removed_lines, v.attributes::jsonb
  FROM unnest($1::uuid[], $2::uuid[], $3::int[], $4::bigint[], $5::int[], $6::text[], $7::text[], $8::int[], $9::int[],
              $10::text[])
    AS v(event_id, attempt_id, sequence, ts_us, elapsed_ms, step_type, command, from_line, removed_lines, attributes)
  ORDER BY v.event_id
  ON CONFLICT DO NOTHING
  RETURNING event_id::text`

const RECHECK_SQL = `
  SELECT ${STEP_COLUMNS} FROM proof_steps s WHERE s.event_id = ANY($1::uuid[])
  UNION ALL
  SELECT ${STEP_COLUMNS}
  FROM unnest($2::uuid[], $3::int[]) AS p(attempt_id, sequence)
  JOIN proof_steps s ON s.attempt_id = p.attempt_id AND s.sequence = p.sequence`

// One row per changed attempt. A NULL start/completion id leaves those columns
// as they are; `later` replaces later_completion_sequences when not NULL.
const UPDATE_ATTEMPTS_SQL = `
  UPDATE proof_attempts AS a SET
    start_event_id = COALESCE(u.start_event_id, a.start_event_id),
    start_sequence = CASE WHEN u.start_event_id IS NULL THEN a.start_sequence ELSE u.start_sequence END,
    start_client_ts = CASE WHEN u.start_event_id IS NULL THEN a.start_client_ts ELSE ${sqlFromMicros('u.start_ts_us')} END,
    start_elapsed_ms = CASE WHEN u.start_event_id IS NULL THEN a.start_elapsed_ms ELSE u.start_elapsed_ms END,
    initial_script = CASE WHEN u.start_event_id IS NULL THEN a.initial_script ELSE COALESCE(a.initial_script, u.initial_script) END,
    source_attempt_id = CASE WHEN u.start_event_id IS NULL THEN a.source_attempt_id
                             ELSE COALESCE(a.source_attempt_id, u.source_attempt_id) END,
    started_at = CASE WHEN u.start_event_id IS NULL THEN a.started_at
                      ELSE LEAST(a.started_at, ${sqlFromMicros('u.start_ts_us')}) END,
    completed = a.completed OR u.complete,
    completed_at = CASE WHEN u.complete THEN ${sqlFromMicros('u.completed_at_us')} ELSE a.completed_at END,
    duration_ms = CASE WHEN u.complete THEN u.duration_ms ELSE a.duration_ms END,
    play_script = CASE WHEN u.complete THEN u.play_script ELSE a.play_script END,
    lean_script = CASE WHEN u.complete THEN u.lean_script ELSE a.lean_script END,
    completion_received_at = CASE WHEN u.complete THEN now() ELSE a.completion_received_at END,
    completion_event_id = COALESCE(u.completion_event_id, a.completion_event_id),
    completion_sequence = CASE WHEN u.completion_event_id IS NULL THEN a.completion_sequence ELSE u.completion_sequence END,
    later_completion_sequences = COALESCE(u.later::int[], a.later_completion_sequences),
    last_received_at = CASE WHEN u.touch THEN now() ELSE a.last_received_at END
  FROM unnest($1::uuid[], $2::uuid[], $3::int[], $4::bigint[], $5::int[], $6::text[], $7::uuid[],
              $8::boolean[], $9::bigint[], $10::int[], $11::text[], $12::text[], $13::uuid[], $14::int[],
              $15::text[], $16::boolean[])
    AS u(attempt_id, start_event_id, start_sequence, start_ts_us, start_elapsed_ms, initial_script, source_attempt_id,
         complete, completed_at_us, duration_ms, play_script, lean_script, completion_event_id, completion_sequence,
         later, touch)
  WHERE a.attempt_id = u.attempt_id`

const accepted = () => ({ status: 'accepted' })
const duplicate = () => ({ status: 'duplicate' })
const rejected = reason => ({ status: 'rejected', reason })

function slot(attemptId, sequence) {
  return `${attemptId}#${sequence}`
}

function storedStep(row) {
  return {
    eventId: row.event_id,
    attemptId: row.attempt_id,
    sequence: row.sequence,
    clientTsUs: microsFromSql(row.ts_us),
    elapsedMs: row.elapsed_ms,
    stepType: row.step_type,
    command: row.command,
    fromLine: row.from_line,
    removedLines: row.removed_lines,
  }
}

/** Same client content for a step (attempt compared by the caller). Build
 * attributes and received_at are not part of identity. */
function sameStep(stored, event) {
  return stored.sequence === event.sequence && stored.clientTsUs === event.clientTsUs &&
    stored.elapsedMs === event.elapsedMs && stored.stepType === event.stepType && stored.command === event.command &&
    stored.fromLine === event.fromLine && stored.removedLines === event.removedLines
}

function sameStart(attempt, event) {
  return attempt.startSequence === event.sequence && attempt.startTsUs === event.clientTsUs &&
    attempt.startElapsedMs === event.elapsedMs && attempt.initialScript === event.initialScript &&
    attempt.sourceAttemptId === event.sourceAttemptId
}

function sameCompletionContent(attempt, event) {
  return attempt.completedAtUs === event.clientTsUs && attempt.durationMs === event.elapsedMs &&
    attempt.playScript === event.playScript && attempt.leanScript === event.leanScript
}

function sameContext(attempt, event) {
  return attempt.userId === event.userId && attempt.gameId === event.gameId && attempt.worldId === event.worldId &&
    attempt.levelId === event.levelId && attempt.mode === event.mode
}

function attemptState(row) {
  return {
    attemptId: row.attempt_id,
    userId: row.user_id,
    gameId: row.game_id,
    worldId: row.world_id,
    levelId: row.level_id,
    mode: row.mode,
    startEventId: row.start_event_id,
    startSequence: row.start_sequence,
    startTsUs: microsFromSql(row.start_ts_us),
    startElapsedMs: row.start_elapsed_ms,
    initialScript: row.initial_script,
    sourceAttemptId: row.source_attempt_id,
    completed: row.completed,
    completionEventId: row.completion_event_id,
    completionSequence: row.completion_sequence,
    completedAtUs: microsFromSql(row.completed_at_us),
    durationMs: row.duration_ms,
    playScript: row.play_script,
    leanScript: row.lean_script,
    later: [...(row.later_completion_sequences ?? [])],
    compactedThrough: row.compacted_through,
    detailExpired: row.detail_expired,
    lastReceivedUs: microsFromSql(row.last_received_us),
    nowUs: microsFromSql(row.now_us),
    idleMs: row.idle_ms === null ? null : Number(row.idle_ms),
    // Changes decided by this batch, applied by UPDATE_ATTEMPTS_SQL.
    setStart: null,
    setCompletion: null,
    recordCompletion: null,
    laterChanged: false,
    touched: false,
  }
}

/** The attempt row a new attempt is created from: the batch's level_start for
 * it if present, else its lowest-sequence event. An attempt runs within one
 * page load, so the build and platform that event reports hold for the whole
 * attempt. */
function creatingEvents(events, primaries) {
  const creators = new Map()
  for (const index of primaries) {
    const event = events[index]
    const current = creators.get(event.attemptId)
    if (!current ||
        (current.eventType !== 'level_start' && (event.eventType === 'level_start' || event.sequence < current.sequence))) {
      creators.set(event.attemptId, event)
    }
  }
  return creators
}

function byKey(values, key) {
  return [...values].sort((left, right) => (key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0))
}

/** Decide every event of one batch inside an open transaction. `query` is
 * withTransaction's statement runner. Returns one outcome per event. */
export async function writeBatch(query, events, config) {
  const outcomes = new Array(events.length).fill(null)

  // 1. Identity within the batch: the first copy of an id is decided against
  // the database; later copies follow it (same content) or conflict.
  const primaries = []
  const aliases = []
  const firstById = new Map()
  for (let index = 0; index < events.length; index++) {
    const first = firstById.get(events[index].eventId)
    if (first === undefined) {
      firstById.set(events[index].eventId, index)
      primaries.push(index)
    } else if (canonicalEventContent(events[first]) === canonicalEventContent(events[index])) {
      aliases.push([index, first])
    } else {
      outcomes[index] = rejected('id_conflict')
    }
  }

  // 2. Users, once each, sorted.
  const users = new Map()
  for (const index of primaries) {
    const { userId, clientTsUs } = events[index]
    const seen = users.get(userId)
    users.set(userId, seen
      ? { first: Math.min(seen.first, clientTsUs), last: Math.max(seen.last, clientTsUs) }
      : { first: clientTsUs, last: clientTsUs })
  }
  const userIds = [...users.keys()].sort()
  await query(UPSERT_USERS_SQL, [userIds, userIds.map(id => users.get(id).first), userIds.map(id => users.get(id).last),
    config.lastSeenResolutionMs])

  // 3. Attempts, once each, sorted. Start/completion identity is recorded later,
  // after its checks, so a reused id can never abort the batch on a unique index.
  const creators = byKey(creatingEvents(events, primaries).values(), event => event.attemptId)
  await query(ATTEMPTS_SQL, [
    creators.map(event => event.attemptId), creators.map(event => event.userId), creators.map(event => event.gameId),
    creators.map(event => event.worldId), creators.map(event => event.levelId), creators.map(event => event.mode),
    creators.map(event => event.clientTsUs), creators.map(event => rowAttributes(event)),
  ])

  // 4. Lock every attempt of the batch in a consistent order.
  const attemptIds = creators.map(event => event.attemptId)
  const withStart = new Set()
  const withCompletion = new Set()
  for (const index of primaries) {
    if (events[index].eventType === 'level_start') withStart.add(events[index].attemptId)
    if (events[index].eventType === 'level_complete') withCompletion.add(events[index].attemptId)
  }
  const lateLimitMs = config.lateEventMaxAgeDays == null ? null : config.lateEventMaxAgeDays * 86400000
  const locked = await query(LOCK_SQL, [attemptIds, [...withStart], [...withCompletion], lateLimitMs !== null])
  const attempts = new Map(locked.rows.map(row => [row.attempt_id, attemptState(row)]))

  // 5. One identity lookup for the whole batch.
  const pairs = primaries.map(index => events[index])
  const covered = pairs.filter(event => {
    const through = attempts.get(event.attemptId)?.compactedThrough
    return through != null && event.sequence <= through
  })
  const lookup = await query(LOOKUP_SQL, [
    pairs.map(event => event.eventId),
    pairs.map(event => event.attemptId), pairs.map(event => event.sequence),
    covered.map(event => event.attemptId), covered.map(event => event.sequence),
  ])

  const steps = new Map()        // event id → stored step (live or compacted)
  const occupied = new Map()     // attempt#sequence → { eventId, step? }
  const starts = new Map()       // event id → attempt id
  const completions = new Map()  // event id → attempt id
  const foreign = new Set()      // ids held by a chunk of an attempt outside this batch
  const chunkIds = new Set()
  for (const attempt of attempts.values()) {
    if (attempt.startEventId) occupied.set(slot(attempt.attemptId, attempt.startSequence), { eventId: attempt.startEventId })
    if (attempt.completionEventId && attempt.completionSequence !== null) {
      occupied.set(slot(attempt.attemptId, attempt.completionSequence), { eventId: attempt.completionEventId })
    }
    for (const sequence of attempt.later) occupied.set(slot(attempt.attemptId, sequence), { eventId: null })
  }
  for (const row of lookup.rows) {
    if (row.kind === 'step') {
      const step = storedStep(row)
      steps.set(step.eventId, step)
      occupied.set(slot(step.attemptId, step.sequence), { eventId: step.eventId, step })
    } else if (row.kind === 'start') {
      starts.set(row.event_id, row.attempt_id)
    } else if (row.kind === 'completion') {
      completions.set(row.event_id, row.attempt_id)
    } else if (attempts.has(row.attempt_id)) {
      chunkIds.add(String(row.chunk_id))
    } else {
      for (const id of row.matched ?? []) foreign.add(id)
    }
  }

  // 5b. Compacted steps: decode only the chunks covering this batch's attempts,
  // within the codec's limits.
  if (chunkIds.size > 0) {
    const chunks = await query(CHUNKS_SQL, [[...chunkIds]])
    for (const chunk of chunks.rows) {
      let actions
      try {
        actions = decodeChunk(chunk.payload, {
          format: chunk.format, codec: chunk.codec, attemptId: chunk.attempt_id, eventCount: chunk.event_count,
          seqFirst: chunk.seq_first, seqLast: chunk.seq_last, uncompressedBytes: chunk.uncompressed_bytes,
          checksum: chunk.checksum,
        }, DEFAULT_LIMITS)
      } catch (error) {
        throw new ChunkUnavailableError(String(chunk.chunk_id), error.code ?? 'corrupt_chunk')
      }
      for (const action of actions) {
        const step = { ...action, attemptId: chunk.attempt_id }
        if (!steps.has(step.eventId)) steps.set(step.eventId, step)
        occupied.set(slot(step.attemptId, step.sequence), { eventId: step.eventId, step })
      }
    }
  }

  // 6. Decide in batch order.
  const inserts = []
  for (const index of primaries) {
    const event = events[index]
    const attempt = attempts.get(event.attemptId)
    if (!attempt) throw raceError('attempt row missing after insert')
    const decided = decide(event, attempt, { steps, occupied, starts, completions, foreign, lateLimitMs })
    if (decided === 'insert') inserts.push(index)
    else outcomes[index] = decided
  }

  // 7. Insert new steps in one statement; anything not inserted lost a race
  // with a concurrent transaction and is decided again from committed rows.
  if (inserts.length > 0) {
    const rows = byKey(inserts.map(index => events[index]), event => event.eventId)
    const result = await query(INSERT_STEPS_SQL, [
      rows.map(event => event.eventId), rows.map(event => event.attemptId), rows.map(event => event.sequence),
      rows.map(event => event.clientTsUs), rows.map(event => event.elapsedMs), rows.map(event => event.stepType),
      rows.map(event => event.command), rows.map(event => event.fromLine), rows.map(event => event.removedLines),
      rows.map(event => JSON.stringify(event.stepAttributes ?? {})),
    ])
    const inserted = new Set(result.rows.map(row => row.event_id))
    const unresolved = []
    for (const index of inserts) {
      if (inserted.has(events[index].eventId)) {
        outcomes[index] = accepted()
        attempts.get(events[index].attemptId).touched = true
      } else {
        unresolved.push(index)
      }
    }
    if (unresolved.length > 0) await recheck(query, events, unresolved, outcomes)
  }

  // 8. Apply start/completion/receipt changes once per attempt.
  await updateAttempts(query, attempts, config)

  for (const [index, first] of aliases) {
    outcomes[index] = outcomes[first].status === 'rejected' ? outcomes[first] : duplicate()
  }
  return outcomes
}

/** An outcome, or 'insert' for a step to insert. Mutates `attempt` and
 * `occupied` for accepted starts/completions so later events of the same
 * batch see them. */
function decide(event, attempt, { steps, occupied, starts, completions, foreign, lateLimitMs }) {
  if (!sameContext(attempt, event)) return rejected('context_mismatch')

  const stored = steps.get(event.eventId)
  if (stored) {
    return event.eventType === 'proof_step' && stored.attemptId === event.attemptId && sameStep(stored, event)
      ? duplicate() : rejected('id_conflict')
  }
  if (foreign.has(event.eventId)) return rejected('id_conflict')
  if (starts.has(event.eventId)) {
    return event.eventType === 'level_start' && starts.get(event.eventId) === event.attemptId && sameStart(attempt, event)
      ? duplicate() : rejected('id_conflict')
  }
  if (completions.has(event.eventId)) {
    return event.eventType === 'level_complete' && completions.get(event.eventId) === event.attemptId &&
      attempt.completionSequence === event.sequence && sameCompletionContent(attempt, event)
      ? duplicate() : rejected('id_conflict')
  }

  if (lateLimitMs !== null && attempt.idleMs !== null && attempt.idleMs > lateLimitMs) return rejected('late_event')
  // Retention removed this attempt's step detail under an explicit policy; a
  // step now can only be a late retry of expired data, never new data.
  if (attempt.detailExpired && event.eventType === 'proof_step') return rejected('late_event')

  const key = slot(event.attemptId, event.sequence)
  const holder = occupied.get(key)
  if (event.eventType === 'proof_step') {
    if (holder) {
      // Same id at the same slot without a receipt: the chunk's receipts were
      // expired by policy, but (attempt, sequence) coverage still identifies it.
      if (holder.eventId === event.eventId && holder.step) return sameStep(holder.step, event) ? duplicate() : rejected('id_conflict')
      return rejected('sequence_conflict')
    }
    occupied.set(key, { eventId: event.eventId })
    return 'insert'
  }

  if (event.eventType === 'level_start') {
    if (attempt.startEventId) return rejected('start_conflict')
    if (attempt.initialScript !== null && attempt.initialScript !== event.initialScript) return rejected('start_conflict')
    if (attempt.sourceAttemptId !== null && attempt.sourceAttemptId !== event.sourceAttemptId) return rejected('start_conflict')
    if (holder) return rejected('sequence_conflict')
    Object.assign(attempt, {
      startEventId: event.eventId,
      startSequence: event.sequence,
      startTsUs: event.clientTsUs,
      startElapsedMs: event.elapsedMs,
      initialScript: attempt.initialScript ?? event.initialScript,
      sourceAttemptId: attempt.sourceAttemptId ?? event.sourceAttemptId,
      setStart: event,
      touched: true,
    })
    occupied.set(key, { eventId: event.eventId })
    return accepted()
  }

  // level_complete
  if (attempt.completed) {
    // A completion recorded before completion identities existed: an identical
    // retry is its duplicate, and from now on its identity.
    if (attempt.completionEventId === null && !holder && sameCompletionContent(attempt, event)) {
      Object.assign(attempt, { completionEventId: event.eventId, completionSequence: event.sequence, recordCompletion: event })
      occupied.set(key, { eventId: event.eventId })
      return duplicate()
    }
    if (!holder && !attempt.later.includes(event.sequence) && attempt.later.length < MAX_LATER_COMPLETIONS) {
      attempt.later.push(event.sequence)
      attempt.laterChanged = true
      occupied.set(key, { eventId: null })
    }
    return rejected('already_completed')
  }
  if (holder) return rejected('sequence_conflict')
  Object.assign(attempt, {
    completed: true,
    completionEventId: event.eventId,
    completionSequence: event.sequence,
    completedAtUs: event.clientTsUs,
    durationMs: event.elapsedMs,
    playScript: event.playScript,
    leanScript: event.leanScript,
    setCompletion: event,
    touched: true,
  })
  occupied.set(key, { eventId: event.eventId })
  return accepted()
}

/** Steps whose insert did nothing although no conflicting row was visible
 * under the lock: a concurrent transaction committed the same event id (for
 * another attempt) meanwhile. Decide them from the now-committed rows. */
async function recheck(query, events, indexes, outcomes) {
  const rows = indexes.map(index => events[index])
  const result = await query(RECHECK_SQL, [rows.map(event => event.eventId), rows.map(event => event.attemptId),
    rows.map(event => event.sequence)])
  const byId = new Map()
  const bySlot = new Map()
  for (const row of result.rows) {
    const step = storedStep(row)
    byId.set(step.eventId, step)
    bySlot.set(slot(step.attemptId, step.sequence), step)
  }
  for (const index of indexes) {
    const event = events[index]
    const stored = byId.get(event.eventId)
    if (stored) {
      outcomes[index] = stored.attemptId === event.attemptId && sameStep(stored, event) ? duplicate() : rejected('id_conflict')
    } else if (bySlot.has(slot(event.attemptId, event.sequence))) {
      outcomes[index] = rejected('sequence_conflict')
    } else {
      throw raceError('step neither inserted nor found')
    }
  }
}

async function updateAttempts(query, attempts, config) {
  const changed = [...attempts.values()].filter(attempt => {
    attempt.refresh = attempt.touched && (attempt.lastReceivedUs === null ||
      attempt.lastReceivedUs < attempt.nowUs - config.lastReceivedResolutionMs * 1000)
    return attempt.setStart || attempt.setCompletion || attempt.recordCompletion || attempt.laterChanged || attempt.refresh
  })
  if (changed.length === 0) return
  const column = pick => changed.map(pick)
  await query(UPDATE_ATTEMPTS_SQL, [
    column(attempt => attempt.attemptId),
    column(attempt => attempt.setStart?.eventId ?? null),
    column(attempt => attempt.setStart?.sequence ?? null),
    column(attempt => attempt.setStart?.clientTsUs ?? null),
    column(attempt => attempt.setStart?.elapsedMs ?? null),
    column(attempt => attempt.setStart?.initialScript ?? null),
    column(attempt => attempt.setStart?.sourceAttemptId ?? null),
    column(attempt => Boolean(attempt.setCompletion)),
    column(attempt => attempt.setCompletion?.clientTsUs ?? null),
    column(attempt => attempt.setCompletion?.elapsedMs ?? null),
    column(attempt => attempt.setCompletion?.playScript ?? null),
    column(attempt => attempt.setCompletion?.leanScript ?? null),
    column(attempt => (attempt.setCompletion ?? attempt.recordCompletion)?.eventId ?? null),
    column(attempt => (attempt.setCompletion ?? attempt.recordCompletion)?.sequence ?? null),
    column(attempt => (attempt.laterChanged ? `{${attempt.later.join(',')}}` : null)),
    column(attempt => attempt.refresh),
  ])
}

/** createWriter({ database, config, metrics }) → { writeEvents, storeFeedback }.
 *
 * writeEvents(events, { signal }) resolves with one outcome per validated
 * event, `{ status: 'accepted' | 'duplicate' | 'rejected', reason? }`, only
 * after COMMIT; it rejects (nothing acknowledged) when the transaction fails.
 * A deadlock, serialization failure or unique race is retried once at once.
 * A PostgreSQL data exception (22xxx) should be unreachable after
 * validation; if it happens, each event is retried alone so that only the
 * offending one is rejected (invalid_event) instead of the whole batch. */
export function createWriter({ database, config, metrics = null }) {
  async function once(events, signal) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await database.withTransaction(query => writeBatch(query, events, config), { signal })
      } catch (error) {
        if (attempt > 0 || !transientConflict(error) || signal?.aborted) throw error
      }
    }
  }

  async function writeEvents(events, { signal } = {}) {
    if (events.length === 0) return []
    if (signal?.aborted) throw abortErrorFrom(signal)
    metrics?.batchEvents.observe(events.length)
    try {
      return await once(events, signal)
    } catch (error) {
      if (databaseErrorClass(error) !== 'data') throw error
      if (events.length === 1) return [rejected('invalid_event')]
    }
    const outcomes = []
    for (const event of events) {
      try {
        outcomes.push((await once([event], signal))[0])
      } catch (error) {
        if (databaseErrorClass(error) !== 'data') throw error
        outcomes.push(rejected('invalid_event'))
      }
    }
    return outcomes
  }

  return {
    writeEvents,
    storeFeedback: (feedback, options) => database.storeFeedback(feedback, options),
  }
}
