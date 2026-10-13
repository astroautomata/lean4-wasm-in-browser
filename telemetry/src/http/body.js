import { HttpError, RequestAbortedError } from './errors.js'

/** Bounded request body reading.
 *
 * Sizes are counted in received Buffer bytes, never in decoded characters, and
 * the limit applies while streaming, so chunked bodies without Content-Length
 * are bounded too. The body is decoded once, after it is complete, so a
 * multi-byte UTF-8 sequence split across chunks is never corrupted. */

/** 413 before reading anything when the declared length is already too large. */
export function checkDeclaredLength(request, limit) {
  const header = request.headers['content-length']
  if (header === undefined) return
  if (!/^\d+$/u.test(header)) throw new HttpError(400, 'invalid_envelope')
  if (Number(header) > limit) throw new HttpError(413, 'body_too_large')
}

/** Resolves with the complete body as one Buffer. Rejects with
 *   HttpError 413 body_too_large   more than `limit` bytes arrived
 *   HttpError 408 body_timeout     the body did not complete within `timeoutMs`
 *   RequestAbortedError            the client aborted or the socket closed
 *   signal.reason                  `signal` aborted (deadline, shutdown)
 * Listeners and the timer are removed on every path. On 413/408 the request
 * is paused: the caller answers and lets the connection close. */
export function readBody(request, { limit, timeoutMs, signal } = {}) {
  checkDeclaredLength(request, limit)
  return new Promise((resolve, reject) => {
    const chunks = []
    let received = 0
    let settled = false
    let timer = null

    function cleanup() {
      settled = true
      clearTimeout(timer)
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', onError)
      request.off('close', onClose)
      signal?.removeEventListener('abort', onAbort)
    }
    function fail(error) {
      if (settled) return
      cleanup()
      chunks.length = 0
      request.pause()
      reject(error)
    }
    function onData(chunk) {
      if (settled) return
      received += chunk.byteLength
      if (received > limit) {
        fail(new HttpError(413, 'body_too_large'))
        return
      }
      chunks.push(chunk)
    }
    function onEnd() {
      if (settled) return
      cleanup()
      resolve(Buffer.concat(chunks, received))
    }
    function onError() {
      fail(new RequestAbortedError())
    }
    function onClose() {
      // 'close' before 'end' means the body never completed.
      fail(new RequestAbortedError())
    }
    function onAbort() {
      fail(signal.reason instanceof Error ? signal.reason : new RequestAbortedError())
    }

    if (signal?.aborted) {
      onAbort()
      return
    }
    if (request.readableEnded) {
      settled = true
      resolve(Buffer.alloc(0))
      return
    }
    if (request.destroyed) {
      fail(new RequestAbortedError())
      return
    }
    timer = setTimeout(() => fail(new HttpError(408, 'body_timeout')), timeoutMs)
    request.on('data', onData)
    request.on('end', onEnd)
    request.on('error', onError)
    request.on('close', onClose)
    signal?.addEventListener('abort', onAbort, { once: true })
    request.resume()
  })
}

const decoder = new TextDecoder('utf-8', { fatal: true })

/** Decode a complete body as strict UTF-8 and parse it as JSON. */
export function parseJsonBody(buffer) {
  let text
  try {
    text = decoder.decode(buffer)
  } catch {
    throw new HttpError(400, 'invalid_utf8')
  }
  try {
    return JSON.parse(text)
  } catch {
    // JSON.parse messages quote the input; never pass them on.
    throw new HttpError(400, 'invalid_json')
  }
}
