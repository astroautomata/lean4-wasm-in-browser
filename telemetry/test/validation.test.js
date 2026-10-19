import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canonicalEventContent, LIMITS, parseTimestamp, validateBuild, validateClientHealth, validateEnvelope, validateEvent,
  validateFeedback, validatePlatform,
} from '../src/validation.js'

const base = {
  event_id: 'd707e185-136e-4f54-bca8-e1aaffbbe396',
  user_uuid: 'a4ac71f1-54c6-40df-89f7-b5062bf71d60',
  attempt_uuid: '505300ff-0847-48eb-994b-7e834f938c4e',
  event_type: 'proof_step',
  game_id: 'g/local/NNG4', world_id: 'Tutorial', level_id: 2,
  mode: 'classic', sequence: 1, elapsed_ms: 1234,
  ts: '2026-08-04T12:00:00.000Z', step_type: 'edit',
  from_line: 0, removed_lines: 0, command: 'rw [add_zero]',
}

function valid(overrides) {
  const result = validateEvent({ ...base, ...overrides })
  assert.equal(result.ok, true, `expected valid, got ${result.reason}`)
  return result.event
}

function reason(overrides) {
  const result = validateEvent({ ...base, ...overrides })
  assert.equal(result.ok, false, 'expected a rejection')
  return result.reason
}

test('accepts a compact classic edit', () => {
  const event = valid({})
  assert.equal(event.command, 'rw [add_zero]')
  assert.equal(event.fromLine, 0)
  assert.equal(event.removedLines, 0)
  assert.equal(event.clientTsUs, Date.UTC(2026, 7, 4, 12) * 1000)
})

test('distinguishes a visual reset from a single undo', () => {
  const visual = { ...base, mode: 'visual', from_line: undefined, removed_lines: undefined }
  assert.equal(validateEvent({ ...visual, step_type: 'reset', command: 'reset' }).event.stepType, 'reset')
  assert.equal(validateEvent({ ...visual, step_type: 'undo', command: 'undo' }).event.stepType, 'undo')
  assert.equal(validateEvent({ ...visual, step_type: 'restart', command: 'restart' }).reason, 'invalid_step')
})

test('records refused visual gestures and mode switches with their details as step attributes', () => {
  const visual = { ...base, mode: 'visual', from_line: undefined, removed_lines: undefined }
  const rejected = validateEvent({
    ...visual, step_type: 'rejected', command: 'drag_goal add_right_cancel', reason: 'lean-error', error: 'type mismatch',
  }).event
  assert.equal(rejected.stepType, 'rejected')
  assert.equal(rejected.command, 'drag_goal add_right_cancel')
  assert.deepEqual(rejected.stepAttributes, { reason: 'lean-error', error: 'type mismatch' })
  assert.deepEqual(validateEvent({ ...visual, step_type: 'rejected', command: 'cases h' }).event.stepAttributes, {})
  const view = validateEvent({ ...visual, step_type: 'view', command: 'transform goal', reason: 'ignored' }).event
  assert.equal(view.stepType, 'view')
  assert.deepEqual(view.stepAttributes, {})
  assert.deepEqual(valid({}).stepAttributes, {})

  const rejectedReason = overrides => validateEvent({ ...visual, step_type: 'rejected', command: 'x', ...overrides }).reason
  assert.equal(rejectedReason({ reason: 'Not A Slug' }), 'invalid_step')
  assert.equal(rejectedReason({ reason: 'x'.repeat(65) }), 'invalid_step')
  assert.equal(rejectedReason({ reason: ['busy'] }), 'invalid_step')
  assert.equal(rejectedReason({ error: 7 }), 'invalid_type')
  assert.equal(rejectedReason({ error: 'x'.repeat(LIMITS.commandLength + 1) }), 'script_too_large')
  assert.equal(rejectedReason({ error: 'a\u0000b' }), 'invalid_text')
  assert.equal(validateEvent({ ...visual, step_type: 'rejected', command: undefined }).reason, 'invalid_step')
})

