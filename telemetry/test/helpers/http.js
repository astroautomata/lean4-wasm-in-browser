import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { configureServer, createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'

/** HTTP helpers for collector tests: an app on an ephemeral port, plain and
 * raw requests, and event factories with fresh identities. */

export const ORIGIN = 'https://game.test'

export function testConfig(env = {}, options = { requireDatabase: false }) {
  return loadConfig({ ALLOWED_ORIGINS: ORIGIN, PORT: '0', METRICS_PORT: '0', ...env }, options)
}

export function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => resolve(server.address().port))
  })
}

/** createApp() behind a real HTTP server on 127.0.0.1. */
export async function startApp({ env = {}, config = testConfig(env), ...deps } = {}) {
  const app = createApp({ config, log: () => {}, ...deps })
  const server = configureServer(http.createServer(app.handle), config, app.metrics)
  const port = await listen(server)
  return {
    app,
    config,
    server,
    port,
    async close() {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

/** One request on a fresh connection. Resolves { status, headers, text, json }. */
export function request(port, { method = 'POST', path = '/v1/events', headers = {}, body, origin = ORIGIN } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
    const allHeaders = { ...(origin ? { origin } : {}), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }
    const outgoing = http.request({ host: '127.0.0.1', port, method, path, headers: allHeaders, agent: false }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = text ? JSON.parse(text) : null
        } catch {}
        resolve({ status: response.statusCode, headers: response.headers, text, json })
      })
      response.on('error', reject)
    })
    outgoing.on('error', reject)
    outgoing.end(payload)
  })
}

/** Write `text` on a raw socket and collect everything until the server closes
 * or `timeoutMs` passes. Resolves { status, raw, closed }. */
export function rawRequest(port, text, { timeoutMs = 3000, keepOpen = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    const chunks = []
    let done = false
    const finish = closed => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (!keepOpen) socket.destroy()
      const raw = Buffer.concat(chunks).toString('latin1')
      const match = /^HTTP\/1\.1 (\d{3})/u.exec(raw)
      resolve({ status: match ? Number(match[1]) : null, raw, closed, socket })
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.on('data', chunk => chunks.push(chunk))
    socket.on('close', () => finish(true))
    socket.on('error', error => (chunks.length > 0 ? finish(true) : reject(error)))
    socket.write(text)
  })
}

/** Wait until `predicate()` is true, polling every `intervalMs`. */
export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 10, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`)
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

export const uuid = () => crypto.randomUUID()

/** A wire event with fresh ids; `overrides` are wire fields. */
export function wireEvent(overrides = {}) {
  return {
    event_id: uuid(),
    user_uuid: overrides.user_uuid ?? uuid(),
    attempt_uuid: overrides.attempt_uuid ?? uuid(),
    event_type: 'proof_step',
    game_id: 'g/local/NNG4',
    world_id: 'Tutorial',
    level_id: 2,
    mode: 'visual',
    sequence: 1,
    elapsed_ms: 1000,
    ts: '2026-08-04T12:00:00.123456Z',
    step_type: 'command',
    command: 'rw [add_zero]',
    ...overrides,
  }
}

export function wireFeedback(overrides = {}) {
  return {
    report_id: uuid(),
    game_id: 'g/local/NNG4',
    world_id: 'Tutorial',
    level_id: 2,
    mode: 'visual',
    message: 'The drop target did not react.',
    proof_state: { proofBody: 'intro n', streams: [{ id: 'stream-1', steps: ['intro n'] }] },
    ts: '2026-08-12T12:00:00.000Z',
    ...overrides,
  }
}

export function deferred() {
  let resolve
  let reject
  const promise = new Promise((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}
