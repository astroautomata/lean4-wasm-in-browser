/** Strict validation of client submissions (docs/protocol.md).
 *
 * Every value that reaches SQL is checked here first, so a bad client field
 * becomes a terminal per-event rejection instead of a failed transaction that
 * the client would retry forever. Nothing is truncated or coerced: a value is
 * stored exactly as sent, or rejected with a reason from REASONS. */

export const REASONS = Object.freeze([
  'invalid_event', 'invalid_uuid', 'invalid_type', 'invalid_context', 'invalid_sequence',
  'invalid_timestamp', 'invalid_text', 'invalid_step', 'script_too_large',
  'context_mismatch', 'id_conflict', 'sequence_conflict', 'start_conflict', 'already_completed', 'late_event',
])

export const LIMITS = Object.freeze({
  // Ceilings in UTF-16 code units, unchanged from the original collector until
  // byte sizes are measured (tools/storage-report.js).
  scriptLength: 262144,
  commandLength: 65536,
  messageLength: 1000,
  pathLength: 160,
  levelId: 100000,
  sequence: 1000000,
  editLines: 1000000,
  elapsedMs: 2147483647,
  timestampLength: 40,
  proofStateDepth: 64,
  proofStateNodes: 50000,
  proofStateBytes: 262144,
  clientHealthValue: 1000000000,
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]{1,80}$/u
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:(Z)|([+-])(\d{2}):(\d{2}))$/u
const MODES = new Set(['visual', 'classic'])
const EVENT_TYPES = new Set(['level_start', 'proof_step', 'level_complete'])
const STEP_TYPES = new Set(['command', 'undo', 'reset', 'edit'])
const BUILD_REVISION_KEYS = ['site', 'client', 'runtime', 'nng4', 'visualtest', 'lean']
const BUILD_REVISION_RE = /^[0-9a-f]{7,40}(?:-dirty)?$/u
const CLIENT_HEALTH_KEYS = ['queue_events', 'queue_bytes', 'evicted', 'expired', 'oversize', 'rejected', 'retries', 'sent']
const BROWSERS = new Set(['chrome', 'safari', 'firefox', 'edge', 'brave', 'samsung', 'opera', 'unknown'])
const DEVICES = new Set(['mobile', 'desktop'])

// Client timestamps must fall in [2000-01-01, 2100-01-01): wide enough for any
// real clock, narrow enough to stay far inside PostgreSQL's timestamptz range.
const MIN_TS_US = Date.UTC(2000, 0, 1) * 1000
const MAX_TS_US = Date.UTC(2100, 0, 1) * 1000

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A UUID string normalised to lowercase, or null. Non-strings are refused
 * before any RegExp sees them: RegExp.test(['<uuid>']) coerces the array to
 * its string and would accept it. */
export function uuid(value) {
  return typeof value === 'string' && UUID_RE.test(value) ? value.toLowerCase() : null
}

function integerIn(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max
}

function safePath(value, allowSlash) {
  if (typeof value !== 'string' || value.length > LIMITS.pathLength) return false
  const segments = allowSlash ? value.split('/') : [value]
  return segments.every(segment => segment !== '.' && segment !== '..' && SAFE_SEGMENT_RE.test(segment))
}

/** null when `value` is storable text, otherwise the rejection reason. PostgreSQL
 * text cannot hold U+0000, and a lone surrogate would be silently replaced by
 * U+FFFD when encoded as UTF-8, so both are refused rather than altered. */
export function textProblem(value, maxLength) {
  if (typeof value !== 'string') return 'invalid_type'
  if (value.length > maxLength) return 'script_too_large'
  if (value.includes('\u0000') || !value.isWellFormed()) return 'invalid_text'
  return null
}

/** Optional text: absent or null → null; otherwise it must pass textProblem. */
function optionalText(value, maxLength) {
  if (value === undefined || value === null) return { value: null }
  const problem = textProblem(value, maxLength)
  return problem ? { problem } : { value }
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Exact integer microseconds since the epoch for an RFC 3339 timestamp
 * `YYYY-MM-DDTHH:MM:SS[.ffffff](Z|±HH:MM)`, or null. The fraction is read digit
 * by digit; Date would round it to milliseconds. */
export function parseTimestamp(value) {
  if (typeof value !== 'string' || value.length > LIMITS.timestampLength) return null
  const match = TIMESTAMP_RE.exec(value)
  if (!match) return null
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, zulu, sign, offsetHourText, offsetMinuteText] = match
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number)
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null
  if (hour > 23 || minute > 59 || second > 59) return null
  let micros = Date.UTC(year, month - 1, day, hour, minute, second) * 1000 + Number((fraction ?? '').padEnd(6, '0'))
  if (!zulu) {
    const offsetHours = Number(offsetHourText)
    const offsetMinutes = Number(offsetMinuteText)
    if (offsetHours > 23 || offsetMinutes > 59) return null
    micros -= (sign === '+' ? 1 : -1) * (offsetHours * 60 + offsetMinutes) * 60000000
  }
  return micros >= MIN_TS_US && micros < MAX_TS_US ? micros : null
}