const build = {
  site: '3c14d15a1b2c', client: '70a363d2460d-dirty', runtime: '70a363d2460d',
  nng4: '44a0a02f913e', visualtest: 'eec690a6a725', lean: '72a8f89f3126', built: '2026-10-05T14:00:00Z',
}

test('records the game build an event came from', () => {
  assert.deepEqual(valid({ build }).build, build)
  assert.equal(valid({}).build, null)
})

test('keeps only well-formed build entries without losing the event', () => {
  assert.deepEqual(valid({ build: { site: '3c14d15a1b2c', client: 'main', runtime: 42, extra: 'abcdef1', built: 'yesterday' } }).build,
    { site: '3c14d15a1b2c' })
  assert.equal(valid({ build: { client: 'main' } }).build, null)
  assert.equal(valid({ build: ['3c14d15a1b2c'] }).build, null)
  assert.equal(validateBuild(null), null)
})

test('records the browser family and device type an event came from', () => {
  const platform = { browser: 'safari', device: 'mobile' }
  assert.deepEqual(valid({ platform }).platform, platform)
  assert.equal(valid({}).platform, null)
  for (const browser of ['chrome', 'safari', 'firefox', 'edge', 'brave', 'samsung', 'opera', 'unknown']) {
    assert.equal(valid({ platform: { browser } }).platform.browser, browser)
  }
})

test('keeps only the known platform values, never free text, without losing the event', () => {
  assert.deepEqual(valid({
    platform: { browser: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)', device: 'desktop', model: 'iPhone 16' },
  }).platform, { device: 'desktop' })
  assert.equal(valid({ platform: { device: 'tablet' } }).platform, null)
  assert.equal(valid({ platform: 'mobile' }).platform, null)
  assert.equal(valid({ platform: ['chrome'] }).platform, null)
  assert.equal(validatePlatform(null), null)
})

test('the platform, like the build, is not part of an event\'s identity', () => {
  const plain = valid({})
  assert.equal(canonicalEventContent(valid({ platform: { browser: 'chrome', device: 'desktop' } })), canonicalEventContent(plain))
})

test('rejects invalid origins of proof paths', () => {
  assert.equal(reason({ sequence: -1 }), 'invalid_sequence')
  assert.equal(reason({ game_id: '../../etc' }), 'invalid_context')
  assert.equal(reason({ game_id: 'g/./x' }), 'invalid_context')
  assert.equal(reason({ world_id: 'a/b' }), 'invalid_context')
  assert.equal(reason({ game_id: `${'a'.repeat(80)}/${'b'.repeat(80)}` }), 'invalid_context')
  assert.equal(reason({ from_line: null }), 'invalid_step')
})

test('requires actual UUID strings: arrays are not coerced (regression)', () => {
  // RegExp.test(['<uuid>']) is true because the array stringifies to the UUID.
  assert.equal(reason({ event_id: [base.event_id] }), 'invalid_uuid')
  assert.equal(reason({ user_uuid: [base.user_uuid] }), 'invalid_uuid')
  assert.equal(reason({ attempt_uuid: [base.attempt_uuid] }), 'invalid_uuid')
  assert.equal(reason({ attempt_uuid: { toString: () => base.attempt_uuid } }), 'invalid_uuid')
  assert.equal(reason({ event_id: 'not-a-uuid' }), 'invalid_uuid')
  assert.equal(reason({ event_type: 'level_start', source_attempt_uuid: [base.attempt_uuid] }), 'invalid_uuid')
  assert.equal(validateEvent({ ...base, event_id: [base.event_id] }).eventId, null)
})

test('normalises UUIDs to lowercase and names the id of a rejected event', () => {
  const event = valid({ event_id: base.event_id.toUpperCase(), user_uuid: base.user_uuid.toUpperCase() })
  assert.equal(event.eventId, base.event_id)
  assert.equal(event.userId, base.user_uuid)
  assert.deepEqual(validateEvent({ ...base, sequence: 'x' }), { ok: false, reason: 'invalid_sequence', eventId: base.event_id })
})

