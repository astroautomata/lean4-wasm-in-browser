const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]{1,80}$/u
const MODES = new Set(['visual', 'classic'])
const EVENT_TYPES = new Set(['level_start', 'proof_step', 'level_complete'])
const STEP_TYPES = new Set(['command', 'undo', 'reset', 'edit'])
const BUILD_REVISION_KEYS = ['site', 'client', 'runtime', 'nng4', 'visualtest', 'lean']
const BUILD_REVISION_RE = /^[0-9a-f]{7,40}(?:-dirty)?$/u

function text(value, maximum) {
  return typeof value === 'string' ? value.slice(0, maximum) : null
}

/** The game build a client reports (lean4.js scripts/sync-lean4game-client.mjs):
 * source revisions plus the build time. Only known, well-formed entries are
 * kept; a malformed build never costs the event itself. */
export function validateBuild(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const build = {}
  for (const key of BUILD_REVISION_KEYS) {
    if (typeof value[key] === 'string' && BUILD_REVISION_RE.test(value[key])) build[key] = value[key]
  }
  if (typeof value.built === 'string' && value.built.length <= 32 && Number.isFinite(Date.parse(value.built))) {
    build.built = value.built
  }
  return Object.keys(build).length > 0 ? build : null
}

function safePath(value, allowSlash) {
  if (typeof value !== 'string' || value.length > 160) return false
  const segments = allowSlash ? value.split('/') : [value]
  return segments.length > 0 && segments.every(segment =>
    segment !== '.' && segment !== '..' && SAFE_SEGMENT_RE.test(segment))
}

export function validateEvent(value) {
  if (!value || typeof value !== 'object') return null
  if (!UUID_RE.test(value.event_id) || !UUID_RE.test(value.user_uuid) || !UUID_RE.test(value.attempt_uuid)) return null
  if (!EVENT_TYPES.has(value.event_type) || !MODES.has(value.mode)) return null
  if (!safePath(value.game_id, true) || !safePath(value.world_id, false)) return null
  if (!Number.isInteger(value.level_id) || value.level_id < 0 || value.level_id > 100000) return null
  if (!Number.isInteger(value.sequence) || value.sequence < 0 || value.sequence > 1000000) return null
  if (!Number.isInteger(value.elapsed_ms) || value.elapsed_ms < 0 || value.elapsed_ms > 2147483647) return null
  if (typeof value.ts !== 'string' || !Number.isFinite(Date.parse(value.ts))) return null
  if (value.source_attempt_uuid != null && !UUID_RE.test(value.source_attempt_uuid)) return null

  const event = {
    eventId: value.event_id,
    userId: value.user_uuid,
    attemptId: value.attempt_uuid,
    sourceAttemptId: value.source_attempt_uuid ?? null,
    eventType: value.event_type,
    mode: value.mode,
    gameId: value.game_id,
    worldId: value.world_id,
    levelId: value.level_id,
    sequence: value.sequence,
    elapsedMs: value.elapsed_ms,
    clientTs: new Date(value.ts),
    initialScript: text(value.initial_script, 256 * 1024),
    playScript: text(value.play_script, 256 * 1024),
    leanScript: text(value.lean_script, 256 * 1024),
    stepType: value.step_type ?? null,
    command: text(value.command, 64 * 1024),
    fromLine: value.from_line ?? null,
    removedLines: value.removed_lines ?? null,
    build: validateBuild(value.build),
  }

  if (event.eventType === 'proof_step') {
    if (!STEP_TYPES.has(event.stepType) || event.command == null) return null
    if (event.stepType === 'edit') {
      if (!Number.isInteger(event.fromLine) || event.fromLine < 0) return null
      if (!Number.isInteger(event.removedLines) || event.removedLines < 0) return null
    }
  }
  return event
}

export function validateBatch(body) {
  if (!body || !Array.isArray(body.events) || body.events.length < 1 || body.events.length > 50) return null
  const events = body.events.map(validateEvent)
  return events.every(Boolean) ? events : null
}

export function validateFeedback(value) {
  if (!value || typeof value !== 'object') return null
  if (!UUID_RE.test(value.report_id)) return null
  if (value.user_uuid != null && !UUID_RE.test(value.user_uuid)) return null
  if (!MODES.has(value.mode)) return null
  if (!safePath(value.game_id, true) || !safePath(value.world_id, false)) return null
  if (!Number.isInteger(value.level_id) || value.level_id < 0 || value.level_id > 100000) return null
  if (typeof value.ts !== 'string' || !Number.isFinite(Date.parse(value.ts))) return null
  if (typeof value.message !== 'string') return null
  const message = value.message.trim()
  if (!message || message.length > 1000) return null
  if (!value.proof_state || typeof value.proof_state !== 'object' || Array.isArray(value.proof_state)) return null
  let proofStateSize
  try { proofStateSize = Buffer.byteLength(JSON.stringify(value.proof_state), 'utf8') } catch { return null }
  if (proofStateSize > 256 * 1024) return null
  return {
    reportId: value.report_id,
    userId: value.user_uuid ?? null,
    gameId: value.game_id,
    worldId: value.world_id,
    levelId: value.level_id,
    mode: value.mode,
    message,
    proofState: value.proof_state,
    clientTs: new Date(value.ts),
    build: validateBuild(value.build),
  }
}
