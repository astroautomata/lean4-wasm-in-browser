import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import pg from 'pg'
import { provisionRoles, ROLE_SECRETS, runMigrations } from '../../src/migrate.js'
import { encodeChunk, sqlFromMicros } from '../../src/trajectory/codec.js'
import { createTestDatabase, skipWithoutDatabase, TEST_DATABASE_URL, TEST_ROLE_PASSWORD } from '../helpers/database.js'

/** End-to-end tests of ops/backup.sh and ops/restore-test.sh against the
 * disposable TEST_DATABASE_URL cluster. pg_dump runs in a throwaway client
 * container on the host network (the test cluster listens on 127.0.0.1); the
 * restore drill starts and removes its own throwaway server. */

const run = promisify(execFile)
const OPS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ops')
const PG_IMAGE = 'postgres:17.10-alpine3.24'

function dockerAvailable() {
  try {
    execFileSync('docker', ['image', 'inspect', PG_IMAGE], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const skip = skipWithoutDatabase || (dockerAvailable() ? false : `docker with ${PG_IMAGE} is required`)

const user = '6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d'
const compacted = '0d4e5f60-7182-4394-a5b6-c7d8e9f0a1b2'
const live = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const baseUs = 1_791_000_000_000_000

function eventId(attempt, sequence) {
  return `${attempt.slice(0, 24)}${String(sequence).padStart(12, '0')}`
}

/** Users, two attempts, live steps, a published chunk whose source rows were
 * replaced (steps 1-3 of `compacted` exist only in the chunk), a late live step
 * after it, and feedback: the mixed live/compacted state a restore must keep. */
async function seed(db) {
  const admin = db.pools.admin
  await admin.query(`INSERT INTO anonymous_users VALUES ($1, now(), now())`, [user])
  for (const attempt of [compacted, live]) {
    await admin.query(`
      INSERT INTO proof_attempts (attempt_id, user_id, game_id, world_id, level_id, mode, started_at, initial_script)
      VALUES ($1, $2, 'g/local/NNG4', 'Tutorial', 3, 'visual', now(), 'intro x')`, [attempt, user])
  }
  const actions = [1, 2, 3].map(sequence => ({
    eventId: eventId(compacted, sequence),
    sequence,
    clientTsUs: baseUs + sequence * 1000,
    elapsedMs: sequence * 100,
    stepType: 'command',
    command: sequence === 2 ? '=SUM(A1:A2) ünïcødé' : `rw [add_zero] -- ${sequence}`,
    fromLine: null,
    removedLines: null,
    attributes: {},
    receivedAtUs: baseUs + sequence * 2000,
  }))
  const chunk = encodeChunk({ attemptId: compacted, actions })
  await admin.query(`
    INSERT INTO trajectory_chunks (attempt_id, format, codec, kind, state, seq_first, seq_last, event_count,
      uncompressed_bytes, compressed_bytes, checksum, payload, receipt_event_ids, min_source_received_at,
      max_source_received_at, historic_sources, published_at, sources_removed_at)
    VALUES ($1, $2, $3, 'base', 'published', $4, $5, $6, $7, $8, $9, $10, $11::uuid[],
      ${sqlFromMicros('$12')}, ${sqlFromMicros('$13')}, $14, now(), now())`,
  [compacted, chunk.format, chunk.codec, chunk.seqFirst, chunk.seqLast, chunk.eventCount, chunk.uncompressedBytes,
    chunk.compressedBytes, chunk.checksum, chunk.payload, chunk.eventIds, chunk.minSourceReceivedAtUs,
    chunk.maxSourceReceivedAtUs, chunk.historicSources])
  await admin.query('UPDATE proof_attempts SET compacted_through = 3 WHERE attempt_id = $1', [compacted])
  const steps = [[compacted, 4], [live, 1], [live, 2]]
  for (const [attempt, sequence] of steps) {
    await admin.query(`
      INSERT INTO proof_steps (event_id, attempt_id, sequence, client_ts, elapsed_ms, step_type, command)
      VALUES ($1, $2, $3, now(), $4, 'command', 'simp')`, [eventId(attempt, sequence), attempt, sequence, sequence * 10])
  }
  await admin.query(`
    INSERT INTO feedback_reports (report_id, user_id, game_id, world_id, level_id, mode, message, proof_state, client_ts)
    VALUES ('1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9', $1, 'g/local/NNG4', 'Tutorial', 3, 'visual', 'stuck', '{}', now())`, [user])
}

async function workspace() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tlm-backup-test-'))
  const passwordFile = path.join(directory, 'backup_password')
  await fs.writeFile(passwordFile, `${TEST_ROLE_PASSWORD}\n`, { mode: 0o600 })
  const keyFile = path.join(directory, 'backup.key')
  await fs.writeFile(keyFile, 'test-only-symmetric-key-for-the-backup-hooks\n', { mode: 0o600 })
  return { directory, passwordFile, keyFile, backupDir: path.join(directory, 'backups'), remote: path.join(directory, 'remote') }
}

function backupEnv(db, space, extra = {}) {
  const url = new URL(TEST_DATABASE_URL)
  return {
    PATH: process.env.PATH,
    BACKUP_DIR: space.backupDir,
    BACKUP_PGHOST: url.hostname,
    BACKUP_PGPORT: url.port || '5432',
    BACKUP_PGDATABASE: db.name,
    BACKUP_PGPASSWORD_FILE: space.passwordFile,
    BACKUP_PG_CLIENT: 'docker',
    BACKUP_DOCKER_NETWORK: 'host',
    BACKUP_DOCKER_MEMORY: '256m',
    BACKUP_PG_IMAGE: PG_IMAGE,
    ...extra,
  }
}

function encryptEnv(space) {
  return {
    BACKUP_ENCRYPT_CMD: `openssl enc -aes-256-cbc -pbkdf2 -salt -pass file:${space.keyFile}`,
    BACKUP_ENCRYPTED_SUFFIX: '.aes',
  }
}

async function script(name, env, args = []) {
  try {
    const { stdout, stderr } = await run('nice', ['-n', '10', path.join(OPS, name), ...args], { env, timeout: 180000 })
    return { code: 0, stdout, stderr }
  } catch (error) {
    if (typeof error.code !== 'number') throw error
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

async function sets(backupDir) {
  return (await fs.readdir(backupDir)).filter(name => name.startsWith('telemetry-')).sort()
}

function restoreContainers(output) {
  const name = /starting disposable server (\S+)/u.exec(output)?.[1]
  assert.ok(name, 'the restore drill names its container')
  return execFileSync('docker', ['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}']).toString().trim()
}

function assertNoSecrets(output) {
  assert.ok(!output.includes(TEST_ROLE_PASSWORD), 'output must not contain a password')
  assert.ok(!/postgres(ql)?:\/\/[^\s]*:[^\s]*@/u.test(output), 'output must not contain a connection string')
}

test('refuses to write an unencrypted backup unless explicitly allowed', { skip }, async () => {
  const db = await createTestDatabase()
  const space = await workspace()
  try {
    const result = await script('backup.sh', backupEnv(db, space))
    assert.equal(result.code, 2)
    assert.match(result.stderr, /refusing to write an unencrypted backup/u)
    await assert.rejects(fs.readdir(space.backupDir), { code: 'ENOENT' })
  } finally {
    await fs.rm(space.directory, { recursive: true, force: true })
    await db.drop()
  }
})

test('refuses to start when the backup would push the disk past its budget', { skip }, async () => {
  const db = await createTestDatabase()
  const space = await workspace()
  try {
    const result = await script('backup.sh', backupEnv(db, space, { ...encryptEnv(space), BACKUP_MAX_DISK_RATIO: '0.001' }))
    assert.equal(result.code, 3)
    assert.match(result.stderr, /refusing to start: an estimated \d+-byte backup would raise disk usage/u)
    assert.deepEqual(await sets(space.backupDir), [])
  } finally {
    await fs.rm(space.directory, { recursive: true, force: true })
    await db.drop()
  }
})

test('aborts and removes the partial set when the stored bytes reach the cap', { skip }, async () => {
  const db = await createTestDatabase()
  const space = await workspace()
  try {
    await seed(db)
    const result = await script('backup.sh', backupEnv(db, space, { ...encryptEnv(space), BACKUP_MAX_BYTES: '4096' }))
    assert.equal(result.code, 1)
    assert.match(result.stderr, /aborted: database\.dump\.aes reached the byte budget of this run/u)
    assert.match(result.stderr, /partial set removed/u)
    assert.deepEqual(await sets(space.backupDir), [])
  } finally {
    await fs.rm(space.directory, { recursive: true, force: true })
    await db.drop()
  }
})

test('encrypted backup with upload hook restores mixed live and compacted data', { skip }, async () => {
  const db = await createTestDatabase()
  const space = await workspace()
  try {
    await seed(db)
    await fs.mkdir(space.remote)
    const env = backupEnv(db, space, {
      ...encryptEnv(space),
      BACKUP_UPLOAD_CMD: `cp -R "$1" ${space.remote}/`,
      BACKUP_METRICS_FILE: path.join(space.directory, 'telemetry_backup.prom'),
    })
    const backup = await script('backup.sh', env)
    assert.equal(backup.code, 0, backup.stderr)
    assertNoSecrets(backup.stdout + backup.stderr)
    const [setName] = await sets(space.backupDir)
    const setDir = path.join(space.backupDir, setName)
    const files = (await fs.readdir(setDir)).sort()
    assert.deepEqual(files, ['SHA256SUMS', 'UPLOADED', 'database.dump.aes', 'globals.sql.aes', 'manifest'])
    assert.deepEqual((await fs.readdir(path.join(space.remote, setName))).sort(),
      ['SHA256SUMS', 'database.dump.aes', 'globals.sql.aes', 'manifest'])
    // Stored data is ciphertext: neither the dump magic nor any proof text.
    const stored = await fs.readFile(path.join(setDir, 'database.dump.aes'))
    assert.notEqual(stored.subarray(0, 5).toString(), 'PGDMP')
    assert.ok(!stored.includes(Buffer.from('rw [add_zero]')))
    assert.equal(((await fs.stat(setDir)).mode & 0o077), 0, 'set directory is private')
    const manifest = await fs.readFile(path.join(setDir, 'manifest'), 'utf8')
    assert.match(manifest, /^encrypted=yes$/mu)
    assert.match(manifest, /^role=telemetry_backup$/mu)
    assert.match(manifest, /^before\.logical_steps=6$/mu)
    assert.match(manifest, /^after\.count\.proof_steps=3$/mu)
    assert.match(manifest, /^dump_plain_sha256=[0-9a-f]{64}$/mu)
    const prom = await fs.readFile(path.join(space.directory, 'telemetry_backup.prom'), 'utf8')
    assert.match(prom, /^telemetry_backup_last_stored_timestamp_seconds \d{10}$/mu)
    assert.match(prom, /^telemetry_backup_last_uploaded 1$/mu)

    const restore = await script('restore-test.sh', {
      PATH: process.env.PATH,
      RESTORE_DECRYPT_CMD: `openssl enc -d -aes-256-cbc -pbkdf2 -pass file:${space.keyFile}`,
      RESTORE_MEMORY: '384m',
    }, [setDir])
    assert.equal(restore.code, 0, restore.stderr)
    assert.match(restore.stderr, /logical_steps\s+6\s+6\s+6/u)
    assert.match(restore.stderr, /count\.proof_steps\s+3\s+3\s+3/u)
    assert.match(restore.stderr, /chunks: published=1 shadow=0 sources_removed=1/u)
    assert.match(restore.stderr, /result: PASS \(5 roles\)/u)
    assert.match(restore.stderr, /PASS: telemetry-\S+ restored and verified/u)
    assertNoSecrets(restore.stdout + restore.stderr)
    assert.equal(restoreContainers(restore.stderr), '', 'the disposable server is removed')
  } finally {
    await fs.rm(space.directory, { recursive: true, force: true })
    await db.drop()
  }
})

test('plaintext test backups prune old local sets and a corrupted set fails the drill', { skip }, async () => {
  const db = await createTestDatabase()
  const space = await workspace()
  try {
    await seed(db)
    const env = backupEnv(db, space, { BACKUP_ALLOW_PLAINTEXT: '1', BACKUP_KEEP_LOCAL: '1' })
    const first = await script('backup.sh', env)
    assert.equal(first.code, 0, first.stderr)
    assert.match(first.stderr, /WARNING: writing an UNENCRYPTED backup/u)
    assert.match(first.stderr, /WARNING: BACKUP_UPLOAD_CMD is not set/u)
    const [firstSet] = await sets(space.backupDir)
    const second = await script('backup.sh', env)
    assert.equal(second.code, 0, second.stderr)
    const remaining = await sets(space.backupDir)
    assert.equal(remaining.length, 1)
    assert.notEqual(remaining[0], firstSet)
    const setDir = path.join(space.backupDir, remaining[0])
    const dump = await fs.readFile(path.join(setDir, 'database.dump'))
    assert.equal(dump.subarray(0, 5).toString(), 'PGDMP')

    const clean = await script('restore-test.sh', { PATH: process.env.PATH, BACKUP_DIR: space.backupDir, RESTORE_MEMORY: '384m' })
    assert.equal(clean.code, 0, clean.stderr)

    dump[dump.length - 10] ^= 0xff
    await fs.writeFile(path.join(setDir, 'database.dump'), dump)
    const corrupt = await script('restore-test.sh', { PATH: process.env.PATH, RESTORE_MEMORY: '384m' }, [setDir])
    assert.equal(corrupt.code, 1)
    assert.match(corrupt.stderr, /checksum verification failed/u)
  } finally {
    await fs.rm(space.directory, { recursive: true, force: true })
    await db.drop()
  }
})

test('a failing upload keeps the set and reports it', { skip }, async () => {
  const db = await createTestDatabase()
  const space = await workspace()
  try {
    const env = backupEnv(db, space, { ...encryptEnv(space), BACKUP_UPLOAD_CMD: 'exit 7', BACKUP_KEEP_LOCAL: '1' })
    const first = await script('backup.sh', env)
    assert.equal(first.code, 4)
    assert.match(first.stderr, /UPLOAD FAILED/u)
    const second = await script('backup.sh', env)
    assert.equal(second.code, 4)
    assert.match(second.stderr, /keeping telemetry-\S+: it was never uploaded/u)
    assert.equal((await sets(space.backupDir)).length, 2)
  } finally {
    await fs.rm(space.directory, { recursive: true, force: true })
    await db.drop()
  }
})

/** Regression: production's cluster was initialised with POSTGRES_USER
 * lean_telemetry, so migration 009's role grant is recorded "GRANTED BY
 * lean_telemetry". PostgreSQL 16+ only lets the bootstrap superuser replay
 * that, so a drill (or a recovery) into a cluster bootstrapped as `postgres`
 * failed while applying the globals. */
test('restores a cluster whose bootstrap superuser is not postgres (production layout)', { skip }, async () => {
  const source = `tlm-backup-test-src-${process.pid}-${Date.now().toString(36)}`
  const space = await workspace()
  execFileSync('docker', ['run', '-d', '--rm', '--name', source, '--memory', '256m', '-p', '127.0.0.1::5432',
    '-e', 'POSTGRES_USER=lean_telemetry', '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=lean_telemetry', PG_IMAGE],
  { stdio: 'ignore' })
  try {
    const port = execFileSync('docker', ['port', source, '5432/tcp']).toString().trim().split('\n')[0].split(':').at(-1)
    const connectionString = `postgresql://lean_telemetry:test@127.0.0.1:${port}/lean_telemetry`
    let admin
    for (let attempt = 0; ; attempt++) {
      admin = new pg.Client({ connectionString })
      try {
        await admin.connect()
        await admin.query('SELECT 1')
        break
      } catch (error) {
        await admin.end().catch(() => {})
        if (attempt > 60) throw error
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }
    try {
      await runMigrations(admin)
      await provisionRoles(admin, Object.fromEntries(Object.keys(ROLE_SECRETS).map(role => [role, TEST_ROLE_PASSWORD])))
      await admin.query(`INSERT INTO anonymous_users VALUES ($1, now(), now())`, [user])
    } finally {
      await admin.end()
    }
    const backup = await script('backup.sh', {
      ...backupEnv({ name: 'lean_telemetry' }, space, encryptEnv(space)),
      BACKUP_PGPORT: port,
    })
    assert.equal(backup.code, 0, backup.stderr)
    const [setName] = await sets(space.backupDir)
    const manifest = await fs.readFile(path.join(space.backupDir, setName, 'manifest'), 'utf8')
    assert.match(manifest, /^bootstrap_superuser=lean_telemetry$/mu)
    const restore = await script('restore-test.sh', {
      PATH: process.env.PATH,
      RESTORE_DECRYPT_CMD: `openssl enc -d -aes-256-cbc -pbkdf2 -pass file:${space.keyFile}`,
      RESTORE_MEMORY: '384m',
    }, [path.join(space.backupDir, setName)])
    assert.equal(restore.code, 0, restore.stderr)
    assert.match(restore.stderr, /result: PASS \(5 roles\)/u)
    assert.equal(restoreContainers(restore.stderr), '')
  } finally {
    execFileSync('docker', ['rm', '-f', '-v', source], { stdio: 'ignore' })
    await fs.rm(space.directory, { recursive: true, force: true })
  }
})