test('rejects arrays, strings and other types where scalars are expected', () => {
  assert.equal(reason({ event_type: ['proof_step'] }), 'invalid_event')
  assert.equal(reason({ mode: ['visual'] }), 'invalid_context')
  assert.equal(reason({ game_id: ['g', 'local'] }), 'invalid_context')
  assert.equal(reason({ level_id: '2' }), 'invalid_context')
  assert.equal(reason({ sequence: [1] }), 'invalid_sequence')
  assert.equal(reason({ elapsed_ms: '1234' }), 'invalid_timestamp')
  assert.equal(reason({ command: ['rw [add_zero]'] }), 'invalid_type')
  assert.equal(reason({ command: 42 }), 'invalid_type')
  assert.equal(reason({ step_type: ['edit'] }), 'invalid_step')
  assert.equal(reason({ ts: ['2026-08-04T12:00:00.000Z'] }), 'invalid_timestamp')
  assert.equal(reason({ event_type: 'level_complete', play_script: ['x'] }), 'invalid_type')
  assert.equal(validateEvent(null).reason, 'invalid_event')
  assert.equal(validateEvent([base]).reason, 'invalid_event')
  assert.equal(validateEvent('event').reason, 'invalid_event')
})

test('bounds every SQL integer, including edit fields (regression: out of int32)', () => {
  assert.equal(reason({ level_id: 100001 }), 'invalid_context')
  assert.equal(reason({ level_id: 1.5 }), 'invalid_context')
  assert.equal(reason({ sequence: 1000001 }), 'invalid_sequence')
  assert.equal(reason({ sequence: 2 ** 31 }), 'invalid_sequence')
  assert.equal(reason({ elapsed_ms: 2 ** 31 }), 'invalid_timestamp')
  assert.equal(reason({ elapsed_ms: -1 }), 'invalid_timestamp')
  assert.equal(reason({ elapsed_ms: Number.NaN }), 'invalid_timestamp')
  assert.equal(reason({ from_line: 2 ** 31 }), 'invalid_step')
  assert.equal(reason({ removed_lines: 1e100 }), 'invalid_step')
  assert.equal(reason({ removed_lines: -1 }), 'invalid_step')
  assert.equal(reason({ from_line: 1000001 }), 'invalid_step')
  assert.equal(valid({ elapsed_ms: LIMITS.elapsedMs }).elapsedMs, 2147483647)
  assert.equal(valid({ sequence: LIMITS.sequence, from_line: 1000000 }).sequence, 1000000)
})

test('rejects NUL and lone surrogates instead of storing altered text (regression)', () => {
  assert.equal(reason({ command: 'rw\u0000x' }), 'invalid_text')
  assert.equal(reason({ command: 'rw \ud83c' }), 'invalid_text')
  assert.equal(reason({ command: '\udf89 x' }), 'invalid_text')
  assert.equal(reason({ event_type: 'level_start', initial_script: 'a\u0000' }), 'invalid_text')
  assert.equal(reason({ event_type: 'level_complete', lean_script: 'x\ud800' }), 'invalid_text')
  assert.equal(valid({ command: 'induction n with 🎉 ∀ x' }).command, 'induction n with 🎉 ∀ x')
})

test('rejects scripts and commands over the ceilings rather than truncating them (regression)', () => {
  assert.equal(valid({ command: 'x'.repeat(LIMITS.commandLength) }).command.length, LIMITS.commandLength)
  assert.equal(reason({ command: 'x'.repeat(LIMITS.commandLength + 1) }), 'script_too_large')
  const start = { event_type: 'level_start' }
  assert.equal(validateEvent({ ...base, ...start, initial_script: 'x'.repeat(LIMITS.scriptLength) }).ok, true)
  assert.equal(reason({ ...start, initial_script: 'x'.repeat(LIMITS.scriptLength + 1) }), 'script_too_large')
  assert.equal(reason({ event_type: 'level_complete', play_script: 'x'.repeat(LIMITS.scriptLength + 1) }), 'script_too_large')
  // Ceilings are UTF-16 code units, as before: an astral character counts twice.
  assert.equal(reason({ command: '🎉'.repeat(LIMITS.commandLength / 2 + 1) }), 'script_too_large')
})

