import assert from 'node:assert/strict'
import test from 'node:test'
import { completenessOf } from '../src/trajectory/reader.js'

const attempt = (overrides = {}) => ({
  startEventId: 'd707e185-136e-4f54-bca8-e1aaffbbe396', startSequence: 0,
  completed: false, completionEventId: null, completionSequence: null,
  laterCompletionSequences: [], detailExpiredAtUs: null, ...overrides,
})
const steps = (...sequences) => sequences.map(sequence => ({ sequence }))

test('a contiguous attempt with its start and completion is complete', () => {
  const result = completenessOf(attempt({ completed: true, completionEventId: 'x', completionSequence: 4 }), steps(1, 2, 3), [])
  assert.equal(result.complete, true)
  assert.deepEqual(result.missingSequences, [])
})

test('sequences held by the start, completion and later completions are not gaps', () => {
  const result = completenessOf(attempt({ completed: true, completionEventId: 'x', completionSequence: 3, laterCompletionSequences: [6] }),
    steps(1, 2, 4, 5, 7), [])
  assert.deepEqual(result.missingSequences, [])
  assert.equal(result.complete, true)
})

test('lost steps, a missing start and a legacy completion are reported', () => {
  const result = completenessOf(attempt({ startEventId: null, startSequence: null, completed: true }), steps(1, 3, 6), [])
  assert.deepEqual(result.missingSequences, [2, 4, 5])
  assert.equal(result.startRecorded, false)
  assert.equal(result.legacyCompletionUnknownSequence, true)
  assert.equal(result.complete, false)
})

test('arrival order is no evidence: a completion alone leaves earlier steps missing', () => {
  const result = completenessOf(attempt({ completed: true, completionEventId: 'x', completionSequence: 3 }), [], [])
  assert.deepEqual(result.missingSequences, [1, 2])
  assert.equal(result.complete, false)
})

test('errors, expired detail and long gap lists are explicit and bounded', () => {
  assert.equal(completenessOf(attempt(), steps(1), [{ code: 'corrupt_chunk' }]).complete, false)
  assert.equal(completenessOf(attempt({ detailExpiredAtUs: 1 }), [], []).detailExpired, true)
  const result = completenessOf(attempt(), steps(100000), [], { maxMissingListed: 10 })
  assert.equal(result.missingCount, 99999)
  assert.equal(result.missingSequences.length, 10)
})
