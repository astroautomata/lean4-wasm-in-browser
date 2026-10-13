import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { checkDeclaredLength, parseJsonBody, readBody } from '../src/http/body.js'
import { HttpError, RequestAbortedError } from '../src/http/errors.js'

/** A request-like stream that emits `chunks` and then ends (unless `end` is false). */
function fakeRequest(chunks, { headers = {}, end = true } = {}) {
  const stream = new Readable({ read() {} })
  stream.headers = headers
  setImmediate(() => {
    for (const chunk of chunks) stream.push(chunk)
    if (end) stream.push(null)
  })
  return stream
}

const text = JSON.stringify({ command: 'é ∀ x, 🎉 rfl — 漢字', more: 'ok' })
const bytes = Buffer.from(text, 'utf8')

test('decodes multi-byte UTF-8 split across every chunk boundary (regression)', async () => {
  assert.ok(bytes.length > text.length, 'the sample must contain multi-byte characters')
  for (let split = 1; split < bytes.length; split++) {
    const request = fakeRequest([bytes.subarray(0, split), bytes.subarray(split)])
    const body = await readBody(request, { limit: 1024, timeoutMs: 1000 })
    assert.deepEqual(parseJsonBody(body), JSON.parse(text), `split at byte ${split}`)
  }
})

test('decodes a body delivered one byte per chunk', async () => {
  const request = fakeRequest([...bytes].map(byte => Buffer.from([byte])))
  assert.equal(parseJsonBody(await readBody(request, { limit: 1024, timeoutMs: 1000 })).command, JSON.parse(text).command)
})

test('counts received bytes, not characters, against the limit', async () => {
  const fourByteChars = Buffer.from('🎉'.repeat(100), 'utf8')
  await assert.rejects(readBody(fakeRequest([fourByteChars]), { limit: 399, timeoutMs: 1000 }),
    error => error instanceof HttpError && error.status === 413)
  assert.equal((await readBody(fakeRequest([fourByteChars]), { limit: 400, timeoutMs: 1000 })).length, 400)
})

test('rejects an oversized chunked body while streaming, before it completes', async () => {
  const request = fakeRequest([Buffer.alloc(600), Buffer.alloc(600)], { headers: { 'transfer-encoding': 'chunked' }, end: false })
  await assert.rejects(readBody(request, { limit: 1000, timeoutMs: 5000 }), error => error.status === 413 && error.code === 'body_too_large')
  assert.equal(request.listenerCount('data'), 0)
  assert.equal(request.isPaused(), true)
})

test('rejects an oversized Content-Length before reading anything', async () => {
  const request = fakeRequest([Buffer.alloc(10)], { headers: { 'content-length': '2000' } })
  assert.throws(() => checkDeclaredLength(request, 1000), error => error.status === 413)
  assert.throws(() => readBody(request, { limit: 1000, timeoutMs: 1000 }), error => error.status === 413)
  assert.equal(request.listenerCount('data'), 0)
  assert.doesNotThrow(() => checkDeclaredLength({ headers: { 'content-length': '1000' } }, 1000))
  assert.doesNotThrow(() => checkDeclaredLength({ headers: {} }, 1000))
})

test('times out a body that does not arrive in time with 408', async () => {
  const request = fakeRequest([Buffer.from('{"events":')], { end: false })
  const started = Date.now()
  await assert.rejects(readBody(request, { limit: 1000, timeoutMs: 50 }), error => error.status === 408 && error.code === 'body_timeout')
  assert.ok(Date.now() - started < 1000)
  assert.equal(request.listenerCount('data'), 0)
})

test('treats an aborted upload as a request failure', async () => {
  const destroyed = fakeRequest([Buffer.from('{"ev')], { end: false })
  setTimeout(() => destroyed.destroy(), 10)
  await assert.rejects(readBody(destroyed, { limit: 1000, timeoutMs: 1000 }), RequestAbortedError)

  const errored = fakeRequest([Buffer.from('{"ev')], { end: false })
  setTimeout(() => errored.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' })), 10)
  await assert.rejects(readBody(errored, { limit: 1000, timeoutMs: 1000 }), RequestAbortedError)
  assert.equal(errored.listenerCount('data'), 0)
})

test('stops reading when the request signal aborts', async () => {
  const controller = new AbortController()
  const request = fakeRequest([Buffer.from('{')], { end: false })
  setTimeout(() => controller.abort(new HttpError(503, 'deadline')), 10)
  await assert.rejects(readBody(request, { limit: 1000, timeoutMs: 5000, signal: controller.signal }), error => error.code === 'deadline')
  const aborted = new AbortController()
  aborted.abort(new HttpError(503, 'draining'))
  await assert.rejects(readBody(fakeRequest([]), { limit: 10, timeoutMs: 1000, signal: aborted.signal }), error => error.code === 'draining')
})

test('removes its listeners after a complete body', async () => {
  const request = fakeRequest([bytes])
  await readBody(request, { limit: 1024, timeoutMs: 1000 })
  for (const event of ['data', 'end', 'error', 'close']) assert.equal(request.listenerCount(event), 0, event)
})

test('answers malformed UTF-8 and JSON with controlled errors that do not echo input', () => {
  for (const invalid of [[0xc3, 0x28], [0xed, 0xa0, 0x80], [0xc0, 0xaf], [0xf0, 0x9f, 0x8e], [0xff]]) {
    assert.throws(() => parseJsonBody(Buffer.from(invalid)), error => error.status === 400 && error.code === 'invalid_utf8')
  }
  assert.throws(() => parseJsonBody(Buffer.from('{"secret proof": rfl')), error => {
    assert.equal(error.code, 'invalid_json')
    assert.doesNotMatch(error.message, /secret|rfl/u)
    return true
  })
  assert.throws(() => parseJsonBody(Buffer.alloc(0)), error => error.code === 'invalid_json')
  assert.throws(() => parseJsonBody(Buffer.from('['.repeat(200000))), error => error.code === 'invalid_json')
  assert.deepEqual(parseJsonBody(Buffer.from('﻿{"a":1}')), { a: 1 })
})
