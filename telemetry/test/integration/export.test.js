import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { historicIngestionBound } from '../../src/migrate.js'
import { createCompactor } from '../../src/trajectory/compactor.js'
import { validateFeedback } from '../../src/validation.js'
import { COLUMNS, parseArguments, runExport } from '../../tools/export.js'
import { csvField } from '../../tools/pg-text.js'
import { readZip, sheetRows } from '../helpers/xlsx.js'
import { attemptEvents, event, writerFixture } from '../helpers/collector.js'
import { skipWithoutDatabase } from '../helpers/database.js'

const skip = skipWithoutDatabase
const TELEMETRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The query export-telemetry.sh ran before (psql COPY ... CSV), with each
 * column rendered as COPY renders it: the oracle for field meanings. */
const LEGACY_SQL = `
  WITH records AS (
    SELECT 'attempt'::text AS record_type, 0 AS kind_order, a.attempt_id AS record_id, a.started_at AS record_ts,
           a.user_id, a.attempt_id, a.game_id, a.world_id, a.level_id, a.mode::text AS mode,
           NULL::integer AS step_sequence, NULL::integer AS step_elapsed_ms, NULL::text AS step_type, NULL::text AS step_command,
           NULL::integer AS step_from_line, NULL::integer AS step_removed_lines,
           a.initial_script, a.play_script, a.lean_script,
           NULL::text AS feedback_message, NULL::jsonb AS feedback_proof_state, NULL::timestamptz AS feedback_received_at,
           a.attributes
    FROM proof_attempts a
    UNION ALL
    SELECT 'step', 1, s.event_id, s.client_ts, a.user_id, a.attempt_id, a.game_id, a.world_id, a.level_id, a.mode::text,
           s.sequence, s.elapsed_ms, s.step_type::text, s.command, s.from_line, s.removed_lines,
           NULL, NULL, NULL, NULL, NULL, NULL, s.attributes
    FROM proof_steps s JOIN proof_attempts a ON a.attempt_id = s.attempt_id
    UNION ALL
    SELECT 'feedback', 2, f.report_id, f.client_ts, f.user_id, NULL, f.game_id, f.world_id, f.level_id, f.mode::text,
           NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, f.message, f.proof_state, f.received_at, f.attributes
    FROM feedback_reports f
  )
  SELECT r.record_type, r.record_id::text, r.record_ts::text, r.user_id::text, u.first_seen::text, u.last_seen::text,
         r.attempt_id::text, a.source_attempt_id::text, r.game_id, r.world_id, r.level_id::text, r.mode,
         a.started_at::text, a.completed_at::text, a.duration_ms::text,
         CASE WHEN a.completed THEN 't' WHEN NOT a.completed THEN 'f' END,
         r.step_sequence::text, r.step_elapsed_ms::text, r.step_type, r.step_command, r.step_from_line::text,
         r.step_removed_lines::text, r.initial_script, r.play_script, r.lean_script, r.feedback_message,
         r.feedback_proof_state::text, r.feedback_received_at::text, r.attributes::text
  FROM records r
  LEFT JOIN anonymous_users u ON u.user_id = r.user_id
  LEFT JOIN proof_attempts a ON a.attempt_id = r.attempt_id`

async function legacyRecords(pool) {
  const client = await pool.connect()
  try {
    await client.query(`SET TIME ZONE 'UTC'`)
    const result = await client.query({ text: LEGACY_SQL, rowMode: 'array' })
    return result.rows.map(row => `${row.map(csvField).join(',')}\n`)
  } finally {
    client.release()
  }
}

/** Split CSV text into raw records (quoted newlines stay inside a record). */
function records(text) {
  const out = []
  let start = 0
  let quoted = false
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '"') quoted = !quoted
    else if (text[index] === '\n' && !quoted) {
      out.push(text.slice(start, index + 1))
      start = index + 1
    }
  }
  return out
}

async function seed({ writer, database }) {
  const visual = attemptEvents({ steps: 4, complete: true })
  const shared = { user_uuid: crypto.randomUUID(), attempt_uuid: crypto.randomUUID(), mode: 'classic' }
  const classic = [
    event({ ...shared, event_type: 'level_start', sequence: 0, elapsed_ms: 0, initial_script: '',
      source_attempt_uuid: visual[0].attemptId, build: { site: '3c14d15a1b2c' }, platform: { browser: 'safari', device: 'mobile' } }),
    event({ ...shared, sequence: 1, elapsed_ms: 5, step_type: 'edit', from_line: 0, removed_lines: 0,
      command: '=HYPERLINK("http://example.invalid")\n+1, "quoted"' }),
    event({ ...shared, sequence: 2, elapsed_ms: 6, step_type: 'edit', from_line: 0, removed_lines: 1, command: '' }),
  ]
  const unsolved = attemptEvents({ steps: 2, user_uuid: visual[0].userId })
  await writer.writeEvents([...visual, ...classic, ...unsolved])
  for (const [userId, message] of [[visual[0].userId, '@SUM(A1)\r\nunicode ∀ 🎉'], [null, '-cmd']]) {
    const feedback = validateFeedback({ report_id: crypto.randomUUID(), ...(userId ? { user_uuid: userId } : {}),
      game_id: 'g/local/NNG4', world_id: 'Tutorial', level_id: 2, mode: 'visual', message,
      proof_state: { proofBody: 'intro n', nested: { list: [1, 'x', null] } }, ts: '2026-08-04T12:00:00.5Z',
      build: { site: '3c14d15a1b2c' }, platform: { browser: 'edge', device: 'desktop' } })
    await database.storeFeedback(feedback.feedback)
  }
  return { visual, classic, unsolved, classicAttemptId: shared.attempt_uuid }
}

