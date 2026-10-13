import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkTarget, loadScenario, phaseSchedule, runLoad } from '../bench/loadgen.js'
import {
  BATCH_SIZES, contentHash, createWorkload, percentile, sampleQuantiles, seededRandom,
} from '../bench/workload.js'
import { validateEvent, validateFeedback } from '../src/validation.js'
import { forecast } from '../tools/storage-report.js'

const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bench')
const profile = JSON.parse(fs.readFileSync(path.join(BENCH, 'profiles', 'sample-2026-10.json'), 'utf8'))

test('the random source is deterministic per seed', () => {
  const a = seededRandom(7)
  const b = seededRandom(7)
  const values = Array.from({ length: 5 }, () => a())
  assert.deepEqual(values, Array.from({ length: 5 }, () => b()))
  assert.ok(values.every(value => value >= 0 && value < 1))
  assert.notDeepEqual(values, Array.from({ length: 5 }, seededRandom(8)))
})

test('percentiles use nearest rank', () => {
  const values = Array.from({ length: 100 }, (_, index) => index + 1)
  assert.equal(percentile(values, 50), 50)
  assert.equal(percentile(values, 95), 95)
  assert.equal(percentile(values, 99), 99)
  assert.equal(percentile([], 50), null)
})

test('quantile sampling stays within the profile', () => {
  const random = seededRandom(1)
  const quantiles = profile.command_bytes.visual_command
  for (let index = 0; index < 1000; index++) {
    const value = sampleQuantiles(random, quantiles)
    assert.ok(value >= quantiles[0] && value <= quantiles.at(-1))
  }
})

test('the schedule delivers the requested event rate on average', () => {
  const random = seededRandom(3)
  const scenario = { batch: 'client', feedback_per_1000_events: 10 }
  const schedule = phaseSchedule({ duration_s: 200, events_per_second: 100 }, scenario, random)
  const events = schedule.filter(item => item.kind === 'events').reduce((sum, item) => sum + item.events, 0)
  assert.ok(Math.abs(events / 200 - 100) < 10, `${events / 200} events/s`)
  assert.ok(schedule.every((item, index) => index === 0 || item.at >= schedule[index - 1].at))
  assert.ok(schedule.some(item => item.kind === 'feedback'))
  const storm = phaseSchedule({ duration_s: 10, storm: { clients: 50, backlog_events: 20, within_s: 2 } }, scenario, random)
  assert.equal(storm.length, 50)
  assert.ok(storm.every(item => item.at <= 2))
  assert.ok(Object.values(BATCH_SIZES).every(size => size(random) >= 1 && size(random) <= 50))
})

test('generated events and feedback pass the collector validation and follow the protocol', () => {
  const workload = createWorkload({ seed: 5, players: 3, profile })
  const byAttempt = new Map()
  for (let index = 0; index < 300; index++) {
    for (const event of workload.next(1, { playerIndex: index % 3 })) {
      const result = validateEvent(event)
      assert.ok(result.ok, `${event.event_type}: ${result.reason}`)
      if (!byAttempt.has(event.attempt_uuid)) byAttempt.set(event.attempt_uuid, [])
      byAttempt.get(event.attempt_uuid).push(event)
    }
  }
  for (const events of byAttempt.values()) {
    assert.equal(events[0].event_type, 'level_start')
    assert.deepEqual(events.map(event => event.sequence), events.map((_, index) => index))
  }
  assert.ok(validateFeedback(workload.feedback()).ok)
  // Every synthetic event carries a valid build and a platform fixed per player.
  const sample = workload.next(3, { playerIndex: 1 })
  for (const item of sample) {
    const validated = validateEvent(item).event
    assert.ok(validated.build && validated.platform, 'build and platform survive validation')
    assert.deepEqual(item.platform, sample[0].platform)
  }
  const event = workload.next(1)[0]
  assert.equal(contentHash(event), contentHash({ ...event }))
  assert.notEqual(contentHash(event), contentHash({ ...event, command: `${event.command}x` }))
})

test('the production collector and unmarked remote targets are refused', () => {
  assert.throws(() => checkTarget('https://telemetry.leangame.autumnofautumn.com', { targetIsStaging: true }), /production/u)
  assert.throws(() => checkTarget('https://staging.example.invalid'), /--target-is-staging/u)
  assert.equal(checkTarget('https://staging.example.invalid', { targetIsStaging: true }).hostname, 'staging.example.invalid')
  assert.equal(checkTarget('http://127.0.0.1:8080').hostname, '127.0.0.1')
  assert.throws(() => checkTarget('ftp://127.0.0.1'), /http/u)
})

test('every shipped scenario is valid', () => {
  for (const file of fs.readdirSync(path.join(BENCH, 'scenarios'))) {
    assert.doesNotThrow(() => loadScenario(path.join(BENCH, 'scenarios', file)), file)
  }
})

test('forecasts count days to each watermark', () => {
  const days = forecast({ usedBytes: 50e9, totalBytes: 150e9, bytesPerDay: 1e9 })
  assert.deepEqual(days, { '70%': 55, '80%': 70, '85%': 77.5 })
  assert.deepEqual(forecast({ usedBytes: 130e9, totalBytes: 150e9, bytesPerDay: 1e9 }), { '70%': 0, '80%': 0, '85%': 0 })
  assert.deepEqual(forecast({ usedBytes: 1, totalBytes: 10, bytesPerDay: 0 }), { '70%': null, '80%': null, '85%': null })
})

test('a short run against a fake collector records acknowledgements and statuses', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tlm-loadgen-'))
  let requests = 0
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      requests++
      if (request.url === '/v1/feedback') return response.writeHead(204).end()
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (requests % 7 === 0) return response.writeHead(503, { 'retry-after': '2' }).end()
      if (request.url === '/v1/events') return response.writeHead(204).end()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ protocol: 2, results: body.events.map((event, index) => ({ index, event_id: event.event_id, status: 'accepted' })) }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const report = await runLoad({
      target: `http://127.0.0.1:${server.address().port}`, origin: 'https://game.test', profile, out: directory,
      scenario: { name: 'fake', protocol: 'mixed', players: 20, feedback_per_1000_events: 50,
        phases: [{ duration_s: 2, events_per_second: 20 }] },
    })
    const phase = report.phases[0]
    assert.ok(phase.sent > 5)
    assert.ok(phase.statuses['503'] >= 1)
    assert.equal(phase.retryAfterSeconds.max, 2)
    const acks = fs.readFileSync(path.join(directory, 'acks.jsonl'), 'utf8').trim().split('\n')
    assert.equal(acks.length, phase.eventsAcked)
    assert.match(fs.readFileSync(path.join(directory, 'report.md'), 'utf8'), /^\| 20\/s \|/mu)
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'report.json'), 'utf8')).scenario, 'fake')
  } finally {
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
