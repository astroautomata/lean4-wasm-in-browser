import http from 'node:http'
import { createDatabase } from './database.js'
import { validateBatch, validateFeedback } from './validation.js'

const port = Number(process.env.PORT || 8080)
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl && !process.env.PGHOST) throw new Error('DATABASE_URL or PostgreSQL PG* variables are required')

const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || 'https://leangame.autumnofautumn.com')
  .split(',').map(value => value.trim()).filter(Boolean))
const database = createDatabase(databaseUrl)
await database.migrate()

const rateLimits = new Map()
setInterval(() => {
  const cutoff = Date.now() - 120000
  for (const [key, value] of rateLimits) {
    if (value.startedAt < cutoff) rateLimits.delete(key)
  }
}, 60000).unref()
function rateLimited(request) {
  const key = request.socket.remoteAddress || 'unknown'
  const now = Date.now()
  const current = rateLimits.get(key)
  if (!current || now - current.startedAt >= 60000) {
    rateLimits.set(key, { startedAt: now, count: 1 })
    return false
  }
  current.count++
  return current.count > Number(process.env.REQUESTS_PER_MINUTE || 120)
}

function corsHeaders(origin) {
  return origin && allowedOrigins.has(origin) ? {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  } : {}
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://localhost')
  const origin = request.headers.origin
  const cors = corsHeaders(origin)

  if (request.method === 'GET' && url.pathname === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"status":"ok"}')
    return
  }
  const isSubmissionPath = url.pathname === '/v1/events' || url.pathname === '/v1/feedback'
  if (request.method === 'OPTIONS' && isSubmissionPath) {
    response.writeHead(origin && allowedOrigins.has(origin) ? 204 : 403, cors)
    response.end()
    return
  }
  if (request.method !== 'POST' || !isSubmissionPath) {
    response.writeHead(404).end()
    return
  }
  if (!origin || !allowedOrigins.has(origin)) {
    response.writeHead(403).end()
    return
  }
  if (rateLimited(request)) {
    response.writeHead(429, { ...cors, 'retry-after': '60' }).end()
    return
  }

  let raw = ''
  for await (const chunk of request) {
    raw += chunk
    if (raw.length > 512 * 1024) {
      response.writeHead(413, cors).end()
      request.destroy()
      return
    }
  }
  let body
  try { body = JSON.parse(raw) } catch {}
  try {
    if (url.pathname === '/v1/feedback') {
      const feedback = validateFeedback(body)
      if (!feedback) {
        response.writeHead(400, cors).end()
        return
      }
      await database.storeFeedback(feedback)
    } else {
      const events = validateBatch(body)
      if (!events) {
        response.writeHead(400, cors).end()
        return
      }
      await database.store(events)
    }
    response.writeHead(204, cors).end()
  } catch (error) {
    console.error('Telemetry database write failed:', error instanceof Error ? error.message : error)
    response.writeHead(500, cors).end()
  }
})

server.listen(port, '0.0.0.0', () => console.log(`Telemetry collector listening on :${port}`))

async function shutdown() {
  server.close()
  await database.pool.end()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
