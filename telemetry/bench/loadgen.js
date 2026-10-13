import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BATCH_SIZES, contentHash, createWorkload, exponential, pickWeighted, summarize } from './workload.js'

/** Open-loop load generator for the telemetry collector (docs/benchmark.md).
 *
 *   node bench/loadgen.js --target URL --origin ORIGIN --scenario FILE
 *     [--target-is-staging] [--seed N] [--out DIR] [--rate-scale X] [--duration-scale X]
 *
 * Requests are issued on a Poisson schedule whatever the responses are, so
 * overload shows as rejections and latency instead of a slower client. Every
 * acknowledged event (v1 204; v2 accepted/duplicate) is written to
 * OUT/acks.jsonl with a content hash for bench/verify.js; events sent but not
 * acknowledged go to OUT/unacked.jsonl. The client does not retry: a real
 * browser would, but the benchmark measures the server. Run it from a separate
 * machine against staging — never against production users. */

export const PRODUCTION_HOSTS = Object.freeze(['telemetry.leangame.autumnofautumn.com'])
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export function checkTarget(target, { targetIsStaging = false } = {}) {
  const url = new URL(target)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('target must be an http(s) URL')
  if (PRODUCTION_HOSTS.includes(url.hostname)) {
    throw new Error(`refusing to load-test the production collector ${url.hostname}; use a staging copy (docs/benchmark.md)`)
  }
  if (!LOCAL_HOSTS.has(url.hostname) && !targetIsStaging) {
    throw new Error('a non-local target needs --target-is-staging (it must not serve real players)')
  }
  return url
}

export function loadScenario(file) {
  const scenario = JSON.parse(fs.readFileSync(file, 'utf8'))
  return validateScenario(scenario)
}

export function validateScenario(scenario) {
  if (!Array.isArray(scenario.phases) || scenario.phases.length === 0) throw new Error('scenario needs phases')
  for (const phase of scenario.phases) {
    if (!(phase.duration_s > 0)) throw new Error('each phase needs duration_s > 0')
    if (!(phase.events_per_second >= 0) && !phase.storm) throw new Error('each phase needs events_per_second or storm')
  }
  if (scenario.batch && !BATCH_SIZES[scenario.batch]) throw new Error(`unknown batch distribution ${scenario.batch}`)
  if (scenario.protocol && !['v1', 'v2', 'mixed'].includes(scenario.protocol)) throw new Error('protocol must be v1, v2 or mixed')
  return scenario
}

function mean(sampler, random, samples = 2000) {
  let total = 0
  for (let index = 0; index < samples; index++) total += sampler(random)
  return total / samples
}

/** The request schedule of one phase: [{ at (s from phase start), kind }]. */
export function phaseSchedule(phase, scenario, random, { rateScale = 1, durationScale = 1 } = {}) {
  const duration = phase.duration_s * durationScale
  const schedule = []
  if (phase.storm) {
    // Reconnect/start burst: many clients flush a backlog within a window.
    const { clients, backlog_events: backlog = 10, within_s: within = 5 } = phase.storm
    for (let index = 0; index < clients * rateScale; index++) {
      schedule.push({ at: random() * Math.min(within, duration), kind: 'storm', events: backlog })
    }
  }
  const eventsPerSecond = (phase.events_per_second ?? 0) * rateScale
  if (eventsPerSecond > 0) {
    const batch = BATCH_SIZES[scenario.batch ?? 'client']
    const requestRate = eventsPerSecond / mean(batch, random)
    for (let at = exponential(random, requestRate); at < duration; at += exponential(random, requestRate)) {
      schedule.push({ at, kind: 'events', events: batch(random) })
    }
  }
  const feedbackRate = ((scenario.feedback_per_1000_events ?? 0) / 1000) * eventsPerSecond
  if (feedbackRate > 0) {
    for (let at = exponential(random, feedbackRate); at < duration; at += exponential(random, feedbackRate)) {
      schedule.push({ at, kind: 'feedback' })
    }
  }
  return schedule.sort((left, right) => left.at - right.at)
}

