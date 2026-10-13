import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { ConfigError, connection, integer } from '../src/env.js'
import { formatPgTimestamp, microsFromSql, sqlMicros } from '../src/trajectory/codec.js'
import { ATTEMPT_COLUMNS, attemptFromRow, DEFAULT_READ_LIMITS, readAttemptDetail } from '../src/trajectory/reader.js'
import { csvRow, jsonbText } from './pg-text.js'
import { XlsxWriter } from './xlsx.js'

/** Streaming telemetry export (docs/exports.md).
 *
 *   node tools/export.js [--format csv|jsonl|xlsx] [--output FILE]
 *     [--since ISO] [--until ISO] [--game GAME_ID] [--attempt UUID]...
 *     [--resume] [--no-feedback] [--users-per-page N]
 *
 * csv    the lossless machine export: the same 29 columns, field meanings and
 *        PostgreSQL text conventions as before (NULL vs empty string, t/f,
 *        jsonb text, UTC timestamps), one row per attempt, step and feedback.
 * jsonl  every field, including ingestion times, start/completion identities
 *        and per-attempt replay completeness, one JSON object per attempt or
 *        feedback report.
 * xlsx   the human export: the CSV's rows with every cell typed as text.
 *
 * Steps come from the shared reader, so live, compacted and mixed attempts
 * export identically. Rows are grouped by pseudonymous user in user-id order
 * (each user's attempts by start time, each followed by its steps in
 * sequence, then the user's feedback; feedback without a user last) using
 * indexes rather than a global sort. Memory is bounded per attempt.
 *
 * The output is written to FILE.partial and renamed when complete, with a
 * manifest beside it (FILE.manifest.json). After each page of users the
 * output is synced and FILE.checkpoint.json records where to continue;
 * `--resume` (csv/jsonl) truncates FILE.partial to the last checkpoint and
 * continues, so an interrupted export has neither duplicates nor gaps.
 *
 * Connection: READER_DATABASE_URL(_FILE), or PGHOST/PGPORT/PGDATABASE with
 * READER_PGUSER and READER_PGPASSWORD(_FILE) (role telemetry_reader, whose
 * statement_timeout, work_mem and temp_file_limit bound each query). */

export const COLUMNS = Object.freeze([
  'record_type', 'record_id', 'record_ts', 'user_id', 'user_first_seen', 'user_last_seen', 'attempt_id',
  'source_attempt_id', 'game_id', 'world_id', 'level_id', 'mode', 'attempt_started_at', 'attempt_completed_at',
  'attempt_duration_ms', 'attempt_completed', 'step_sequence', 'step_elapsed_ms', 'step_type', 'step_command',
  'step_from_line', 'step_removed_lines', 'initial_script', 'play_script', 'lean_script', 'feedback_message',
  'feedback_proof_state', 'feedback_received_at', 'attributes',
])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const FIRST_UUID = '00000000-0000-0000-0000-000000000000'

export function parseArguments(argv, now = new Date()) {
  const options = {
    format: 'csv', output: null, since: null, until: null, gameId: null, attemptIds: null, resume: false,
    feedback: true, usersPerPage: 200,
  }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    const value = () => {
      if (index + 1 >= argv.length) throw new ConfigError(`${flag} needs a value`)
      return argv[++index]
    }
    if (flag === '--format') options.format = value()
    else if (flag === '--output' || flag === '-o') options.output = value()
    else if (flag === '--since') options.since = value()
    else if (flag === '--until') options.until = value()
    else if (flag === '--game') options.gameId = value()
    else if (flag === '--attempt') (options.attemptIds ??= []).push(value())
    else if (flag === '--resume') options.resume = true
    else if (flag === '--no-feedback') options.feedback = false
    else if (flag === '--users-per-page') options.usersPerPage = Number(value())
    else if (!flag.startsWith('-') && options.output === null) options.output = flag
    else throw new ConfigError(`unknown argument ${flag}`)
  }
  if (!['csv', 'jsonl', 'xlsx'].includes(options.format)) throw new ConfigError('--format must be csv, jsonl or xlsx')
  for (const key of ['since', 'until']) {
    if (options[key] !== null && Number.isNaN(new Date(options[key]).getTime())) throw new ConfigError(`--${key} must be a date`)
  }
  if (options.attemptIds?.some(id => !UUID_RE.test(id))) throw new ConfigError('--attempt must be a UUID')
  if (!(Number.isInteger(options.usersPerPage) && options.usersPerPage >= 1 && options.usersPerPage <= 5000)) {
    throw new ConfigError('--users-per-page must be between 1 and 5000')
  }
  if (options.resume && options.format === 'xlsx') throw new ConfigError('--resume supports csv and jsonl; rerun xlsx exports')
  options.output ??= `./telemetry-export-${now.toISOString().replace(/[-:]/gu, '').slice(0, 15)}Z.${options.format}`
  return options
}