async function withExport(run) {
  const fixture = await writerFixture()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tlm-export-'))
  try {
    await run({ ...fixture, directory, out: name => path.join(directory, name) })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
    await fixture.close()
  }
}

test('the CSV keeps the columns and every field of the previous psql export', { skip }, async () => {
  await withExport(async fixture => {
    await seed(fixture)
    const file = fixture.out('export.csv')
    const manifest = await runExport(fixture.db.pools.reader, parseArguments(['--output', file]))
    const text = fs.readFileSync(file, 'utf8')
    const [header, ...rows] = records(text)
    assert.equal(header, `${COLUMNS.join(',')}\n`)
    // The platform reaches the attributes column as PostgreSQL's jsonb text.
    assert.ok(rows.some(row => row.includes('"{""build"": {""site"": ""3c14d15a1b2c""}, ""platform"": {""device"": ""mobile"", ""browser"": ""safari""}}"')),
      'attempt attributes with build and platform')
    assert.deepEqual([...rows].sort(), (await legacyRecords(fixture.db.pools.admin)).sort())
    assert.deepEqual(manifest.counts, { users: 2, attempts: 3, steps: 8, feedback: 2, incompleteAttempts: 0, attemptsWithErrors: 0 })
    assert.equal(fs.existsSync(`${file}.partial`), false)
    assert.equal(fs.existsSync(`${file}.checkpoint.json`), false)
  })
})

test('compacted and mixed attempts export byte-identically to their live form', { skip }, async () => {
  await withExport(async fixture => {
    const { visual } = await seed(fixture)
    const before = fixture.out('before.csv')
    await runExport(fixture.db.pools.reader, parseArguments(['--output', before]))
    const beforeJsonl = fixture.out('before.jsonl')
    await runExport(fixture.db.pools.reader, parseArguments(['--format', 'jsonl', '--output', beforeJsonl]))
    const historicBound = await historicIngestionBound(fixture.db.pools.admin)
    const compactor = createCompactor({ pool: fixture.db.pools.compactor, historicBound,
      settings: { mode: 'replace', minAgeSeconds: 0, inactiveSeconds: 0, replaceDelaySeconds: 0, chunkMaxEvents: 2 } })
    // Only the visual attempt, partly: a mixed live/compacted attempt.
    await compactor.compactAttempt({ attempt_id: visual[0].attemptId, completed: true, inactive: true })
    await compactor.replacePass()
    const live = await fixture.db.pools.admin.query('SELECT count(*)::int AS n FROM proof_steps WHERE attempt_id = $1', [visual[0].attemptId])
    assert.equal(live.rows[0].n, 0)
    const after = fixture.out('after.csv')
    await runExport(fixture.db.pools.reader, parseArguments(['--output', after]))
    assert.equal(fs.readFileSync(after, 'utf8'), fs.readFileSync(before, 'utf8'))
    const afterJsonl = fixture.out('after.jsonl')
    await runExport(fixture.db.pools.reader, parseArguments(['--format', 'jsonl', '--output', afterJsonl]))
    const strip = text => text.trim().split('\n').map(line => {
      const record = JSON.parse(line)
      delete record.sources
      return record
    })
    assert.deepEqual(strip(fs.readFileSync(afterJsonl, 'utf8')), strip(fs.readFileSync(beforeJsonl, 'utf8')))
  })
})

test('JSONL carries identities, ingestion times, completeness and attempt attributes', { skip }, async () => {
  await withExport(async fixture => {
    const { visual, classicAttemptId } = await seed(fixture)
    const file = fixture.out('export.jsonl')
    await runExport(fixture.db.pools.reader, parseArguments(['--format', 'jsonl', '--output', file]))
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const attempt = lines.find(line => line.type === 'attempt' && line.attempt_id === visual[0].attemptId)
    assert.equal(attempt.start.event_id, visual[0].eventId)
    assert.equal(attempt.completion.sequence, 5)
    assert.equal(attempt.completeness.complete, true)
    assert.match(attempt.steps[0].received_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/u)
    assert.equal(lines.filter(line => line.type === 'feedback').length, 2)
    const classic = lines.find(line => line.type === 'attempt' && line.attempt_id === classicAttemptId)
    assert.deepEqual(classic.attributes, { build: { site: '3c14d15a1b2c' }, platform: { browser: 'safari', device: 'mobile' } })
    const reports = lines.filter(line => line.type === 'feedback').map(line => line.attributes.platform ?? null)
    assert.deepEqual(reports, [{ browser: 'edge', device: 'desktop' }, { browser: 'edge', device: 'desktop' }])
  })
})