function sendRequest(url, agent, { path: route, origin, body, timeoutMs, mode = 'normal', slowMs = 0 }) {
  const transport = url.protocol === 'https:' ? https : http
  const payload = Buffer.from(body, 'utf8')
  const started = performance.now()
  return new Promise(resolve => {
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      resolve({ ...result, ms: performance.now() - started })
    }
    const request = transport.request(new URL(route, url), {
      method: 'POST',
      agent: mode === 'normal' ? agent : false,
      headers: {
        origin,
        'content-type': 'application/json',
        'content-length': mode === 'truncated' ? payload.length + 1024 : payload.length,
      },
      timeout: timeoutMs,
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => finish({
        status: response.statusCode,
        retryAfter: response.headers['retry-after'] ?? null,
        text: Buffer.concat(chunks).toString('utf8'),
      }))
      response.on('error', () => finish({ status: 'response_error' }))
    })
    request.on('timeout', () => {
      request.destroy()
      finish({ status: 'timeout' })
    })
    request.on('error', error => finish({ status: settled ? 'late_error' : `error:${error.code ?? 'unknown'}` }))
    if (mode === 'slow') {
      // Half the body, a pause past the server's body deadline, then the rest.
      request.write(payload.subarray(0, payload.length >> 1))
      setTimeout(() => request.end(payload.subarray(payload.length >> 1)), slowMs)
    } else if (mode === 'truncated') {
      request.write(payload)
      setTimeout(() => {
        request.destroy()
        finish({ status: 'truncated_by_client' })
      }, 200)
    } else {
      request.end(payload)
    }
  })
}

