import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { connection, integer, secret } from './env.js'

/** Explicit, ledgered schema migrations.
 *
 * Migrations run only from this runner (a release step), never from ordinary
 * collector startup; the collector calls checkSchemaCompatibility() instead.
 * Each file `NNN_name.sql` runs once, in order, inside its own transaction,
 * unless its first line is `-- migrate:no-transaction` (needed for CREATE INDEX
 * CONCURRENTLY). Such a file may contain only plain statements separated by
 * semicolons at line ends, no dollar quoting; each statement runs on its own,
 * and the run fails if any index is left invalid. The ledger records a sha256
 * checksum per file; an edited, already-applied migration stops the run.
 *
 * The advisory lock id is the one earlier collectors held while re-running
 * 001-004 at startup, so an old collector restarting during a rollout cannot
 * interleave with this runner. */

export const MIGRATION_LOCK_ID = 710426314
export const DEFAULT_DIRECTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const FILE_RE = /^(\d{3})_([a-z0-9_]+)\.sql$/u

/** The runtime roles migration 009 creates, with the secret that enables each. */
export const ROLE_SECRETS = {
  telemetry_writer: 'TELEMETRY_WRITER_PASSWORD',
  telemetry_compactor: 'TELEMETRY_COMPACTOR_PASSWORD',
  telemetry_reader: 'TELEMETRY_READER_PASSWORD',
  telemetry_retention: 'TELEMETRY_RETENTION_PASSWORD',
  telemetry_backup: 'TELEMETRY_BACKUP_PASSWORD',
}

export async function loadMigrations(directory = DEFAULT_DIRECTORY) {
  const files = (await fs.readdir(directory)).filter(file => file.endsWith('.sql')).sort()
  const migrations = []
  for (const file of files) {
    const match = FILE_RE.exec(file)
    if (!match) throw new Error(`migration file name must look like 001_name.sql: ${file}`)
    const sql = await fs.readFile(path.join(directory, file), 'utf8')
    const transactional = !/^-- migrate:no-transaction\s*$/mu.test(sql.split('\n', 1)[0])
    if (!transactional && sql.includes('$')) {
      throw new Error(`${file}: no-transaction migrations may not use dollar quoting`)
    }
    if (migrations.some(migration => migration.version === match[1])) {
      throw new Error(`duplicate migration version ${match[1]}`)
    }
    migrations.push({
      version: match[1],
      name: match[2],
      file,
      sql,
      transactional,
      checksum: crypto.createHash('sha256').update(sql).digest('hex'),
    })
  }
  return migrations
}

function statements(sql) {
  return sql.split(/;[ \t]*(?:\r?\n|$)/u)
    .map(statement => statement.replace(/^\s*--.*$/gmu, '').trim())
    .filter(Boolean)
}

async function ledgerExists(queryable) {
  const result = await queryable.query(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`)
  return result.rows[0].present
}

async function appliedMigrations(queryable) {
  if (!await ledgerExists(queryable)) return new Map()
  const result = await queryable.query('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version')
  return new Map(result.rows.map(row => [row.version, row]))
}

async function acquireLock(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [MIGRATION_LOCK_ID])
    if (result.rows[0].locked) return
    if (Date.now() >= deadline) throw new Error(`migration lock not acquired within ${timeoutMs} ms`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

async function invalidIndexes(client) {
  const result = await client.query(`
    SELECT c.relname AS name FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT i.indisvalid`)
  return result.rows.map(row => row.name)
}

/** Apply pending migrations. `client` must be a dedicated connection with
 * DDL rights (the bootstrap/migration role). Returns the versions applied. */
export async function runMigrations(client, {
  directory = DEFAULT_DIRECTORY,
  lockTimeoutMs = 60000,
  ddlLockTimeoutMs = 10000,
  log = () => {},
} = {}) {
  const migrations = await loadMigrations(directory)
  await client.query(`SET lock_timeout = ${Number(ddlLockTimeoutMs)}`)
  await client.query('SET statement_timeout = 0')
  await acquireLock(client, lockTimeoutMs)
  const applied = []
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(),
        execution_ms integer NOT NULL
      )`)
    const ledger = await appliedMigrations(client)
    for (const migration of migrations) {
      const existing = ledger.get(migration.version)
      if (existing) {
        if (existing.checksum !== migration.checksum) {
          throw new Error(`migration ${migration.file} changed after it was applied (checksum mismatch)`)
        }
        continue
      }
      const started = Date.now()
      log(`applying ${migration.file}`)
      if (migration.transactional) {
        await client.query('BEGIN')
        try {
          await client.query(migration.sql)
          await client.query(
            'INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES ($1, $2, $3, $4)',
            [migration.version, migration.name, migration.checksum, Date.now() - started])
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {})
          throw new Error(`${migration.file} failed: ${error.message}`, { cause: error })
        }
      } else {
        for (const statement of statements(migration.sql)) {
          try {
            await client.query(statement)
          } catch (error) {
            throw new Error(`${migration.file} failed: ${error.message}`, { cause: error })
          }
        }
        const invalid = await invalidIndexes(client)
        if (invalid.length > 0) {
          throw new Error(`${migration.file} left invalid indexes (${invalid.join(', ')}); ` +
            'DROP INDEX CONCURRENTLY each one and run the migration again')
        }
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES ($1, $2, $3, $4)',
          [migration.version, migration.name, migration.checksum, Date.now() - started])
      }
      applied.push(migration.version)
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {})
  }
  return applied
}