const ts = micros => (micros === null ? null : formatPgTimestamp(micros))

function attemptCsv(attempt, attributesText) {
  return [
    'attempt', attempt.attemptId, ts(attempt.startedAtUs), attempt.userId, ts(attempt.userFirstSeenUs),
    ts(attempt.userLastSeenUs), attempt.attemptId, attempt.sourceAttemptId, attempt.gameId, attempt.worldId,
    attempt.levelId, attempt.mode, ts(attempt.startedAtUs), ts(attempt.completedAtUs), attempt.durationMs,
    attempt.completed, null, null, null, null, null, null, attempt.initialScript, attempt.playScript,
    attempt.leanScript, null, null, null, attributesText,
  ]
}

function stepCsv(attempt, action) {
  return [
    'step', action.eventId, ts(action.clientTsUs), attempt.userId, ts(attempt.userFirstSeenUs),
    ts(attempt.userLastSeenUs), attempt.attemptId, attempt.sourceAttemptId, attempt.gameId, attempt.worldId,
    attempt.levelId, attempt.mode, ts(attempt.startedAtUs), ts(attempt.completedAtUs), attempt.durationMs,
    attempt.completed, action.sequence, action.elapsedMs, action.stepType, action.command, action.fromLine,
    action.removedLines, null, null, null, null, null, null, jsonbText(action.attributes),
  ]
}

function feedbackCsv(feedback, user) {
  return [
    'feedback', feedback.report_id, ts(microsFromSql(feedback.client_ts_us)), feedback.user_id,
    ts(user?.firstSeenUs ?? null), ts(user?.lastSeenUs ?? null), null, null, feedback.game_id, feedback.world_id,
    feedback.level_id, feedback.mode, null, null, null, null, null, null, null, null, null, null, null, null, null,
    feedback.message, feedback.proof_state, ts(microsFromSql(feedback.received_at_us)), feedback.attributes,
  ]
}

function attemptJson(result) {
  const { attempt } = result
  return {
    type: 'attempt',
    attempt_id: attempt.attemptId,
    source_attempt_id: attempt.sourceAttemptId,
    user: { user_id: attempt.userId, first_seen: ts(attempt.userFirstSeenUs), last_seen: ts(attempt.userLastSeenUs) },
    game_id: attempt.gameId,
    world_id: attempt.worldId,
    level_id: attempt.levelId,
    mode: attempt.mode,
    started_at: ts(attempt.startedAtUs),
    completed: attempt.completed,
    completed_at: ts(attempt.completedAtUs),
    duration_ms: attempt.durationMs,
    initial_script: attempt.initialScript,
    play_script: attempt.playScript,
    lean_script: attempt.leanScript,
    attributes: attempt.attributes,
    received_at: ts(attempt.receivedAtUs),
    last_received_at: ts(attempt.lastReceivedAtUs),
    start: { event_id: attempt.startEventId, sequence: attempt.startSequence, client_ts: ts(attempt.startClientTsUs),
      elapsed_ms: attempt.startElapsedMs },
    completion: { event_id: attempt.completionEventId, sequence: attempt.completionSequence,
      received_at: ts(attempt.completionReceivedAtUs) },
    later_completion_sequences: attempt.laterCompletionSequences,
    detail_expired_at: ts(attempt.detailExpiredAtUs),
    steps: result.actions.map(action => ({
      event_id: action.eventId,
      sequence: action.sequence,
      client_ts: ts(action.clientTsUs),
      client_ts_us: action.clientTsUs,
      elapsed_ms: action.elapsedMs,
      step_type: action.stepType,
      command: action.command,
      from_line: action.fromLine,
      removed_lines: action.removedLines,
      attributes: action.attributes,
      received_at: ts(action.receivedAtUs),
    })),
    completeness: result.completeness,
    errors: result.errors,
    sources: { live_rows: result.sources.liveRows, from_chunks: result.sources.fromChunks },
  }
}

