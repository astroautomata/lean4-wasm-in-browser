import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import pg from 'pg'
import { ROLE_SPECS } from '../../tools/verify-permissions.js'
import { createTestDatabase, skipWithoutDatabase, TEST_DATABASE_URL, TEST_ROLE_PASSWORD } from '../helpers/database.js'

const run = promisify(execFile)
const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'verify-permissions.js')
const user = 'a4ac71f1-54c6-40df-89f7-b5062bf71d60'
const attempt = '505300ff-0847-48eb-994b-7e834f938c4e'

/** Credentials for every role, the way an operator supplies them. */
function roleEnv(db) {
  const env = { PATH: process.env.PATH }
  for (const spec of Object.values(ROLE_SPECS)) env[`${spec.prefix}DATABASE_URL`] = db.url(spec.role)
  return env
}

async function verify(env, args = []) {
  try {
    const { stdout, stderr } = await run(process.execPath, [TOOL, ...args], { env, timeout: 60000 })
    return { code: 0, stdout, stderr }
  } catch (error) {
    if (typeof error.code !== 'number') throw error
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

function assertNoSecrets(output) {
  assert.ok(!output.includes(TEST_ROLE_PASSWORD), 'output must not contain a password')
  assert.ok(!/postgres(ql)?:\/\//u.test(output), 'output must not contain a connection string')
}

/** Cluster-wide role changes must be undone even when an assertion fails. */
async function withClusterChange(change, undo, body) {
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL })
  await admin.connect()
  try {
    await admin.query(change)
    await body()
  } finally {
    await admin.query(undo).catch(() => {})
    await admin.end()
  }
}

test('every runtime role passes on a freshly migrated database', { skip: skipWithoutDatabase }, async () => {
  const db = await createTestDatabase()
  try {
    const result = await verify(roleEnv(db), ['--verbose'])
    assert.equal(result.code, 0, result.stdout)
    for (const spec of Object.values(ROLE_SPECS)) assert.match(result.stdout, new RegExp(`^PASS  ${spec.role} `, 'mu'))
    assert.match(result.stdout, /refused: DELETE FROM public\.proof_steps WHERE false/u)
    assert.match(result.stdout, /result: PASS \(5 roles\)/u)
    assertNoSecrets(result.stdout + result.stderr)
  } finally {
    await db.drop()
  }
})

test('verifies an upgraded legacy volume, not just a fresh install', { skip: skipWithoutDatabase }, async () => {
  const db = await createTestDatabase({ migrate: 'legacy' })
  try {
    // Tables created by the old collector's superuser, with data, before roles existed.
    await db.pools.admin.query(`INSERT INTO anonymous_users VALUES ($1, now(), now())`, [user])
    await db.pools.admin.query(`
      INSERT INTO proof_attempts (attempt_id, user_id, game_id, world_id, level_id, mode, started_at)
      VALUES ($1, $2, 'g/local/NNG4', 'Tutorial', 2, 'visual', now())`, [attempt, user])
    await db.migrate()
    const result = await verify(roleEnv(db), ['--json'])
    assert.equal(result.code, 0, result.stdout)
    const report = JSON.parse(result.stdout)
    assert.equal(report.ok, true)
    assert.deepEqual(report.reports.map(item => item.status), ['pass', 'pass', 'pass', 'pass', 'pass'])
    assertNoSecrets(result.stdout)
  } finally {
    await db.drop()
  }
})

test('reads credentials from PG* variables and *_FILE secrets, defaulting the user to the role', { skip: skipWithoutDatabase }, async () => {
  const db = await createTestDatabase()
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tlm-verify-'))
  try {
    const secretFile = path.join(directory, 'writer_password')
    await fs.writeFile(secretFile, `${TEST_ROLE_PASSWORD}\n`, { mode: 0o600 })
    const url = new URL(TEST_DATABASE_URL)
    const result = await verify({
      PATH: process.env.PATH,
      PGHOST: url.hostname,
      PGPORT: url.port || '5432',
      PGDATABASE: db.name,
      WRITER_PGPASSWORD_FILE: secretFile,
    }, ['--roles', 'writer'])
    assert.equal(result.code, 0, result.stdout)
    assert.match(result.stdout, /result: PASS \(1 roles\)/u)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
    await db.drop()
  }
})

test('fails when the writer can delete, own or alter schema objects', { skip: skipWithoutDatabase }, async () => {
  const db = await createTestDatabase()
  try {
    await db.pools.admin.query('GRANT DELETE ON proof_steps TO telemetry_writer')
    await db.pools.admin.query('GRANT UPDATE (user_id) ON proof_attempts TO telemetry_writer')
    await db.pools.admin.query('ALTER TABLE feedback_reports OWNER TO telemetry_writer')
    await db.pools.admin.query('GRANT CREATE ON SCHEMA public TO telemetry_writer')
    const result = await verify(roleEnv(db), ['--roles', 'writer'])
    assert.equal(result.code, 1)
    assert.match(result.stdout, /^FAIL  telemetry_writer/mu)
    assert.match(result.stdout, /FAIL {2}proof_steps: DELETE not held \[granted on the whole table\]/u)
    assert.match(result.stdout, /FAIL {2}proof_attempts: UPDATE only on columns .*user_id/u)
    assert.match(result.stdout, /FAIL {2}owns nothing .*\[\d+ relation\(s\)/u)
    assert.match(result.stdout, /FAIL {2}no CREATE on schema public/u)
    assert.match(result.stdout, /FAIL {2}refused: CREATE TABLE public\.verify_permissions_probe .*statement succeeded \(rolled back\)/u)
    // The probe was rolled back.
    const leftover = await db.pools.admin.query(`SELECT to_regclass('public.verify_permissions_probe') AS name`)
    assert.equal(leftover.rows[0].name, null)
    assert.match(result.stdout, /result: FAIL \(1 of 1 roles\)/u)
  } finally {
    await db.drop()
  }
})

test('fails on elevated role attributes, memberships and missing role settings', { skip: skipWithoutDatabase }, async () => {
  const db = await createTestDatabase()
  try {
    await withClusterChange('ALTER ROLE telemetry_reader CREATEDB', 'ALTER ROLE telemetry_reader NOCREATEDB', async () => {
      await withClusterChange('ALTER ROLE telemetry_writer RESET statement_timeout',
        `ALTER ROLE telemetry_writer SET statement_timeout = '3s'`, async () => {
          await withClusterChange('GRANT pg_write_all_data TO telemetry_compactor',
            'REVOKE pg_write_all_data FROM telemetry_compactor', async () => {
              const result = await verify(roleEnv(db), ['--roles', 'writer,compactor,reader'])
              assert.equal(result.code, 1)
              assert.match(result.stdout, /FAIL {2}no superuser, createrole, createdb.*\[rolcreatedb\]/u)
              assert.match(result.stdout, /FAIL {2}role setting statement_timeout .*role: unset/u)
              assert.match(result.stdout, /FAIL {2}role memberships are exactly: none \[pg_write_all_data\]/u)
              // pg_write_all_data also shows up as effective table privileges.
              assert.match(result.stdout, /FAIL {2}anonymous_users: INSERT not held/u)
              assert.match(result.stdout, /result: FAIL \(3 of 3 roles\)/u)
            })
        })
    })
  } finally {
    await db.drop()
  }
})

test('fails when a role is configured with the bootstrap superuser credential', { skip: skipWithoutDatabase }, async () => {
  const db = await createTestDatabase()
  try {
    const env = roleEnv(db)
    env.WRITER_DATABASE_URL = db.url()
    const result = await verify(env, ['--roles', 'writer'])
    assert.equal(result.code, 1)
    assert.match(result.stdout, /FAIL {2}connected as the expected role/u)
    assert.match(result.stdout, /FAIL {2}no superuser.*rolsuper/u)
    assertNoSecrets(result.stdout)
  } finally {
    await db.drop()
  }
})

test('reports missing credentials and unusable logins as failures without leaking secrets', { skip: skipWithoutDatabase }, async () => {
  const db = await createTestDatabase()
  try {
    const env = roleEnv(db)
    delete env.BACKUP_DATABASE_URL
    const url = new URL(env.READER_DATABASE_URL)
    url.password = 'wrong-password-for-the-test'
    env.READER_DATABASE_URL = url.toString()
    const result = await verify(env)
    assert.equal(result.code, 1)
    assert.match(result.stdout, /^ERROR telemetry_backup \(BACKUP_\*\): BACKUP_DATABASE_URL or PGHOST is required/mu)
    assert.match(result.stdout, /^ERROR telemetry_reader \(READER_\*\): cannot connect as telemetry_reader: 28P01/mu)
    assert.match(result.stdout, /^PASS  telemetry_writer/mu)
    assert.ok(!result.stdout.includes('wrong-password-for-the-test'))
    assertNoSecrets(result.stdout)

    const usage = await verify(env, ['--roles', 'superuser'])
    assert.equal(usage.code, 2)
    assert.match(usage.stderr, /--roles accepts writer, compactor, reader, retention, backup/u)
  } finally {
    await db.drop()
  }
})