/** The game build a client reports (lean4.js scripts/sync-lean4game-client.mjs):
 * source revisions plus the build time. Only known, well-formed entries are
 * kept; a malformed build never costs the event itself. */
export function validateBuild(value) {
  if (!isPlainObject(value)) return null
  const build = {}
  for (const key of BUILD_REVISION_KEYS) {
    if (typeof value[key] === 'string' && BUILD_REVISION_RE.test(value[key])) build[key] = value[key]
  }
  if (typeof value.built === 'string' && value.built.length <= 32 && Number.isFinite(Date.parse(value.built))) {
    build.built = value.built
  }
  return Object.keys(build).length > 0 ? build : null
}

/** The coarse platform a client reports: a browser family and whether the
 * device is a phone/tablet or a computer. Anything outside those fixed lists
 * is dropped, so free text such as a user-agent string is never stored; like
 * the build, a malformed platform never costs the event itself. */
export function validatePlatform(value) {
  if (!isPlainObject(value)) return null
  const platform = {}
  if (typeof value.browser === 'string' && BROWSERS.has(value.browser)) platform.browser = value.browser
  if (typeof value.device === 'string' && DEVICES.has(value.device)) platform.device = value.device
  return Object.keys(platform).length > 0 ? platform : null
}

function context(value) {
  if (!MODES.has(value.mode)) return null
  if (!safePath(value.game_id, true) || !safePath(value.world_id, false)) return null
  if (!integerIn(value.level_id, 0, LIMITS.levelId)) return null
  return { mode: value.mode, gameId: value.game_id, worldId: value.world_id, levelId: value.level_id }
}

/** Fields of each event type. Fields that do not belong to the type are
 * cleared to null rather than stored. */
function typeFields(value) {
  const fields = {
    stepType: null, command: null, fromLine: null, removedLines: null,
    initialScript: null, sourceAttemptId: null, playScript: null, leanScript: null,
  }
  if (value.event_type === 'level_start') {
    const initial = optionalText(value.initial_script, LIMITS.scriptLength)
    if (initial.problem) return { problem: initial.problem }
    fields.initialScript = initial.value
    if (value.source_attempt_uuid !== undefined && value.source_attempt_uuid !== null) {
      fields.sourceAttemptId = uuid(value.source_attempt_uuid)
      if (!fields.sourceAttemptId) return { problem: 'invalid_uuid' }
    }
  } else if (value.event_type === 'proof_step') {
    if (!STEP_TYPES.has(value.step_type)) return { problem: 'invalid_step' }
    fields.stepType = value.step_type
    if (value.command === undefined || value.command === null) return { problem: 'invalid_step' }
    const problem = textProblem(value.command, LIMITS.commandLength)
    if (problem) return { problem }
    fields.command = value.command
    if (fields.stepType === 'edit') {
      if (!integerIn(value.from_line, 0, LIMITS.editLines) || !integerIn(value.removed_lines, 0, LIMITS.editLines)) {
        return { problem: 'invalid_step' }
      }
      fields.fromLine = value.from_line
      fields.removedLines = value.removed_lines
    }
  } else {
    const play = optionalText(value.play_script, LIMITS.scriptLength)
    if (play.problem) return { problem: play.problem }
    const lean = optionalText(value.lean_script, LIMITS.scriptLength)
    if (lean.problem) return { problem: lean.problem }
    fields.playScript = play.value
    fields.leanScript = lean.value
  }
  return { fields }
}

/** `{ ok: true, event }` or `{ ok: false, reason, eventId }`; eventId is the
 * normalised id when the id itself was valid, so a v2 result can name it. */
export function validateEvent(value) {
  if (!isPlainObject(value)) return { ok: false, reason: 'invalid_event', eventId: null }
  const eventId = uuid(value.event_id)
  if (!eventId) return { ok: false, reason: 'invalid_uuid', eventId: null }
  const reject = reason => ({ ok: false, reason, eventId })
  const userId = uuid(value.user_uuid)
  const attemptId = uuid(value.attempt_uuid)
  if (!userId || !attemptId) return reject('invalid_uuid')
  if (!EVENT_TYPES.has(value.event_type)) return reject('invalid_event')
  const where = context(value)
  if (!where) return reject('invalid_context')
  if (!integerIn(value.sequence, 0, LIMITS.sequence)) return reject('invalid_sequence')
  if (!integerIn(value.elapsed_ms, 0, LIMITS.elapsedMs)) return reject('invalid_timestamp')
  const clientTsUs = parseTimestamp(value.ts)
  if (clientTsUs === null) return reject('invalid_timestamp')
  const typed = typeFields(value)
  if (typed.problem) return reject(typed.problem)
  return {
    ok: true,
    event: {
      eventId,
      userId,
      attemptId,
      eventType: value.event_type,
      ...where,
      sequence: value.sequence,
      elapsedMs: value.elapsed_ms,
      clientTsUs,
      ...typed.fields,
      build: validateBuild(value.build),
      platform: validatePlatform(value.platform),
    },
  }
}