function feedbackJson(feedback, user) {
  return {
    type: 'feedback',
    report_id: feedback.report_id,
    user: feedback.user_id ? { user_id: feedback.user_id, first_seen: ts(user?.firstSeenUs ?? null), last_seen: ts(user?.lastSeenUs ?? null) } : null,
    game_id: feedback.game_id,
    world_id: feedback.world_id,
    level_id: feedback.level_id,
    mode: feedback.mode,
    message: feedback.message,
    proof_state: JSON.parse(feedback.proof_state),
    client_ts: ts(microsFromSql(feedback.client_ts_us)),
    received_at: ts(microsFromSql(feedback.received_at_us)),
    attributes: JSON.parse(feedback.attributes),
  }
}

/** Output sinks: rows go out as CSV rows, JSON lines or spreadsheet rows. */
function textSink(file, format, { append }) {
  const fd = fs.openSync(file, append ? 'r+' : 'w')
  let position = append ? fs.fstatSync(fd).size : 0
  const write = text => {
    const buffer = Buffer.from(text, 'utf8')
    fs.writeSync(fd, buffer, 0, buffer.length, position)
    position += buffer.length
  }
  if (!append && format === 'csv') write(csvRow(COLUMNS))
  return {
    attempt: async (result, attributesText) => {
      if (format === 'csv') {
        let text = csvRow(attemptCsv(result.attempt, attributesText))
        for (const action of result.actions) text += csvRow(stepCsv(result.attempt, action))
        write(text)
      } else {
        write(`${JSON.stringify(attemptJson(result))}\n`)
      }
    },
    feedback: async (row, user) => write(format === 'csv' ? csvRow(feedbackCsv(row, user)) : `${JSON.stringify(feedbackJson(row, user))}\n`),
    sync: () => {
      fs.fsyncSync(fd)
      return position
    },
    truncate: size => {
      fs.ftruncateSync(fd, size)
      position = size
    },
    close: async () => {
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      return {}
    },
  }
}

function xlsxSink(file) {
  const writer = new XlsxWriter(file, COLUMNS)
  return {
    attempt: async (result, attributesText) => {
      await writer.addRow(attemptCsv(result.attempt, attributesText).map(spreadsheetText))
      for (const action of result.actions) await writer.addRow(stepCsv(result.attempt, action).map(spreadsheetText))
    },
    feedback: async (row, user) => writer.addRow(feedbackCsv(row, user).map(spreadsheetText)),
    sync: () => null,
    close: () => writer.close(),
  }
}

/** Spreadsheet text for a CSV-model value: booleans as t/f like the CSV. */
function spreadsheetText(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? 't' : 'f'
  return String(value)
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(temporary, file)
}

const ACTIVITY = `COALESCE(a.last_received_at, a.received_at, (SELECT applied_at FROM schema_migrations WHERE version = '005'))`