/** Run a scenario. Returns the report; writes logs to `out` when given. */
export async function runLoad({ target, origin, scenario, seed = 1, out = null, rateScale = 1, durationScale = 1,
  profile = null, targetIsStaging = false, log = () => {} }) {
  const url = checkTarget(target, { targetIsStaging })
  validateScenario(scenario)
  // A scenario may override parts of the measured profile (e.g. a classic-heavy mix).
  profile = { ...(profile ?? {}), ...(scenario.profile_overrides ?? {}) }
  const workload = createWorkload({ seed, players: scenario.players ?? 1000, profile,
    hotUserFraction: scenario.hot_user_fraction ?? 0, gameId: scenario.game_id ?? 'g/local/NNG4' })
  const random = workload.random
  const concurrency = scenario.concurrency ?? 256
  const agent = new (url.protocol === 'https:' ? https : http).Agent({ keepAlive: true, maxSockets: concurrency })
  const timeoutMs = scenario.request_timeout_ms ?? 20000
  const faults = scenario.faults ?? {}
  let acks = null
  let unacked = null
  if (out) {
    fs.mkdirSync(out, { recursive: true })
    acks = fs.openSync(path.join(out, 'acks.jsonl'), 'w')
    unacked = fs.openSync(path.join(out, 'unacked.jsonl'), 'w')
  }
  const recent = []
  const report = { scenario: scenario.name ?? 'unnamed', target: `${url.protocol}//${url.host}`, seed, rateScale,
    durationScale, phases: [], faults: {}, startedAt: new Date().toISOString() }
  let inflight = 0

  function record(file, events, status) {
    if (!file) return
    fs.writeSync(file, events.map(event => `${JSON.stringify({ e: event.event_id, a: event.attempt_uuid, s: event.sequence,
      t: event.event_type, h: contentHash(event), st: status })}\n`).join(''))
  }

  for (const phase of scenario.phases) {
    const schedule = phaseSchedule(phase, scenario, random, { rateScale, durationScale })
    const stats = { name: phase.name ?? `${phase.events_per_second ?? 0}/s`, plannedRequests: schedule.length,
      sent: 0, skippedAtConcurrencyCap: 0, events: 0, eventsAcked: 0, statuses: {}, latencyMs: [], retryAfter: [],
      outcomes: {} }
    const phaseStart = performance.now()
    const pending = []
    log(`phase ${stats.name}: ${schedule.length} requests planned`)
    for (const item of schedule) {
      const wait = phaseStart + item.at * 1000 - performance.now()
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
      if (inflight >= concurrency) {
        stats.skippedAtConcurrencyCap++
        continue
      }
      let fault = item.kind === 'events' ? pickWeighted(random, { none: 1, ...faults }) : 'none'
      // A conflict needs an acknowledged step to reuse; until one exists the
      // request is an ordinary one (never a fresh event counted as a conflict).
      const ackedSteps = fault === 'id_conflict' ? recent.flat().filter(event => event.event_type === 'proof_step') : []
      const conflictSource = ackedSteps.length > 0 ? ackedSteps[Math.floor(random() * ackedSteps.length)] : null
      if (fault === 'id_conflict' && !conflictSource) fault = 'none'
      if (fault === 'duplicate_resend' && recent.length === 0) fault = 'none'
      let events = []
      let route = '/v1/feedback'
      let body
      let mode = 'normal'
      const protocol = scenario.protocol === 'mixed' ? (random() < 0.5 ? 'v1' : 'v2') : (scenario.protocol ?? 'v2')
      if (item.kind === 'feedback') {
        body = JSON.stringify(workload.feedback())
      } else {
        route = `/${protocol}/events`
        if (fault === 'duplicate_resend') {
          events = recent[Math.floor(random() * recent.length)]
        } else if (fault === 'id_conflict') {
          events = [{ ...conflictSource, command: `${conflictSource.command} conflicting` }]
        } else {
          events = workload.next(Math.min(item.events, 50))
        }
        body = JSON.stringify({ events })
        if (fault === 'oversize') body = JSON.stringify({ events, padding: 'x'.repeat(600 * 1024) })
        if (fault === 'slow_body') mode = 'slow'
        if (fault === 'truncated') mode = 'truncated'
      }
      stats.sent++
      stats.events += events.length
      inflight++
      pending.push(sendRequest(url, agent, { path: route, origin, body, timeoutMs, mode, slowMs: scenario.slow_body_ms ?? 12000 })
        .then(result => {
          inflight--
          const key = String(result.status)
          stats.statuses[key] = (stats.statuses[key] ?? 0) + 1
          if (typeof result.status === 'number') stats.latencyMs.push(result.ms)
          if (result.retryAfter !== null && result.retryAfter !== undefined) stats.retryAfter.push(Number(result.retryAfter))
          const faultKey = `${fault}:${key}`
          if (fault !== 'none') report.faults[faultKey] = (report.faults[faultKey] ?? 0) + 1
          if (item.kind === 'feedback') return
          let accepted = []
          if (result.status === 204 && route.startsWith('/v1')) {
            accepted = events.map(event => [event, 'v1'])
          } else if (result.status === 200) {
            const results = JSON.parse(result.text).results ?? []
            accepted = results.filter(item2 => ['accepted', 'duplicate'].includes(item2.status))
              .map(item2 => [events[item2.index], item2.status])
            for (const item2 of results) {
              const outcome = item2.reason ? `${item2.status}:${item2.reason}` : item2.status
              const outcomeKey = fault === 'none' ? outcome : `${fault}->${outcome}`
              stats.outcomes[outcomeKey] = (stats.outcomes[outcomeKey] ?? 0) + 1
            }
          }
          if (fault === 'id_conflict') {
            // A conflicting reuse must never be acknowledged as stored.
            const wrongly = accepted.filter(([, status]) => status === 'accepted').length
            if (wrongly > 0) report.faults['id_conflict:wrongly_accepted'] = (report.faults['id_conflict:wrongly_accepted'] ?? 0) + wrongly
            return
          }
          stats.eventsAcked += accepted.length
          const ackedEvents = accepted.map(([event]) => event)
          record(acks, ackedEvents, 'acked')
          const ackedIds = new Set(ackedEvents.map(event => event.event_id))
          record(unacked, events.filter(event => !ackedIds.has(event.event_id)), String(result.status))
          // Only acknowledged events: a later duplicate or conflict must refer
          // to something the collector really stored.
          if (fault === 'none' && ackedEvents.length > 0) {
            recent.push(ackedEvents)
            if (recent.length > 200) recent.shift()
          }
        }))
    }
    await Promise.all(pending)
    const seconds = (performance.now() - phaseStart) / 1000
    report.phases.push({
      name: stats.name,
      seconds: Number(seconds.toFixed(2)),
      plannedRequests: stats.plannedRequests,
      sent: stats.sent,
      skippedAtConcurrencyCap: stats.skippedAtConcurrencyCap,
      requestsPerSecond: Number((stats.sent / seconds).toFixed(2)),
      eventsPerSecond: Number((stats.events / seconds).toFixed(2)),
      events: stats.events,
      eventsAcked: stats.eventsAcked,
      statuses: stats.statuses,
      latencyMs: Object.fromEntries(Object.entries(summarize(stats.latencyMs))
        .map(([key, value]) => [key, typeof value === 'number' && key !== 'count' ? Number(value.toFixed(1)) : value])),
      retryAfterSeconds: summarize(stats.retryAfter),
      outcomes: stats.outcomes,
    })
  }
  agent.destroy()
  if (acks !== null) fs.closeSync(acks)
  if (unacked !== null) fs.closeSync(unacked)
  report.finishedAt = new Date().toISOString()
  if (out) {
    fs.writeFileSync(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    fs.writeFileSync(path.join(out, 'report.md'), markdown(report))
  }
  return report
}

export function markdown(report) {
  const lines = [`# ${report.scenario}`, '', `Target ${report.target}, seed ${report.seed}, ${report.startedAt} to ${report.finishedAt}.`, '',
    '| Phase | Requests/s | Events/s | Acked | p50 ms | p95 ms | p99 ms | max ms | Statuses | Skipped (cap) |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |']
  for (const phase of report.phases) {
    lines.push(`| ${phase.name} | ${phase.requestsPerSecond} | ${phase.eventsPerSecond} | ${phase.eventsAcked}/${phase.events} | ` +
      `${phase.latencyMs.p50 ?? ''} | ${phase.latencyMs.p95 ?? ''} | ${phase.latencyMs.p99 ?? ''} | ${phase.latencyMs.max ?? ''} | ` +
      `${Object.entries(phase.statuses).map(([key, value]) => `${key}: ${value}`).join(', ')} | ${phase.skippedAtConcurrencyCap} |`)
  }
  if (Object.keys(report.faults).length > 0) {
    lines.push('', 'Fault injection outcomes:', '')
    for (const [key, value] of Object.entries(report.faults)) lines.push(`- ${key}: ${value}`)
  }
  return `${lines.join('\n')}\n`
}

function parseArguments(argv) {
  const options = { seed: 1, rateScale: 1, durationScale: 1, targetIsStaging: false, out: null, profile: null }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    const value = () => argv[++index]
    if (flag === '--target') options.target = value()
    else if (flag === '--origin') options.origin = value()
    else if (flag === '--scenario') options.scenarioFile = value()
    else if (flag === '--seed') options.seed = Number(value())
    else if (flag === '--out') options.out = value()
    else if (flag === '--profile') options.profile = value()
    else if (flag === '--rate-scale') options.rateScale = Number(value())
    else if (flag === '--duration-scale') options.durationScale = Number(value())
    else if (flag === '--target-is-staging') options.targetIsStaging = true
    else throw new Error(`unknown argument ${flag}`)
  }
  if (!options.target || !options.origin || !options.scenarioFile) {
    throw new Error('usage: loadgen.js --target URL --origin ORIGIN --scenario FILE [--target-is-staging] [--out DIR]')
  }
  return options
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2))
    const here = path.dirname(fileURLToPath(import.meta.url))
    const profile = JSON.parse(fs.readFileSync(options.profile ?? path.join(here, 'profiles', 'sample-2026-10.json'), 'utf8'))
    const scenario = loadScenario(options.scenarioFile)
    const out = options.out ?? path.join('bench-results', `${scenario.name ?? 'run'}-${new Date().toISOString().replace(/[:.]/gu, '')}`)
    const report = await runLoad({ ...options, scenario, profile, out, log: message => console.error(message) })
    process.stdout.write(markdown(report))
    console.error(`results in ${out}`)
  } catch (error) {
    console.error(`loadgen: ${error.message}`)
    process.exitCode = 1
  }
}