test('an interrupted export resumes without duplicates or gaps', { skip }, async () => {
  await withExport(async fixture => {
    for (let index = 0; index < 6; index++) await fixture.writer.writeEvents(attemptEvents({ steps: 2 }))
    const complete = fixture.out('complete.csv')
    await runExport(fixture.db.pools.reader, parseArguments(['--output', complete, '--users-per-page', '2']))

    const file = fixture.out('interrupted.csv')
    let queries = 0
    const failing = {
      query: (...args) => {
        if (++queries === 25) return Promise.reject(Object.assign(new Error('connection lost'), { code: '08006' }))
        return fixture.db.pools.reader.query(...args)
      },
      connect: () => fixture.db.pools.reader.connect(),
    }
    await assert.rejects(runExport(failing, parseArguments(['--output', file, '--users-per-page', '2'])), /connection lost/u)
    assert.ok(fs.existsSync(`${file}.partial`))
    assert.ok(fs.existsSync(`${file}.checkpoint.json`))
    // Bytes written after the last checkpoint are discarded on resume.
    fs.appendFileSync(`${file}.partial`, 'half a row,')
    await runExport(fixture.db.pools.reader, parseArguments(['--output', file, '--users-per-page', '2', '--resume']))
    assert.equal(fs.readFileSync(file, 'utf8'), fs.readFileSync(complete, 'utf8'))
    await assert.rejects(runExport(fixture.db.pools.reader, parseArguments(['--output', file, '--resume', '--game', 'x'])),
      /nothing to resume|same format and filters/u)
  })
})

test('filters select by trusted time, game and attempt', { skip }, async () => {
  await withExport(async fixture => {
    const { visual } = await seed(fixture)
    const file = fixture.out('one.csv')
    const manifest = await runExport(fixture.db.pools.reader, parseArguments(['--output', file, '--attempt', visual[0].attemptId]))
    assert.equal(manifest.counts.attempts, 1)
    assert.equal(manifest.counts.feedback, 0)
    const none = await runExport(fixture.db.pools.reader, parseArguments(['--output', fixture.out('none.csv'), '--since', '2100-01-01']))
    assert.equal(none.counts.attempts + none.counts.feedback, 0)
    const game = await runExport(fixture.db.pools.reader, parseArguments(['--output', fixture.out('game.csv'), '--game', 'g/other']))
    assert.equal(game.counts.attempts, 0)
  })
})

test('the spreadsheet holds the CSV rows as text cells', { skip }, async () => {
  await withExport(async fixture => {
    await seed(fixture)
    const csvFile = fixture.out('export.csv')
    await runExport(fixture.db.pools.reader, parseArguments(['--output', csvFile]))
    const xlsxFile = fixture.out('export.xlsx')
    const manifest = await runExport(fixture.db.pools.reader, parseArguments(['--format', 'xlsx', '--output', xlsxFile]))
    assert.equal(manifest.spreadsheet.rows, records(fs.readFileSync(csvFile, 'utf8')).length - 1)
    const sheet = sheetRows(readZip(xlsxFile)['xl/worksheets/sheet1.xml'])
    const formula = sheet.flat().filter(value => value && /^[=+@-]/u.test(value))
    assert.ok(formula.length >= 3, 'formula-like values are present, as text')
  })
})

test('export memory does not grow with the database', { skip }, async () => {
  await withExport(async fixture => {
    // About 40 MB of step text, exported with a 32 MB heap.
    await fixture.db.pools.admin.query(`
      INSERT INTO anonymous_users SELECT gen_random_uuid(), now(), now() FROM generate_series(1, 40)`)
    await fixture.db.pools.admin.query(`
      INSERT INTO proof_attempts (attempt_id, user_id, game_id, world_id, level_id, mode, started_at)
      SELECT gen_random_uuid(), u.user_id, 'g/local/NNG4', 'Tutorial', g, 'visual', now()
      FROM anonymous_users u, generate_series(1, 10) g`)
    await fixture.db.pools.admin.query(`
      INSERT INTO proof_steps (event_id, attempt_id, sequence, client_ts, elapsed_ms, step_type, command)
      SELECT gen_random_uuid(), a.attempt_id, g, now(), g, 'command', repeat(md5(g::text || a.attempt_id::text), 320)
      FROM proof_attempts a, generate_series(1, 10) g`)
    const file = fixture.out('big.csv')
    await promisify(execFile)(process.execPath, ['--max-old-space-size=32', 'tools/export.js', '--output', file], {
      cwd: TELEMETRY, env: { ...process.env, READER_DATABASE_URL: fixture.db.url('telemetry_reader') }, maxBuffer: 1 << 20,
    })
    assert.ok(fs.statSync(file).size > 40 * 1024 * 1024)
  })
})