/** Run an export. Returns the manifest. */
export async function runExport(pool, options, { limits = DEFAULT_READ_LIMITS, log = () => {} } = {}) {
  const output = path.resolve(options.output)
  const partial = `${output}.partial`
  const checkpointFile = `${output}.checkpoint.json`
  const filters = { since: options.since, until: options.until, gameId: options.gameId, attemptIds: options.attemptIds,
    feedback: options.feedback }

  let state = { version: 1, format: options.format, filters, phase: 'users', userCursor: FIRST_UUID,
    feedbackCursor: null, bytes: 0,
    counts: { users: 0, attempts: 0, steps: 0, feedback: 0, incompleteAttempts: 0, attemptsWithErrors: 0 }, errors: [],
    startedAt: new Date().toISOString() }
  if (options.resume) {
    let saved
    try {
      saved = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'))
    } catch {
      throw new ConfigError(`nothing to resume: ${checkpointFile} is missing`)
    }
    if (saved.format !== options.format || JSON.stringify(saved.filters) !== JSON.stringify(filters)) {
      throw new ConfigError('--resume needs the same format and filters as the interrupted export')
    }
    state = saved
  }
  const sink = options.format === 'xlsx'
    ? xlsxSink(partial)
    : textSink(partial, options.format, { append: options.resume })
  if (options.resume) sink.truncate(state.bytes)

  const attemptWhere = []
  const attemptParams = []
  const addParam = value => `$${attemptParams.push(value) + 3}`
  if (options.since) attemptWhere.push(`${ACTIVITY} >= ${addParam(new Date(options.since))}::timestamptz`)
  if (options.until) attemptWhere.push(`${ACTIVITY} < ${addParam(new Date(options.until))}::timestamptz`)
  if (options.gameId) attemptWhere.push(`a.game_id = ${addParam(options.gameId)}`)
  if (options.attemptIds) attemptWhere.push(`a.attempt_id = ANY(${addParam(options.attemptIds)}::uuid[])`)
  const attemptSql = `
    SELECT ${ATTEMPT_COLUMNS}, a.attributes::text AS attributes_text, ${sqlMicros('a.started_at')}::text AS started_key
    FROM proof_attempts a LEFT JOIN anonymous_users u ON u.user_id = a.user_id
    WHERE a.user_id = $1::uuid
      AND (a.started_at, a.attempt_id) > (timestamptz 'epoch' + $2::bigint * interval '1 microsecond', $3::uuid)
      ${attemptWhere.map(clause => `AND ${clause}`).join(' ')}
    ORDER BY a.started_at, a.attempt_id LIMIT 200`

  const feedbackWhere = []
  const feedbackParams = []
  const addFeedbackParam = value => `$${feedbackParams.push(value) + 3}`
  if (options.since) feedbackWhere.push(`f.received_at >= ${addFeedbackParam(new Date(options.since))}::timestamptz`)
  if (options.until) feedbackWhere.push(`f.received_at < ${addFeedbackParam(new Date(options.until))}::timestamptz`)
  if (options.gameId) feedbackWhere.push(`f.game_id = ${addFeedbackParam(options.gameId)}`)
  const feedbackColumns = `f.report_id::text, f.user_id::text, f.game_id, f.world_id, f.level_id, f.mode::text, f.message,
    f.proof_state::text, ${sqlMicros('f.client_ts')} AS client_ts_us, ${sqlMicros('f.received_at')} AS received_at_us,
    f.attributes::text`
  const includeFeedback = options.feedback && !options.attemptIds

  function noteResult(result) {
    state.counts.attempts++
    state.counts.steps += result.actions.length
    if (!result.completeness.complete) state.counts.incompleteAttempts++
    if (result.errors.length > 0) {
      state.counts.attemptsWithErrors++
      if (state.errors.length < 1000) state.errors.push({ attempt_id: result.attempt.attemptId, codes: result.errors.map(error => error.code) })
    }
  }

  async function exportUser(user) {
    let wrote = false
    let key = ['-9007199254740991', FIRST_UUID]
    for (;;) {
      const rows = (await pool.query(attemptSql, [user.userId, key[0], key[1], ...attemptParams])).rows
      for (const row of rows) {
        const result = await readAttemptDetail(pool, attemptFromRow(row), { limits })
        await sink.attempt(result, row.attributes_text)
        noteResult(result)
        wrote = true
        key = [row.started_key, row.attempt_id]
      }
      if (rows.length < 200) break
    }
    if (includeFeedback) {
      let feedbackKey = ['-9007199254740991', FIRST_UUID]
      for (;;) {
        const rows = (await pool.query(`SELECT ${feedbackColumns}, ${sqlMicros('f.received_at')}::text AS received_key
          FROM feedback_reports f
          WHERE f.user_id = $1::uuid
            AND (f.received_at, f.report_id) > (timestamptz 'epoch' + $2::bigint * interval '1 microsecond', $3::uuid)
            ${feedbackWhere.map(clause => `AND ${clause}`).join(' ')}
          ORDER BY f.received_at, f.report_id LIMIT 500`, [user.userId, feedbackKey[0], feedbackKey[1], ...feedbackParams])).rows
        for (const row of rows) {
          await sink.feedback(row, user)
          state.counts.feedback++
          wrote = true
          feedbackKey = [row.received_key, row.report_id]
        }
        if (rows.length < 500) break
      }
    }
    if (wrote) state.counts.users++
  }

  function checkpoint() {
    const bytes = sink.sync()
    if (bytes === null) return
    state.bytes = bytes
    writeJsonAtomic(checkpointFile, state)
  }

  try {
    while (state.phase === 'users') {
      const users = (await pool.query(`
        SELECT user_id::text, ${sqlMicros('first_seen')} AS first_us, ${sqlMicros('last_seen')} AS last_us
        FROM anonymous_users WHERE user_id > $1::uuid ORDER BY user_id LIMIT $2`,
      [state.userCursor, options.usersPerPage])).rows
      for (const row of users) {
        await exportUser({ userId: row.user_id, firstSeenUs: microsFromSql(row.first_us), lastSeenUs: microsFromSql(row.last_us) })
      }
      if (users.length > 0) state.userCursor = users.at(-1).user_id
      if (users.length < options.usersPerPage) {
        state.phase = includeFeedback ? 'anonymous-feedback' : 'done'
        state.feedbackCursor = ['-9007199254740991', FIRST_UUID]
      }
      checkpoint()
      log('info', 'export progress', { users: state.counts.users, attempts: state.counts.attempts })
    }
    while (state.phase === 'anonymous-feedback') {
      const rows = (await pool.query(`SELECT ${feedbackColumns}, ${sqlMicros('f.received_at')}::text AS received_key
        FROM feedback_reports f
        WHERE f.user_id IS NULL
          AND (f.received_at, f.report_id) > (timestamptz 'epoch' + $2::bigint * interval '1 microsecond', $3::uuid)
          AND $1::int IS NULL
          ${feedbackWhere.map(clause => `AND ${clause}`).join(' ')}
        ORDER BY f.received_at, f.report_id LIMIT 500`, [null, state.feedbackCursor[0], state.feedbackCursor[1], ...feedbackParams])).rows
      for (const row of rows) {
        await sink.feedback(row, null)
        state.counts.feedback++
        state.feedbackCursor = [row.received_key, row.report_id]
      }
      if (rows.length < 500) state.phase = 'done'
      checkpoint()
    }
    const spreadsheet = await sink.close()
    fs.renameSync(partial, output)
    const manifest = {
      format: options.format,
      output: path.basename(output),
      columns: options.format === 'jsonl' ? undefined : COLUMNS,
      filters,
      order: 'users by user_id; attempts by started_at with their steps by sequence; then the user\'s feedback; feedback without a user last',
      started_at: state.startedAt,
      finished_at: new Date().toISOString(),
      counts: state.counts,
      attempt_errors: state.errors,
      ...(options.format === 'xlsx' ? { spreadsheet } : {}),
    }
    writeJsonAtomic(`${output}.manifest.json`, manifest)
    fs.rmSync(checkpointFile, { force: true })
    return manifest
  } catch (error) {
    // Keep the partial file and checkpoint for --resume.
    await Promise.resolve(options.format === 'xlsx' ? null : sink.close()).catch(() => {})
    throw error
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options
  let pool
  try {
    options = parseArguments(process.argv.slice(2))
    pool = new pg.Pool({
      ...connection(process.env, 'READER_'),
      max: 1,
      application_name: 'telemetry-export',
      statement_timeout: integer(process.env, 'EXPORT_STATEMENT_TIMEOUT_MS', 60000, { min: 1000 }),
    })
  } catch (error) {
    console.error(`export: ${error.message}`)
    process.exit(2)
  }
  runExport(pool, options, { log: (level, message, fields) => console.error(JSON.stringify({ level, message, ...fields })) })
    .then(manifest => console.error(`Wrote ${options.output} (${manifest.counts.attempts} attempts, ` +
      `${manifest.counts.steps} steps, ${manifest.counts.feedback} feedback reports)`),
    error => {
      console.error(`export failed: ${error.message}`)
      process.exitCode = 1
    })
    .finally(() => pool.end())
}