/** The client-supplied content that defines an event's identity: everything
 * but the build and platform attributes (docs/replay-contract.md). Two events with the same
 * id are duplicates exactly when these strings are equal. */
export function canonicalEventContent(event) {
  return JSON.stringify([
    event.eventType, event.attemptId, event.userId, event.gameId, event.worldId, event.levelId, event.mode,
    event.sequence, event.clientTsUs, event.elapsedMs, event.stepType, event.command, event.fromLine,
    event.removedLines, event.initialScript, event.sourceAttemptId, event.playScript, event.leanScript,
  ])
}

/** Optional low-volume client queue statistics. Never a reason to refuse the
 * request: unknown keys and invalid values are ignored. */
export function validateClientHealth(value) {
  if (!isPlainObject(value)) return null
  const health = {}
  for (const key of CLIENT_HEALTH_KEYS) {
    if (integerIn(value[key], 0, LIMITS.clientHealthValue)) health[key] = value[key]
  }
  return Object.keys(health).length > 0 ? health : null
}

/** `{ ok: true, events, clientHealth }` or `{ ok: false, reason: 'invalid_envelope' }`.
 * Individual events are validated separately so one bad event cannot refuse
 * the others. */
export function validateEnvelope(body, { maxEvents = 50 } = {}) {
  if (!isPlainObject(body) || !Array.isArray(body.events) || body.events.length < 1 || body.events.length > maxEvents) {
    return { ok: false, reason: 'invalid_envelope' }
  }
  const client = isPlainObject(body.client) ? body.client : null
  return { ok: true, events: body.events, clientHealth: client ? validateClientHealth(client.health) : null }
}

/** null when `value` is an acceptable proof_state, otherwise the reason. The
 * walk is iterative and stops at the first violation, so hostile nesting
 * cannot exhaust the stack. */
function proofStateProblem(value) {
  if (!isPlainObject(value)) return 'invalid_type'
  const stack = [[value, 1]]
  let nodes = 0
  while (stack.length > 0) {
    const [node, depth] = stack.pop()
    if (++nodes > LIMITS.proofStateNodes) return 'script_too_large'
    if (typeof node === 'string') {
      if (node.includes('\u0000') || !node.isWellFormed()) return 'invalid_text'
    } else if (typeof node === 'number') {
      if (!Number.isFinite(node)) return 'invalid_type'
    } else if (node !== null && typeof node === 'object') {
      if (depth > LIMITS.proofStateDepth) return 'script_too_large'
      if (Array.isArray(node)) {
        for (const item of node) stack.push([item, depth + 1])
      } else {
        for (const [key, item] of Object.entries(node)) {
          if (key.includes('\u0000') || !key.isWellFormed()) return 'invalid_text'
          stack.push([item, depth + 1])
        }
      }
    } else if (node !== null && typeof node !== 'boolean') {
      // null and booleans are ordinary JSON values (an unset field is null).
      return 'invalid_type'
    }
  }
  return Buffer.byteLength(JSON.stringify(value), 'utf8') > LIMITS.proofStateBytes ? 'script_too_large' : null
}

/** `{ ok: true, feedback }` or `{ ok: false, reason }`. */
export function validateFeedback(value) {
  if (!isPlainObject(value)) return { ok: false, reason: 'invalid_event' }
  const reportId = uuid(value.report_id)
  if (!reportId) return { ok: false, reason: 'invalid_uuid' }
  let userId = null
  if (value.user_uuid !== undefined && value.user_uuid !== null) {
    userId = uuid(value.user_uuid)
    if (!userId) return { ok: false, reason: 'invalid_uuid' }
  }
  const where = context(value)
  if (!where) return { ok: false, reason: 'invalid_context' }
  const clientTsUs = parseTimestamp(value.ts)
  if (clientTsUs === null) return { ok: false, reason: 'invalid_timestamp' }
  if (typeof value.message !== 'string') return { ok: false, reason: 'invalid_type' }
  const message = value.message.trim()
  if (!message || message.length > LIMITS.messageLength) return { ok: false, reason: 'invalid_text' }
  const messageProblem = textProblem(message, LIMITS.messageLength)
  if (messageProblem) return { ok: false, reason: messageProblem }
  const stateProblem = proofStateProblem(value.proof_state)
  if (stateProblem) return { ok: false, reason: stateProblem }
  return {
    ok: true,
    feedback: {
      reportId,
      userId,
      ...where,
      message,
      proofState: value.proof_state,
      clientTsUs,
      build: validateBuild(value.build),
      platform: validatePlatform(value.platform),
    },
  }
}