/** Whether the database has every migration this build ships, unmodified.
 * Versions newer than this build are tolerated: migrations are additive.
 * `queryable` may be any role with SELECT on schema_migrations. */
export async function checkSchemaCompatibility(queryable, { directory = DEFAULT_DIRECTORY, migrations } = {}) {
  const expected = migrations ?? await loadMigrations(directory)
  const ledger = await appliedMigrations(queryable)
  const missing = []
  const mismatched = []
  for (const migration of expected) {
    const row = ledger.get(migration.version)
    if (!row) missing.push(migration.file)
    else if (row.checksum !== migration.checksum) mismatched.push(migration.file)
  }
  const known = new Set(expected.map(migration => migration.version))
  const newer = [...ledger.keys()].filter(version => !known.has(version))
  return { compatible: missing.length === 0 && mismatched.length === 0, missing, mismatched, newer }
}

/** When migration 005 was applied: the trusted upper bound on the ingestion
 * time of rows whose received_at is NULL. Null if 005 is not applied. */
export async function historicIngestionBound(queryable) {
  if (!await ledgerExists(queryable)) return null
  const result = await queryable.query(`SELECT applied_at FROM schema_migrations WHERE version = '005'`)
  return result.rows[0]?.applied_at ?? null
}

/** Enable LOGIN with a password for each runtime role whose secret is given.
 * Roles without a secret are left as they are (NOLOGIN after migration 009). */
export async function provisionRoles(client, passwords) {
  const provisioned = []
  for (const [role, password] of Object.entries(passwords)) {
    if (!(role in ROLE_SECRETS)) throw new Error(`unknown role ${role}`)
    if (password == null) continue
    if (password.length < 16) throw new Error(`${ROLE_SECRETS[role]} must be at least 16 characters`)
    await client.query(`ALTER ROLE ${client.escapeIdentifier(role)} WITH LOGIN PASSWORD ${client.escapeLiteral(password)}`)
    provisioned.push(role)
  }
  return provisioned
}

async function main(argv, env) {
  const flags = new Set(argv)
  const unknown = [...flags].filter(flag => !['--check', '--provision-roles'].includes(flag))
  if (unknown.length > 0) throw new Error(`unknown argument ${unknown[0]}; usage: migrate.js [--check] [--provision-roles]`)
  const client = new pg.Client({
    ...connection(env, 'MIGRATION_'),
    application_name: 'telemetry-migrate',
    connectionTimeoutMillis: 10000,
  })
  await client.connect()
  try {
    if (flags.has('--check')) {
      const result = await checkSchemaCompatibility(client)
      console.log(JSON.stringify(result))
      return result.compatible ? 0 : 1
    }
    const applied = await runMigrations(client, {
      lockTimeoutMs: integer(env, 'MIGRATION_LOCK_TIMEOUT_MS', 60000, { min: 1000 }),
      ddlLockTimeoutMs: integer(env, 'MIGRATION_DDL_LOCK_TIMEOUT_MS', 10000, { min: 100 }),
      log: message => console.log(message),
    })
    console.log(applied.length > 0 ? `applied ${applied.join(', ')}` : 'schema up to date')
    if (flags.has('--provision-roles')) {
      const passwords = Object.fromEntries(Object.entries(ROLE_SECRETS).map(([role, name]) => [role, secret(env, name)]))
      const provisioned = await provisionRoles(client, passwords)
      console.log(provisioned.length > 0 ? `login enabled for ${provisioned.join(', ')}` : 'no role passwords supplied')
    }
    return 0
  } finally {
    await client.end().catch(() => {})
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).then(
    code => { process.exitCode = code },
    error => {
      console.error(`migration failed: ${error.message}`)
      process.exitCode = 1
    })
}
