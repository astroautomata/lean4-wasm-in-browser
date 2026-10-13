import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { connection } from '../src/env.js'
import { readAttempt } from '../src/trajectory/reader.js'
import { contentHash } from './workload.js'

/** Verify a load run against the database (docs/benchmark.md):
 *
 *   READER_DATABASE_URL=... node bench/verify.js RESULTS_DIR
 *
 * Every acknowledged event must be stored exactly once with identical content,
 * whether it is a live row or inside a compacted chunk (read through the
 * shared reader). Also reports events stored although their request was not
 * acknowledged (expected after timeouts: the commit may succeed after the
 * client gave up) and the replay completeness of the attempts involved. Exits
 * 1 if any acknowledged event is missing or differs. */

/** Rebuild the wire fields contentHash() covers from stored data. Client
 * timestamps are compared in the ISO form clients send (milliseconds). */
function storedWireSteps(result) {
  const attempt = result.attempt
  const base = {
    attempt_uuid: attempt.attemptId, user_uuid: attempt.userId, game_id: attempt.gameId, world_id: attempt.worldId,
    level_id: attempt.levelId, mode: attempt.mode,
  }
  const iso = micros => new Date(Math.floor(micros / 1000)).toISOString()
  const events = result.actions.map(action => ({
    ...base, event_id: action.eventId, event_type: 'proof_step', sequence: action.sequence, ts: iso(action.clientTsUs),
    elapsed_ms: action.elapsedMs, step_type: action.stepType, command: action.command,
    ...(action.fromLine !== null ? { from_line: action.fromLine, removed_lines: action.removedLines } : {}),
  }))
  if (attempt.startEventId) {
    events.push({ ...base, event_id: attempt.startEventId, event_type: 'level_start', sequence: attempt.startSequence,
      ts: iso(attempt.startClientTsUs), elapsed_ms: attempt.startElapsedMs,
      ...(attempt.initialScript !== null ? { initial_script: attempt.initialScript } : {}),
      ...(attempt.sourceAttemptId !== null ? { source_attempt_uuid: attempt.sourceAttemptId } : {}) })
  }
  if (attempt.completionEventId) {
    events.push({ ...base, event_id: attempt.completionEventId, event_type: 'level_complete',
      sequence: attempt.completionSequence, ts: iso(attempt.completedAtUs), elapsed_ms: attempt.durationMs,
      ...(attempt.playScript !== null ? { play_script: attempt.playScript } : {}),
      ...(attempt.leanScript !== null ? { lean_script: attempt.leanScript } : {}) })
  }
  return events
}

async function readLog(file) {
  const entries = new Map()
  if (!fs.existsSync(file)) return entries
  const lines = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line) continue
    const entry = JSON.parse(line)
    entries.set(entry.e, entry)
  }
  return entries
}

export async function verifyRun(queryable, directory, { log = () => {} } = {}) {
  const acked = await readLog(path.join(directory, 'acks.jsonl'))
  const unacked = await readLog(path.join(directory, 'unacked.jsonl'))
  for (const id of acked.keys()) unacked.delete(id)
  const byAttempt = new Map()
  for (const [kind, log] of [['acked', acked], ['unacked', unacked]]) {
    for (const entry of log.values()) {
      if (!byAttempt.has(entry.a)) byAttempt.set(entry.a, { acked: [], unacked: [] })
      byAttempt.get(entry.a)[kind].push(entry)
    }
  }
  const attempts = byAttempt.keys()
  const report = {
    acknowledged: acked.size, unacknowledged: unacked.size, attempts: byAttempt.size,
    missing: 0, mismatched: 0, storedTwice: 0, storedUnacknowledged: 0,
    incompleteAttempts: 0, readerErrors: 0, examples: [],
  }
  let checked = 0
  for (const attemptId of attempts) {
    const result = await readAttempt(queryable, attemptId)
    const stored = new Map()
    if (result) {
      if (result.errors.length > 0) report.readerErrors++
      if (!result.completeness.complete) report.incompleteAttempts++
      for (const event of storedWireSteps(result)) {
        if (stored.has(event.event_id)) report.storedTwice++
        stored.set(event.event_id, event)
      }
    }
    for (const entry of byAttempt.get(attemptId).acked) {
      const event = stored.get(entry.e)
      if (!event) {
        report.missing++
        if (report.examples.length < 20) report.examples.push({ problem: 'missing', event_id: entry.e, type: entry.t })
      } else if (contentHash(event) !== entry.h) {
        report.mismatched++
        if (report.examples.length < 20) report.examples.push({ problem: 'mismatched', event_id: entry.e, type: entry.t })
      }
    }
    for (const entry of byAttempt.get(attemptId).unacked) {
      if (stored.has(entry.e)) report.storedUnacknowledged++
    }
    if (++checked % 1000 === 0) log(`checked ${checked}/${byAttempt.size} attempts`)
  }
  report.ok = report.missing === 0 && report.mismatched === 0 && report.storedTwice === 0
  return report
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2]
  if (!directory) {
    console.error('usage: READER_DATABASE_URL=... node bench/verify.js RESULTS_DIR')
    process.exit(2)
  }
  const pool = new pg.Pool({ ...connection(process.env, 'READER_'), max: 2, application_name: 'telemetry-bench-verify' })
  verifyRun(pool, directory, { log: message => console.error(message) })
    .then(report => {
      fs.writeFileSync(path.join(directory, 'verify.json'), `${JSON.stringify(report, null, 2)}\n`)
      console.log(JSON.stringify(report, null, 2))
      process.exitCode = report.ok ? 0 : 1
    }, error => {
      console.error(`verify failed: ${error.message}`)
      process.exitCode = 1
    })
    .finally(() => pool.end())
}
