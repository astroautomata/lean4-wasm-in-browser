import assert from 'node:assert/strict'
import test from 'node:test'
import { validateBatch, validateFeedback } from '../src/validation.js'

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

test('accepts a compact classic edit', () => {
  const result = validateBatch({ events: [base] })
  assert.equal(result?.[0].command, 'rw [add_zero]')
})

test('distinguishes a visual reset from a single undo', () => {
  const visual = { ...base, mode: 'visual', from_line: undefined, removed_lines: undefined }
  assert.equal(validateBatch({ events: [{ ...visual, step_type: 'reset', command: 'reset' }] })?.[0].stepType, 'reset')
  assert.equal(validateBatch({ events: [{ ...visual, step_type: 'undo', command: 'undo' }] })?.[0].stepType, 'undo')
  assert.equal(validateBatch({ events: [{ ...visual, step_type: 'restart', command: 'restart' }] }), null)
})

const build = {
  site: '3c14d15a1b2c', client: '70a363d2460d-dirty', runtime: '70a363d2460d',
  nng4: '44a0a02f913e', visualtest: 'eec690a6a725', lean: '72a8f89f3126', built: '2026-10-05T14:00:00Z',
}

test('records the game build an event came from', () => {
  assert.deepEqual(validateBatch({ events: [{ ...base, build }] })?.[0].build, build)
  assert.equal(validateBatch({ events: [base] })?.[0].build, null)
})

test('keeps only well-formed build entries without losing the event', () => {
  const result = validateBatch({ events: [{
    ...base,
    build: { site: '3c14d15a1b2c', client: 'main', runtime: 42, extra: 'abcdef1', built: 'yesterday' },
  }] })
  assert.deepEqual(result?.[0].build, { site: '3c14d15a1b2c' })
  assert.equal(validateBatch({ events: [{ ...base, build: { client: 'main' } }] })?.[0].build, null)
  assert.equal(validateBatch({ events: [{ ...base, build: ['3c14d15a1b2c'] }] })?.[0].build, null)
})

test('rejects invalid origins of proof paths', () => {
  assert.equal(validateBatch({ events: [{ ...base, sequence: -1 }] }), null)
  assert.equal(validateBatch({ events: [{ ...base, game_id: '../../etc' }] }), null)
  assert.equal(validateBatch({ events: [{ ...base, from_line: null }] }), null)
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
  assert.equal(result?.userId, null)
  assert.equal(result?.message, feedback.message)
})

test('accepts feedback with an anonymous identity when supplied', () => {
  const result = validateFeedback({ ...feedback, user_uuid: base.user_uuid })
  assert.equal(result?.userId, base.user_uuid)
})

test('records the game build a feedback report came from', () => {
  assert.deepEqual(validateFeedback({ ...feedback, build })?.build, build)
  assert.equal(validateFeedback(feedback)?.build, null)
})

test('rejects empty, oversized, or malformed feedback', () => {
  assert.equal(validateFeedback({ ...feedback, message: '   ' }), null)
  assert.equal(validateFeedback({ ...feedback, message: 'x'.repeat(1001) }), null)
  assert.equal(validateFeedback({ ...feedback, proof_state: null }), null)
})
