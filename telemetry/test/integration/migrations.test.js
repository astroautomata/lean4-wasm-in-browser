import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import pg from 'pg'
import {
  checkSchemaCompatibility, DEFAULT_DIRECTORY, historicIngestionBound, loadMigrations, runMigrations,
} from '../../src/migrate.js'
import { createTestDatabase, skipWithoutDatabase } from '../helpers/database.js'

const user = 'a4ac71f1-54c6-40df-89f7-b5062bf71d60'
const attempt = '505300ff-0847-48eb-994b-7e834f938c4e'

test('upgrades a legacy database without inventing ingestion times', { skip: skipWithoutDatabase }, async () => {
  const db = await createTestDatabase({ migrate: 'legacy' })
  try {
    await db.pools.admin.query(`INSERT INTO anonymous_users VALUES ($1, now(), now())`, [user])
    await db.pools.admin.query(`
      INSERT INTO proof_attempts (attempt_id, user_id, game_id, world_id, level_id, mode, started_at)
      VALUES ($1, $2, 'g/local/NNG4', 'Tutorial', 2, 'visual', now())`, [attempt, user])
    await db.pools.admin.query(`
      INSERT INTO proof_steps (event_id, attempt_id, sequence, client_ts, elapsed_ms, step_type, command)
      VALUES ('d707e185-136e-4f54-bca8-e1aaffbbe396', $1, 1, now(), 5, 'command', 'rfl')`, [attempt])
    await db.migrate()

    const steps = await db.pools.admin.query('SELECT received_at FROM proof_steps')
    assert.equal(steps.rows[0].received_at, null)
    const attempts = await db.pools.admin.query('SELECT received_at, last_received_at FROM proof_attempts')
    assert.deepEqual(attempts.rows[0], { received_at: null, last_received_at: null })
    assert.ok(await historicIngestionBound(db.pools.admin) instanceof Date)

    // New rows written after the upgrade get trusted server times.
    await db.pools.writer.query(`
      INSERT INTO proof_steps (event_id, attempt_id, sequence, client_ts, elapsed_ms, step_type, command)
      VALUES ('0b8c7b52-31a4-4c55-9d43-6b0f2b7f7c11', $1, 2, now(), 6, 'undo', 'undo')`, [attempt])
    const fresh = await db.pools.admin.query(`SELECT received_at FROM proof_steps WHERE sequence = 2`)
    assert.ok(fresh.rows[0].received_at instanceof Date)
    assert.deepEqual(await checkSchemaCompatibility(db.pools.writer), { compatible: true, missing: [], mismatched: [], newer: [] })
  } finally {
    await db.drop()
  }
})

test('is idempotent and refuses edited applied migrations', { skip: skipWithoutDatabase }, async () => {
  const db = await createTestDatabase()
  const client = await db.pools.admin.connect()
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tlm-migrations-'))
  try {
    assert.deepEqual(await runMigrations(client), [])
    for (const migration of await loadMigrations()) {
      await fs.writeFile(path.join(directory, migration.file), migration.sql)
    }
    await fs.appendFile(path.join(directory, '001_initial.sql'), '\n-- edited\n')
    await assert.rejects(runMigrations(client, { directory }), /checksum mismatch/u)
    const compatibility = await checkSchemaCompatibility(client, { directory })
    assert.equal(compatibility.compatible, false)
    assert.deepEqual(compatibility.mismatched, ['001_initial.sql'])
  } finally {
    client.release()
    await fs.rm(directory, { recursive: true, force: true })
    await db.drop()
  }
})

test('reports an incompatible schema when migrations are missing', { skip: skipWithoutDatabase }, async () => {
  const db = await createTestDatabase({ migrate: false })
  try {
    const result = await checkSchemaCompatibility(db.pools.admin)
    assert.equal(result.compatible, false)
    assert.equal(result.missing.length, (await loadMigrations(DEFAULT_DIRECTORY)).length)
  } finally {
    await db.drop()
  }
})

test('runtime roles hold only their intended privileges', { skip: skipWithoutDatabase }, async () => {
  const db = await createTestDatabase()
  try {
    const denied = async (pool, sql, params = []) => {
      await assert.rejects(pool.query(sql, params), error => ['42501', '25006'].includes(error.code) || /must be owner/u.test(error.message), sql)
    }
    await db.pools.admin.query(`INSERT INTO anonymous_users VALUES ($1, now(), now())`, [user])
    await db.pools.admin.query(`
      INSERT INTO proof_attempts (attempt_id, user_id, game_id, world_id, level_id, mode, started_at)
      VALUES ($1, $2, 'g/local/NNG4', 'Tutorial', 2, 'visual', now())`, [attempt, user])

    const writer = db.pools.writer
    await writer.query('SELECT 1 FROM proof_attempts WHERE attempt_id = $1 FOR UPDATE', [attempt])
    await denied(writer, 'DELETE FROM proof_steps')
    await denied(writer, 'UPDATE proof_attempts SET user_id = user_id')
    await denied(writer, 'CREATE TABLE intruder (id int)')
    await denied(writer, 'DROP TABLE proof_steps')
    await denied(writer, 'ALTER TABLE proof_steps ADD COLUMN intruder int')
    await denied(writer, 'CREATE ROLE intruder')
    await denied(writer, 'DELETE FROM trajectory_chunks')
    const settings = await writer.query(`SELECT current_setting('statement_timeout') AS statement,
      current_setting('lock_timeout') AS lock, current_setting('idle_in_transaction_session_timeout') AS idle`)
    assert.deepEqual(settings.rows[0], { statement: '3s', lock: '500ms', idle: '5s' })

    await denied(db.pools.reader, 'DELETE FROM proof_steps')
    await assert.rejects(db.pools.reader.query(`INSERT INTO anonymous_users VALUES ($1, now(), now())`,
      ['0b8c7b52-31a4-4c55-9d43-6b0f2b7f7c11']), /read-only|permission denied/u)
    await denied(db.pools.compactor, 'DELETE FROM proof_attempts')
    await denied(db.pools.compactor, 'UPDATE proof_attempts SET completed = true')
    await denied(db.pools.retention, 'CREATE TABLE intruder (id int)')
    const roles = await db.pools.admin.query(`
      SELECT rolname FROM pg_roles WHERE rolname LIKE 'telemetry\\_%' AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls)`)
    assert.deepEqual(roles.rows, [])
  } finally {
    await db.drop()
  }
})

test('a concurrent migration run waits for the lock instead of interleaving', { skip: skipWithoutDatabase }, async () => {
  const db = await createTestDatabase()
  const holder = new pg.Client({ connectionString: db.url() })
  await holder.connect()
  const client = await db.pools.admin.connect()
  try {
    await holder.query('SELECT pg_advisory_lock(710426314)')
    await assert.rejects(runMigrations(client, { lockTimeoutMs: 600 }), /lock not acquired/u)
  } finally {
    client.release()
    await holder.end()
    await db.drop()
  }
})