test('clears fields irrelevant to the event type', () => {
  const start = valid({ event_type: 'level_start', initial_script: 'intro n', source_attempt_uuid: base.attempt_uuid.toUpperCase(),
    play_script: 'x', lean_script: 'y' })
  assert.equal(start.stepType, null)
  assert.equal(start.command, null)
  assert.equal(start.fromLine, null)
  assert.equal(start.removedLines, null)
  assert.equal(start.playScript, null)
  assert.equal(start.leanScript, null)
  assert.equal(start.initialScript, 'intro n')
  assert.equal(start.sourceAttemptId, base.attempt_uuid)

  const step = valid({ step_type: 'command', from_line: 3, removed_lines: 1, initial_script: 'x', play_script: 'y' })
  assert.equal(step.fromLine, null)
  assert.equal(step.removedLines, null)
  assert.equal(step.initialScript, null)
  assert.equal(step.playScript, null)

  const done = valid({ event_type: 'level_complete', play_script: 'rfl', command: 'z', step_type: 'bogus', from_line: 'x' })
  assert.equal(done.command, null)
  assert.equal(done.stepType, null)
  assert.equal(done.fromLine, null)
  assert.equal(done.playScript, 'rfl')
  assert.equal(done.leanScript, null)
})

test('keeps empty scripts and commands distinct from absent ones', () => {
  assert.equal(valid({ event_type: 'level_start', initial_script: '' }).initialScript, '')
  assert.equal(valid({ event_type: 'level_start' }).initialScript, null)
  assert.equal(valid({ step_type: 'command', command: '' }).command, '')
  assert.equal(reason({ step_type: 'command', command: undefined }), 'invalid_step')
})

test('applies an explicit timestamp policy with exact microseconds', () => {
  assert.equal(parseTimestamp('2026-08-04T12:00:00Z'), Date.UTC(2026, 7, 4, 12) * 1000)
  assert.equal(parseTimestamp('2026-08-04T12:00:00.123456Z'), Date.UTC(2026, 7, 4, 12) * 1000 + 123456)
  assert.equal(parseTimestamp('2026-08-04T12:00:00.1Z'), Date.UTC(2026, 7, 4, 12) * 1000 + 100000)
  assert.equal(parseTimestamp('2026-08-04T14:30:00.000001+02:30'), Date.UTC(2026, 7, 4, 12) * 1000 + 1)
  assert.equal(parseTimestamp('2026-08-04T09:00:00-03:00'), Date.UTC(2026, 7, 4, 12) * 1000)
  assert.equal(parseTimestamp('2024-02-29T00:00:00Z'), Date.UTC(2024, 1, 29) * 1000)
  for (const bad of [
    '2026-02-29T00:00:00Z', '2026-13-01T00:00:00Z', '2026-04-31T00:00:00Z', '2026-08-04T24:00:00Z',
    '2026-08-04T12:60:00Z', '2026-08-04T12:00:60Z', '2026-08-04T12:00:00.1234567Z', '2026-08-04 12:00:00Z',
    '2026-08-04T12:00:00', '2026-08-04', 'Aug 4 2026', '1999-12-31T23:59:59.999999Z', '2100-01-01T00:00:00Z',
    '2026-08-04T12:00:00+24:00', '2026-08-04T12:00:00.000Z ', '', 1786017600000, null,
  ]) {
    assert.equal(parseTimestamp(bad), null, String(bad))
  }
  assert.equal(parseTimestamp('2000-01-01T00:00:00Z'), Date.UTC(2000, 0, 1) * 1000)
  assert.equal(parseTimestamp('2099-12-31T23:59:59.999999Z'), Date.UTC(2100, 0, 1) * 1000 - 1)
  assert.equal(parseTimestamp('2000-01-01T00:30:00+01:00'), null)
  assert.equal(parseTimestamp(`2026-08-04T12:00:00.${'0'.repeat(30)}Z`), null)
  assert.equal(reason({ ts: '2026-02-30T00:00:00Z' }), 'invalid_timestamp')
})

