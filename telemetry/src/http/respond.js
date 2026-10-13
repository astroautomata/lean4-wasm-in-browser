/** Guarded response writing and CORS.
 *
 * A response may be attempted after the client disconnected, after a deadline
 * already answered the request, or twice on racing paths. Every write goes
 * through send(), which does nothing once the response or its socket is
 * finished, so no path can throw ERR_HTTP_HEADERS_SENT or write to a
 * destroyed socket. */

export const SUBMISSION_METHODS = 'POST, OPTIONS'

/** CORS headers for an allowed origin (empty for any other origin). Every
 * response to an allowed origin exposes Retry-After so the browser client can
 * honour it on 429 and 503. */
export function corsHeaders(origin, allowedOrigins, { preflight = false } = {}) {
  if (!origin || !allowedOrigins.has(origin)) return {}
  const headers = {
    'access-control-allow-origin': origin,
    'access-control-expose-headers': 'Retry-After',
    vary: 'Origin',
  }
  if (preflight) {
    headers['access-control-allow-methods'] = SUBMISSION_METHODS
    headers['access-control-allow-headers'] = 'content-type'
    headers['access-control-max-age'] = '86400'
  }
  return headers
}

export function canRespond(response) {
  return !response.headersSent && !response.writableEnded && !response.destroyed &&
    Boolean(response.socket) && !response.socket.destroyed
}

/** Write a complete response once. `body` is a string, Buffer, plain value
 * (serialised as JSON) or undefined. Returns whether anything was written. */
export function send(response, status, { headers = {}, body } = {}) {
  if (!canRespond(response)) return false
  let payload = null
  const allHeaders = { 'cache-control': 'no-store', ...headers }
  if (body !== undefined && body !== null) {
    payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
    if (!allHeaders['content-type']) allHeaders['content-type'] = 'application/json'
    allHeaders['content-length'] = String(Buffer.byteLength(payload))
  } else if (status !== 204 && status !== 304) {
    allHeaders['content-length'] = '0'
  }
  try {
    response.writeHead(status, allHeaders)
    response.end(payload ?? undefined)
    return true
  } catch {
    // The socket went away between the check and the write.
    return false
  }
}
