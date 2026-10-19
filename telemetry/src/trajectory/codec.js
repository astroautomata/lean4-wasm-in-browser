import crypto from 'node:crypto'
import zlib from 'node:zlib'

/** lean-trajectory/1: a lossless, versioned encoding of a bounded, ordered set
 * of one attempt's proof steps (docs/trajectory-format.md).
 *
 * The uncompressed form is UTF-8 JSON:
 *
 *   {"format":"lean-trajectory/1","attempt_id":"<uuid>","count":N,
 *    "columns":[...COLUMNS],
 *    "base":{"sequence":S,"elapsed_ms":E,"client_ts_us":C,"received_at_us":R|null},
 *    "rows":[[d_sequence, d_elapsed_ms, type, command, from_line, removed_lines,
 *             event_id_hex, d_client_ts_us, d_received_at_us|null, attributes|0], ...]}
 *
 * Each d_ column is the difference from the previous row (the first row from
 * `base`), so the first row's deltas are 0. d_received_at_us is null for a row
 * whose received_at is NULL (ingested before migration 005) and otherwise the
 * difference from the previous non-null received_at (initially base). `type`
 * is a STEP_TYPE_CODES number; attributes `{}` are written as 0. Event ids are
 * 32 lowercase hex digits. Timestamps are integer microseconds since the Unix
 * epoch, PostgreSQL's own timestamptz resolution, so nothing is rounded.
 *
 * The stored payload is gzip of those bytes; the manifest (trajectory_chunks
 * columns) records format, codec, attempt, count, sequence range, the
 * uncompressed length and its sha256. Decoding verifies all of them and never
 * inflates beyond the declared length. */

export const FORMAT = 'lean-trajectory/1'
export const CODEC = 'gzip'
export const COLUMNS = Object.freeze(['sequence', 'elapsed_ms', 'step_type', 'command', 'from_line',
  'removed_lines', 'event_id', 'client_ts_us', 'received_at_us', 'attributes'])
export const STEP_TYPE_CODES = Object.freeze({ command: 0, undo: 1, edit: 2, reset: 3, rejected: 4, view: 5 })
const STEP_TYPES = Object.freeze(Object.fromEntries(Object.entries(STEP_TYPE_CODES).map(([name, code]) => [code, name])))

export const DEFAULT_LIMITS = Object.freeze({
  maxEvents: 2000,
  maxUncompressedBytes: 4 * 1024 * 1024,
  maxCompressedBytes: 4 * 1024 * 1024,
})

const INT32_MAX = 2147483647
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const HEX32_RE = /^[0-9a-f]{32}$/u

export class TrajectoryFormatError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function fail(code, message) {
  throw new TrajectoryFormatError(code, message)
}

function isInt32(value, min = 0) {
  return Number.isInteger(value) && value >= min && value <= INT32_MAX
}