test('canonical content ignores the build but nothing a client sent', () => {
  const event = valid({})
  assert.equal(canonicalEventContent(event), canonicalEventContent(valid({ build })))
  assert.notEqual(canonicalEventContent(event), canonicalEventContent(valid({ command: 'rw [add_zero] ' })))
  assert.notEqual(canonicalEventContent(event), canonicalEventContent(valid({ ts: '2026-08-04T12:00:00.000001Z' })))
})

test('validates the envelope separately from its events', () => {
  assert.deepEqual(validateEnvelope({ events: [base] }), { ok: true, events: [base], clientHealth: null })
  assert.equal(validateEnvelope({ events: [] }).ok, false)
  assert.equal(validateEnvelope({ events: new Array(51).fill(base) }).ok, false)
  assert.equal(validateEnvelope({ events: new Array(51).fill(base) }, { maxEvents: 60 }).ok, true)
  assert.equal(validateEnvelope({ events: 'x' }).ok, false)
  assert.equal(validateEnvelope([base]).ok, false)
  assert.equal(validateEnvelope(null).ok, false)
  const envelope = validateEnvelope({ events: [base, null, { ...base, sequence: -1 }] })
  assert.deepEqual(envelope.events.map(item => validateEvent(item).ok), [true, false, false])
})

test('accepts bounded client health and ignores anything else', () => {
  assert.deepEqual(validateClientHealth({ queue_events: 3, evicted: 0, sent: 10, unknown: 5, retries: -1, expired: 1.5,
    oversize: 2e9, rejected: '4' }), { queue_events: 3, evicted: 0, sent: 10 })
  assert.equal(validateClientHealth({ retries: -1 }), null)
  assert.equal(validateClientHealth([1]), null)
  assert.deepEqual(validateEnvelope({ events: [base], client: { health: { queue_bytes: 100 } } }).clientHealth, { queue_bytes: 100 })
  assert.equal(validateEnvelope({ events: [base], client: 'x' }).clientHealth, null)
})

const feedback = {
  report_id: 'd707e185-136e-4f54-bca8-e1aaffbbe396',
  game_id: 'g/local/NNG4', world_id: 'Tutorial', level_id: 2,
  mode: 'visual', message: 'The drop target did not react.',
  proof_state: { proofBody: 'intro n', activeStreamId: 'stream-1' },
  ts: '2026-08-12T12:00:00.000Z',
}

test('accepts feedback without an anonymous telemetry identity', () => {
  const result = validateFeedback(feedback)
  assert.equal(result.ok, true)
  assert.equal(result.feedback.userId, null)
  assert.equal(result.feedback.message, feedback.message)
  assert.equal(result.feedback.clientTsUs, Date.UTC(2026, 7, 12, 12) * 1000)
})

test('accepts feedback with an anonymous identity when supplied', () => {
  assert.equal(validateFeedback({ ...feedback, user_uuid: base.user_uuid }).feedback.userId, base.user_uuid)
  assert.equal(validateFeedback({ ...feedback, user_uuid: [base.user_uuid] }).reason, 'invalid_uuid')
})

test('records the game build a feedback report came from', () => {
  assert.deepEqual(validateFeedback({ ...feedback, build }).feedback.build, build)
  assert.equal(validateFeedback(feedback).feedback.build, null)
})

