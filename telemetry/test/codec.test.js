import assert from 'node:assert/strict'
import test from 'node:test'
import zlib from 'node:zlib'
import {
  decodeChunk, encodeChunk, formatPgTimestamp, sameAction, sameClientContent, TrajectoryFormatError,
} from '../src/trajectory/codec.js'

const attemptId = '505300ff-0847-48eb-994b-7e834f938c4e'

function action(overrides = {}) {
  return {
    eventId: 'd707e185-136e-4f54-bca8-e1aaffbbe396',
    sequence: 1,
    clientTsUs: 1786017600123000,
    elapsedMs: 1234,
    stepType: 'command',
    command: 'rw [add_zero]',
    fromLine: null,
    removedLines: null,
    attributes: {},
    receivedAtUs: 1786017600456789,
    ...overrides,
  }
}

function manifestOf(encoded) {
  return {
    format: encoded.format, codec: encoded.codec, attemptId, eventCount: encoded.eventCount,
    seqFirst: encoded.seqFirst, seqLast: encoded.seqLast,
    uncompressedBytes: encoded.uncompressedBytes, checksum: encoded.checksum,
  }
}

const actions = [
  action(),
  action({ eventId: '0b8c7b52-31a4-4c55-9d43-6b0f2b7f7c11', sequence: 2, elapsedMs: 900, clientTsUs: 1786017599000001,
    stepType: 'undo', command: 'undo', receivedAtUs: null }),
  action({ eventId: '9d1f7a56-7fd2-4f0a-8f6c-0b1d2e3f4a5b', sequence: 5, elapsedMs: 4000, stepType: 'edit',
    command: 'induction n with\n| zero => rfl 🎉 ', fromLine: 3, removedLines: 0,
    attributes: { phantom: true, nested: { b: [1, 'x'], a: null } }, receivedAtUs: 1786017601000000 }),
  action({ eventId: '1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5', sequence: 6, elapsedMs: 4100, stepType: 'reset',
    command: '', receivedAtUs: 1786017600999999 }),
]

test('round-trips refused gestures and mode switches with their attributes', () => {
  const gestures = [
    action({ eventId: '2d3e4f5a-6b7c-4d8e-9fa0-b1c2d3e4f5a6', stepType: 'rejected', command: 'drag_goal add_right_cancel',
      attributes: { reason: 'lean-error', error: 'type mismatch' } }),
    action({ eventId: '3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7', sequence: 2, stepType: 'view', command: 'transform goal' }),
  ]
  const encoded = encodeChunk({ attemptId, actions: gestures })
  assert.deepEqual(decodeChunk(encoded.payload, manifestOf(encoded)), gestures)
})

test('round-trips every replay field, including gaps, NULL ingestion times and unicode', () => {
  const encoded = encodeChunk({ attemptId, actions })
  assert.equal(encoded.eventCount, 4)
  assert.equal(encoded.seqFirst, 1)
  assert.equal(encoded.seqLast, 6)
  assert.equal(encoded.historicSources, true)
  assert.equal(encoded.minSourceReceivedAtUs, 1786017600456789)
  assert.equal(encoded.maxSourceReceivedAtUs, 1786017601000000)
  assert.deepEqual(encoded.eventIds, actions.map(item => item.eventId))
  const decoded = decodeChunk(encoded.payload, manifestOf(encoded))
  assert.deepEqual(decoded, actions)
  decoded.forEach((item, index) => assert.ok(sameAction(item, actions[index])))
})

test('distinguishes client content from server ingestion time', () => {
  assert.ok(sameClientContent(action(), action({ receivedAtUs: null })))
  assert.ok(!sameAction(action(), action({ receivedAtUs: null })))
  assert.ok(!sameClientContent(action(), action({ command: 'rw [add_zero] ' })))
  assert.ok(sameClientContent(action({ attributes: { a: 1, b: 2 } }), action({ attributes: { b: 2, a: 1 } })))
})

test('rejects unordered or invalid input when encoding', () => {
  assert.throws(() => encodeChunk({ attemptId, actions: [action({ sequence: 2 }), action({ sequence: 2 })] }), TrajectoryFormatError)
  assert.throws(() => encodeChunk({ attemptId, actions: [action({ stepType: 'restart' })] }), TrajectoryFormatError)
  assert.throws(() => encodeChunk({ attemptId, actions: [] }), TrajectoryFormatError)
  assert.throws(() => encodeChunk({ attemptId, actions: [action(), action({ sequence: 2 })] }, {
    maxEvents: 1, maxUncompressedBytes: 1 << 20, maxCompressedBytes: 1 << 20,
  }), /at most 1/u)
})

test('detects corruption, mismatched manifests and decompression bombs', () => {
  const encoded = encodeChunk({ attemptId, actions })
  const manifest = manifestOf(encoded)
  const corrupt = Buffer.from(encoded.payload)
  corrupt[corrupt.length - 9] ^= 0xff
  assert.throws(() => decodeChunk(corrupt, manifest), TrajectoryFormatError)
  assert.throws(() => decodeChunk(encoded.payload, { ...manifest, eventCount: 3 }), /count/u)
  assert.throws(() => decodeChunk(encoded.payload, { ...manifest, seqLast: 7 }), /range/u)
  assert.throws(() => decodeChunk(encoded.payload, { ...manifest, attemptId: 'a4ac71f1-54c6-40df-89f7-b5062bf71d60' }), /attempt/u)
  assert.throws(() => decodeChunk(encoded.payload, { ...manifest, checksum: Buffer.alloc(32) }), /checksum/u)
  assert.throws(() => decodeChunk(encoded.payload, { ...manifest, format: 'lean-trajectory/2' }), /unsupported/u)

  const bomb = zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024))
  assert.throws(() => decodeChunk(bomb, { ...manifest, uncompressedBytes: 1024 }),
    error => error instanceof TrajectoryFormatError && error.code === 'chunk_too_large')
  assert.throws(() => decodeChunk(bomb, { ...manifest, uncompressedBytes: 64 * 1024 * 1024 }),
    error => error.code === 'chunk_too_large')
})

test('formats timestamps exactly as PostgreSQL text output in UTC', () => {
  assert.equal(formatPgTimestamp(1786017600123000), '2026-08-06 12:00:00.123+00')
  assert.equal(formatPgTimestamp(1786017600000000), '2026-08-06 12:00:00+00')
  assert.equal(formatPgTimestamp(1786017600000001), '2026-08-06 12:00:00.000001+00')
  assert.equal(formatPgTimestamp(null), '')
})
