import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createTestDatabase, skipWithoutDatabase } from '../helpers/database.js'
import { listen, ORIGIN, rawRequest, request, waitFor, wireEvent } from '../helpers/http.js'

/** The collector process: startup schema check, readiness, SIGTERM draining. */

const skip = skipWithoutDatabase
const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

async function freePort() {
  const server = http.createServer()
  const port = await listen(server)
  await new Promise(resolve => server.close(resolve))
  return port
}

function startServer(env) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: directory,
    env: { PATH: process.env.PATH, ALLOWED_ORIGINS: ORIGIN, PORT: '0', METRICS_PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = { stdout: '', stderr: '' }
  child.stdout.on('data', chunk => { output.stdout += chunk })
  child.stderr.on('data', chunk => { output.stderr += chunk })
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })))
  return {
    child,
    output,
    exited,
    async port() {
      await waitFor(() => /collector listening on :\d+/u.test(output.stdout), { message: `listening (${output.stderr})` })
      return Number(/collector listening on :(\d+)/u.exec(output.stdout)[1])
    },
    stop() {
      if (child.exitCode === null) child.kill('SIGKILL')
    },
  }
}

function connectionRefused(port) {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1')
    socket.on('connect', () => {
      socket.destroy()
      resolve(false)
    })
    socket.on('error', error => resolve(error.code === 'ECONNREFUSED'))
  })
}

test('drains on SIGTERM: in-flight work finishes, new work is refused, exit 0', { skip }, async () => {
  const db = await createTestDatabase()
  const metricsPort = await freePort()
  const server = startServer({ DATABASE_URL: db.url('telemetry_writer'), METRICS_PORT: String(metricsPort), REQUESTS_PER_MINUTE: '120' })
  try {
    const port = await server.port()
    await waitFor(async () => (await request(port, { method: 'GET', path: '/readyz' })).status === 200, { message: 'ready' })
    assert.match(server.output.stderr, /REQUESTS_PER_MINUTE is deprecated/u)
    const metrics = await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${metricsPort}/metrics`, response => {
      let text = ''
      response.on('data', chunk => { text += chunk })
      response.on('end', () => resolve(text))
    }).on('error', reject))
    assert.match(metrics, /telemetry_ready 1/u)

    const event = wireEvent()
    const body = JSON.stringify({ events: [event] })
    const socket = net.connect(port, '127.0.0.1')
    await new Promise(resolve => socket.on('connect', resolve))
    const reply = new Promise(resolve => {
      let text = ''
      socket.on('data', chunk => { text += chunk })
      socket.on('close', () => resolve(text))
    })
    socket.write(`POST /v1/events HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\nContent-Length: ${body.length}\r\n\r\n${body.slice(0, 10)}`)
    await new Promise(resolve => setTimeout(resolve, 100))

    server.child.kill('SIGTERM')
    await waitFor(() => server.output.stdout.includes('draining'), { message: 'draining' })
    assert.equal(await connectionRefused(port), true, 'new connections are refused')
    socket.write(body.slice(10))
    assert.match(await reply, /^HTTP\/1\.1 204/u)
    assert.deepEqual(await server.exited, { code: 0, signal: null })
    const stored = await db.pools.admin.query('SELECT event_id::text FROM proof_steps')
    assert.deepEqual(stored.rows.map(row => row.event_id), [event.event_id])
  } finally {
    server.stop()
    await db.drop()
  }
})

test('the drain deadline leaves unfinished requests unacknowledged', { skip }, async () => {
  const db = await createTestDatabase()
  const server = startServer({ DATABASE_URL: db.url('telemetry_writer'), DRAIN_TIMEOUT_MS: '300' })
  try {
    const port = await server.port()
    await waitFor(async () => (await request(port, { method: 'GET', path: '/readyz' })).status === 200, { message: 'ready' })
    const stuck = rawRequest(port, `POST /v1/events HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\nContent-Length: 500\r\n\r\n{"events"`,
      { timeoutMs: 5000 })
    await new Promise(resolve => setTimeout(resolve, 100))
    const started = Date.now()
    server.child.kill('SIGTERM')
    const result = await stuck
    assert.equal(result.status, null, 'no acknowledgement')
    assert.equal(result.closed, true)
    assert.deepEqual(await server.exited, { code: 0, signal: null })
    assert.ok(Date.now() - started < 5000)
    assert.equal((await db.pools.admin.query('SELECT count(*)::int AS n FROM proof_steps')).rows[0].n, 0)
  } finally {
    server.stop()
    await db.drop()
  }
})

test('an incompatible schema stops startup with exit code 1', { skip }, async () => {
  const db = await createTestDatabase({ migrate: false })
  const server = startServer({ DATABASE_URL: db.url() })
  try {
    assert.deepEqual(await server.exited, { code: 1, signal: null })
    assert.match(server.output.stderr, /schema is incompatible/u)
    assert.match(server.output.stderr, /001_initial\.sql/u)
    assert.doesNotMatch(server.output.stderr + server.output.stdout, /postgres:test|integration-test-only-password/u)
  } finally {
    server.stop()
    await db.drop()
  }
})

test('an unreachable database keeps the collector live but unready while it retries', { skip }, async () => {
  const closed = await freePort()
  const server = startServer({ DATABASE_URL: `postgresql://telemetry_writer:secret-password@127.0.0.1:${closed}/none` })
  try {
    const port = await server.port()
    assert.equal((await request(port, { method: 'GET', path: '/livez' })).status, 200)
    const ready = await request(port, { method: 'GET', path: '/readyz' })
    assert.equal(ready.status, 503)
    assert.equal(ready.json.schema, 'unknown')
    const refused = await request(port, { body: { events: [wireEvent()] } })
    assert.deepEqual([refused.status, refused.json], [503, { error: 'db_unavailable' }])
    await waitFor(() => /schema check failed/u.test(server.output.stderr), { message: 'retry log' })
    assert.doesNotMatch(server.output.stderr, /secret-password/u)
    server.child.kill('SIGTERM')
    assert.deepEqual(await server.exited, { code: 0, signal: null })
  } finally {
    server.stop()
  }
})

test('invalid configuration exits 1 naming the variable', async () => {
  const server = startServer({ DATABASE_URL: 'postgresql://x@127.0.0.1:1/none', PG_POOL_SIZE: 'many' })
  try {
    assert.deepEqual(await server.exited, { code: 1, signal: null })
    assert.match(server.output.stderr, /PG_POOL_SIZE/u)
  } finally {
    server.stop()
  }
})