test('records the browser family and device type a feedback report came from', () => {
  const platform = { browser: 'chrome', device: 'desktop' }
  assert.deepEqual(validateFeedback({ ...feedback, platform }).feedback.platform, platform)
  assert.equal(validateFeedback(feedback).feedback.platform, null)
  assert.deepEqual(validateFeedback({ ...feedback, platform: { browser: 'netscape', device: 'mobile' } }).feedback.platform,
    { device: 'mobile' })
})

test('rejects empty, oversized, or malformed feedback', () => {
  assert.equal(validateFeedback({ ...feedback, message: '   ' }).ok, false)
  assert.equal(validateFeedback({ ...feedback, message: 'x'.repeat(1001) }).ok, false)
  assert.equal(validateFeedback({ ...feedback, message: ` ${'x'.repeat(1000)} ` }).ok, true)
  assert.equal(validateFeedback({ ...feedback, message: 'a\u0000b' }).reason, 'invalid_text')
  assert.equal(validateFeedback({ ...feedback, message: 'a\ud800b' }).reason, 'invalid_text')
  assert.equal(validateFeedback({ ...feedback, message: ['x'] }).reason, 'invalid_type')
  assert.equal(validateFeedback({ ...feedback, proof_state: null }).ok, false)
  assert.equal(validateFeedback({ ...feedback, proof_state: [] }).ok, false)
  // Ordinary JSON values inside the state are accepted, null included.
  assert.equal(validateFeedback({ ...feedback, proof_state: { activeStreamId: null, done: false, list: [null, 1, 'x'] } }).ok, true)
  assert.equal(validateFeedback({ ...feedback, report_id: [feedback.report_id] }).reason, 'invalid_uuid')
  assert.equal(validateFeedback({ ...feedback, level_id: 2 ** 31 }).reason, 'invalid_context')
  assert.equal(validateFeedback({ ...feedback, ts: 'yesterday' }).reason, 'invalid_timestamp')
})

test('bounds feedback proof_state depth, node count, size and text', () => {
  let deep = { leaf: true }
  for (let depth = 1; depth < LIMITS.proofStateDepth; depth++) deep = { next: deep }
  assert.equal(validateFeedback({ ...feedback, proof_state: deep }).ok, true)
  assert.equal(validateFeedback({ ...feedback, proof_state: { next: deep } }).reason, 'script_too_large')
  let deepArrays = []
  for (let depth = 0; depth < 10000; depth++) deepArrays = [deepArrays]
  assert.equal(validateFeedback({ ...feedback, proof_state: { deep: deepArrays } }).reason, 'script_too_large')

  assert.equal(validateFeedback({ ...feedback, proof_state: { items: new Array(LIMITS.proofStateNodes - 2).fill(0) } }).ok, true)
  assert.equal(validateFeedback({ ...feedback, proof_state: { items: new Array(LIMITS.proofStateNodes).fill(0) } }).reason,
    'script_too_large')
  assert.equal(validateFeedback({ ...feedback, proof_state: { text: 'x'.repeat(LIMITS.proofStateBytes) } }).reason, 'script_too_large')
  assert.equal(validateFeedback({ ...feedback, proof_state: { text: 'é'.repeat(LIMITS.proofStateBytes / 2 - 20) } }).ok, true)
  assert.equal(validateFeedback({ ...feedback, proof_state: { text: 'é'.repeat(LIMITS.proofStateBytes / 2) } }).reason, 'script_too_large')
  assert.equal(validateFeedback({ ...feedback, proof_state: { 'a\u0000': 1 } }).reason, 'invalid_text')
  assert.equal(validateFeedback({ ...feedback, proof_state: { a: ['ok', 'x\u0000'] } }).reason, 'invalid_text')
  assert.equal(validateFeedback({ ...feedback, proof_state: { a: '\udc00' } }).reason, 'invalid_text')
  assert.equal(validateFeedback({ ...feedback, proof_state: { a: Infinity } }).reason, 'invalid_type')
})