function isMicros(value) {
  return Number.isSafeInteger(value)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function uuidToHex(uuid) {
  return uuid.replaceAll('-', '')
}

function hexToUuid(hex) {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Validate one action in the canonical decoded form (the replay contract unit,
 * docs/replay-contract.md):
 *   { eventId, sequence, clientTsUs, elapsedMs, stepType, command,
 *     fromLine, removedLines, attributes, receivedAtUs } */
export function validateAction(action) {
  if (!isPlainObject(action)) fail('invalid_action', 'action must be an object')
  if (typeof action.eventId !== 'string' || !UUID_RE.test(action.eventId)) fail('invalid_action', 'eventId must be a lowercase uuid')
  if (!isInt32(action.sequence)) fail('invalid_action', 'sequence must be a non-negative int32')
  if (!isInt32(action.elapsedMs)) fail('invalid_action', 'elapsedMs must be a non-negative int32')
  if (!(action.stepType in STEP_TYPE_CODES)) fail('invalid_action', 'unknown stepType')
  if (typeof action.command !== 'string') fail('invalid_action', 'command must be a string')
  if (action.fromLine !== null && !isInt32(action.fromLine)) fail('invalid_action', 'fromLine must be null or an int32')
  if (action.removedLines !== null && !isInt32(action.removedLines)) fail('invalid_action', 'removedLines must be null or an int32')
  if (!isMicros(action.clientTsUs)) fail('invalid_action', 'clientTsUs must be integer microseconds')
  if (action.receivedAtUs !== null && !isMicros(action.receivedAtUs)) fail('invalid_action', 'receivedAtUs must be null or integer microseconds')
  if (!isPlainObject(action.attributes)) fail('invalid_action', 'attributes must be an object')
}

/** Encode actions of one attempt, strictly increasing by sequence. Returns the
 * compressed payload and the manifest fields to store beside it. */
export function encodeChunk({ attemptId, actions }, limits = DEFAULT_LIMITS) {
  if (typeof attemptId !== 'string' || !UUID_RE.test(attemptId)) fail('invalid_chunk', 'attemptId must be a lowercase uuid')
  if (!Array.isArray(actions) || actions.length === 0) fail('invalid_chunk', 'a chunk needs at least one action')
  if (actions.length > limits.maxEvents) fail('chunk_too_large', `a chunk holds at most ${limits.maxEvents} actions`)
  for (const action of actions) validateAction(action)
  for (let index = 1; index < actions.length; index++) {
    if (actions[index].sequence <= actions[index - 1].sequence) fail('invalid_chunk', 'sequences must be strictly increasing')
  }

  const first = actions[0]
  const firstReceived = actions.find(action => action.receivedAtUs !== null)?.receivedAtUs ?? null
  const base = {
    sequence: first.sequence,
    elapsed_ms: first.elapsedMs,
    client_ts_us: first.clientTsUs,
    received_at_us: firstReceived,
  }
  let previous = { sequence: base.sequence, elapsed: base.elapsed_ms, client: base.client_ts_us, received: base.received_at_us }
  const rows = actions.map(action => {
    let receivedDelta = null
    if (action.receivedAtUs !== null) {
      receivedDelta = action.receivedAtUs - previous.received
      previous.received = action.receivedAtUs
    }
    const row = [
      action.sequence - previous.sequence,
      action.elapsedMs - previous.elapsed,
      STEP_TYPE_CODES[action.stepType],
      action.command,
      action.fromLine,
      action.removedLines,
      uuidToHex(action.eventId),
      action.clientTsUs - previous.client,
      receivedDelta,
      Object.keys(action.attributes).length === 0 ? 0 : action.attributes,
    ]
    previous = { ...previous, sequence: action.sequence, elapsed: action.elapsedMs, client: action.clientTsUs }
    return row
  })
  const document = { format: FORMAT, attempt_id: attemptId, count: actions.length, columns: COLUMNS, base, rows }
  const uncompressed = Buffer.from(JSON.stringify(document), 'utf8')
  if (uncompressed.byteLength > limits.maxUncompressedBytes) {
    fail('chunk_too_large', `encoded chunk exceeds ${limits.maxUncompressedBytes} bytes`)
  }
  const payload = zlib.gzipSync(uncompressed, { level: 9 })
  if (payload.byteLength > limits.maxCompressedBytes) fail('chunk_too_large', 'compressed chunk too large')
  const receivedTimes = actions.map(action => action.receivedAtUs).filter(value => value !== null)
  return {
    format: FORMAT,
    codec: CODEC,
    attemptId,
    payload,
    eventCount: actions.length,
    seqFirst: first.sequence,
    seqLast: actions.at(-1).sequence,
    uncompressedBytes: uncompressed.byteLength,
    compressedBytes: payload.byteLength,
    checksum: crypto.createHash('sha256').update(uncompressed).digest(),
    eventIds: actions.map(action => action.eventId),
    minSourceReceivedAtUs: receivedTimes.length > 0 ? Math.min(...receivedTimes) : null,
    maxSourceReceivedAtUs: receivedTimes.length > 0 ? Math.max(...receivedTimes) : null,
    historicSources: receivedTimes.length < actions.length,
  }
}

/** Decode and fully verify a stored chunk against its manifest:
 *   { format, codec, attemptId, eventCount, seqFirst, seqLast,
 *     uncompressedBytes, checksum (Buffer) }
 * Throws TrajectoryFormatError; never inflates past the declared length or
 * the limits. Returns actions in the canonical form, ordered by sequence. */
export function decodeChunk(payload, manifest, limits = DEFAULT_LIMITS) {
  if (manifest.format !== FORMAT) fail('unsupported_format', `unsupported trajectory format ${manifest.format}`)
  if (manifest.codec !== CODEC) fail('unsupported_codec', `unsupported trajectory codec ${manifest.codec}`)
  if (!Buffer.isBuffer(payload)) fail('corrupt_chunk', 'payload must be bytes')
  if (payload.byteLength > limits.maxCompressedBytes) fail('chunk_too_large', 'compressed chunk too large')
  if (!isInt32(manifest.uncompressedBytes, 1) || manifest.uncompressedBytes > limits.maxUncompressedBytes) {
    fail('chunk_too_large', 'declared uncompressed size out of bounds')
  }
  if (!isInt32(manifest.eventCount, 1) || manifest.eventCount > limits.maxEvents) {
    fail('chunk_too_large', 'declared event count out of bounds')
  }
  let uncompressed
  try {
    uncompressed = zlib.gunzipSync(payload, { maxOutputLength: manifest.uncompressedBytes })
  } catch (error) {
    fail(error instanceof RangeError || error.code === 'ERR_BUFFER_TOO_LARGE' ? 'chunk_too_large' : 'corrupt_chunk',
      'payload does not inflate within its declared size')
  }
  if (uncompressed.byteLength !== manifest.uncompressedBytes) fail('corrupt_chunk', 'uncompressed length mismatch')
  const checksum = crypto.createHash('sha256').update(uncompressed).digest()
  if (!Buffer.isBuffer(manifest.checksum) || !checksum.equals(manifest.checksum)) fail('corrupt_chunk', 'checksum mismatch')

  let document
  try {
    document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(uncompressed))
  } catch {
    fail('corrupt_chunk', 'payload is not UTF-8 JSON')
  }
  if (!isPlainObject(document) || document.format !== FORMAT) fail('corrupt_chunk', 'payload format mismatch')
  if (document.attempt_id !== manifest.attemptId) fail('corrupt_chunk', 'payload attempt mismatch')
  if (document.count !== manifest.eventCount || !Array.isArray(document.rows) || document.rows.length !== document.count) {
    fail('corrupt_chunk', 'event count mismatch')
  }
  if (!Array.isArray(document.columns) || document.columns.join() !== COLUMNS.join()) fail('corrupt_chunk', 'column list mismatch')
  const base = document.base
  if (!isPlainObject(base) || !isInt32(base.sequence) || !isInt32(base.elapsed_ms) || !isMicros(base.client_ts_us) ||
      (base.received_at_us !== null && !isMicros(base.received_at_us))) {
    fail('corrupt_chunk', 'invalid base')
  }

  let sequence = base.sequence
  let elapsed = base.elapsed_ms
  let client = base.client_ts_us
  let received = base.received_at_us
  const actions = document.rows.map((row, index) => {
    if (!Array.isArray(row) || row.length !== COLUMNS.length) fail('corrupt_chunk', `row ${index} malformed`)
    const [dSequence, dElapsed, type, command, fromLine, removedLines, eventHex, dClient, dReceived, attributes] = row
    if (!Number.isInteger(dSequence) || (index === 0 ? dSequence !== 0 : dSequence <= 0)) fail('corrupt_chunk', `row ${index} sequence`)
    if (!Number.isInteger(dElapsed) || !isMicros(dClient)) fail('corrupt_chunk', `row ${index} delta`)
    if (!(type in STEP_TYPES) || typeof command !== 'string') fail('corrupt_chunk', `row ${index} type or command`)
    if (typeof eventHex !== 'string' || !HEX32_RE.test(eventHex)) fail('corrupt_chunk', `row ${index} event id`)
    if (attributes !== 0 && !isPlainObject(attributes)) fail('corrupt_chunk', `row ${index} attributes`)
    if (dReceived !== null && (!isMicros(dReceived) || received === null)) fail('corrupt_chunk', `row ${index} received delta`)
    sequence += dSequence
    elapsed += dElapsed
    client += dClient
    if (dReceived !== null) received += dReceived
    const action = {
      eventId: hexToUuid(eventHex),
      sequence,
      clientTsUs: client,
      elapsedMs: elapsed,
      stepType: STEP_TYPES[type],
      command,
      fromLine,
      removedLines,
      attributes: attributes === 0 ? {} : attributes,
      receivedAtUs: dReceived === null ? null : received,
    }
    try {
      validateAction(action)
    } catch {
      fail('corrupt_chunk', `row ${index} decodes to an invalid action`)
    }
    return action
  })
  if (actions[0].sequence !== manifest.seqFirst || actions.at(-1).sequence !== manifest.seqLast) {
    fail('corrupt_chunk', 'sequence range mismatch')
  }
  return actions
}

/** True when two actions carry the same client-supplied content: everything
 * but the server's receivedAtUs. A retry of a stored step must match this
 * exactly to be a duplicate; anything else under the same identity is a conflict. */
export function sameClientContent(left, right) {
  return left.eventId === right.eventId &&
    left.sequence === right.sequence &&
    left.clientTsUs === right.clientTsUs &&
    left.elapsedMs === right.elapsedMs &&
    left.stepType === right.stepType &&
    left.command === right.command &&
    left.fromLine === right.fromLine &&
    left.removedLines === right.removedLines &&
    canonicalJson(left.attributes) === canonicalJson(right.attributes)
}

/** True when two actions are identical in every replay-contract field,
 * including receivedAtUs. Compaction verification uses this. */
export function sameAction(left, right) {
  return sameClientContent(left, right) && left.receivedAtUs === right.receivedAtUs
}

/** JSON with object keys sorted, for content comparison independent of key order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** SQL expression selecting a timestamptz column as exact integer microseconds
 * since the epoch (node-postgres returns int8 as a string; see microsFromSql). */
export function sqlMicros(column) {
  return `(extract(epoch FROM ${column}) * 1000000)::bigint`
}

export function microsFromSql(value) {
  if (value === null || value === undefined) return null
  const micros = Number(value)
  if (!Number.isSafeInteger(micros)) throw new TrajectoryFormatError('invalid_timestamp', 'timestamp out of range')
  return micros
}

/** SQL expression turning an integer-microseconds parameter back into an exact timestamptz. */
export function sqlFromMicros(parameter) {
  return `(timestamptz 'epoch' + ${parameter}::bigint * interval '1 microsecond')`
}

/** PostgreSQL's text output for a timestamptz in UTC with DateStyle ISO, e.g.
 * `2026-08-04 12:00:00.123+00`, which the CSV machine export has always used. */
export function formatPgTimestamp(micros) {
  if (micros === null) return ''
  const milliseconds = Math.floor(micros / 1000)
  const fraction = ((micros % 1000000) + 1000000) % 1000000
  const iso = new Date(milliseconds).toISOString()
  const text = `${iso.slice(0, 10)} ${iso.slice(11, 19)}`
  const fractionText = fraction === 0 ? '' : `.${String(fraction).padStart(6, '0').replace(/0+$/u, '')}`
  return `${text}${fractionText}+00`
}
