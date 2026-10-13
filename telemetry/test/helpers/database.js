import pg from 'pg'
import { loadMigrations, provisionRoles, runMigrations } from '../../src/migrate.js'

/** PostgreSQL integration-test support.
 *
 * Set TEST_DATABASE_URL to a superuser URL on a DISPOSABLE cluster (never a
 * production database), for example a throwaway container:
 *
 *   docker run -d --rm --name tlm-test-pg -e POSTGRES_PASSWORD=test \
 *     -p 127.0.0.1:55432:5432 postgres:17-alpine
 *   TEST_DATABASE_URL=postgresql://postgres:test@127.0.0.1:55432/postgres npm run test:integration
 *
 * Without it, integration tests are skipped. Each createTestDatabase() call
 * creates a fresh database, applies every migration, enables the runtime roles
 * with fixed test passwords and returns one pool per role. Role creation is
 * cluster-wide, so setup is serialized across test processes with an advisory
 * lock held in the maintenance database. */

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? null
export const skipWithoutDatabase = TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set'

const SETUP_LOCK_ID = 5150042
export const TEST_ROLE_PASSWORD = 'integration-test-only-password'
export const ROLES = ['telemetry_writer', 'telemetry_compactor', 'telemetry_reader', 'telemetry_retention', 'telemetry_backup']
let counter = 0

export function urlFor(databaseName, role = null) {
  const url = new URL(TEST_DATABASE_URL)
  url.pathname = `/${databaseName}`
  if (role) {
    url.username = role
    url.password = TEST_ROLE_PASSWORD
  }
  return url.toString()
}

async function migrateAndProvision(databaseName, provision) {
  const admin = new pg.Client({ connectionString: urlFor(databaseName) })
  await admin.connect()
  try {
    await runMigrations(admin)
    if (provision) await provisionRoles(admin, Object.fromEntries(ROLES.map(role => [role, TEST_ROLE_PASSWORD])))
  } finally {
    await admin.end()
  }
}

/** Options:
 *   migrate: true      apply every migration and (provision) enable the roles
 *            'legacy'  apply only 001-004, directly and without a ledger, the
 *                      way collectors before the migration runner did; seed
 *                      data through pools.admin, then call db.migrate()
 *            false     an empty database */
export async function createTestDatabase({ migrate = true, provision = true, poolOptions = {} } = {}) {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set')
  const name = `tlm_t_${process.pid}_${Date.now().toString(36)}_${counter++}`
  const maintenance = new pg.Client({ connectionString: TEST_DATABASE_URL })
  await maintenance.connect()
  const pools = {}
  try {
    await maintenance.query('SELECT pg_advisory_lock($1)', [SETUP_LOCK_ID])
    await maintenance.query(`CREATE DATABASE ${maintenance.escapeIdentifier(name)}`)
    if (migrate === 'legacy') {
      const admin = new pg.Client({ connectionString: urlFor(name) })
      await admin.connect()
      try {
        for (const migration of (await loadMigrations()).filter(item => item.version <= '004')) {
          await admin.query(migration.sql)
        }
      } finally {
        await admin.end()
      }
    } else if (migrate) {
      await migrateAndProvision(name, provision)
    }
  } finally {
    await maintenance.query('SELECT pg_advisory_unlock($1)', [SETUP_LOCK_ID]).catch(() => {})
    await maintenance.end()
  }

  function openRolePools() {
    for (const role of ROLES) {
      pools[role.replace('telemetry_', '')] ??= new pg.Pool({ connectionString: urlFor(name, role), max: 4, ...poolOptions })
      pools[role.replace('telemetry_', '')].on('error', () => {})
    }
  }
  pools.admin = new pg.Pool({ connectionString: urlFor(name), max: 4, ...poolOptions })
  pools.admin.on('error', () => {})
  if (migrate === true && provision) openRolePools()

  return {
    name,
    pools,
    url: role => urlFor(name, role),
    /** Run the migration runner (e.g. after seeding a 'legacy' database). */
    async migrate() {
      const maintenance = new pg.Client({ connectionString: TEST_DATABASE_URL })
      await maintenance.connect()
      try {
        await maintenance.query('SELECT pg_advisory_lock($1)', [SETUP_LOCK_ID])
        await migrateAndProvision(name, provision)
      } finally {
        await maintenance.query('SELECT pg_advisory_unlock($1)', [SETUP_LOCK_ID]).catch(() => {})
        await maintenance.end()
      }
      if (provision) openRolePools()
    },
    async drop() {
      await Promise.all(Object.values(pools).map(pool => pool.end().catch(() => {})))
      const client = new pg.Client({ connectionString: TEST_DATABASE_URL })
      await client.connect()
      try {
        await client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`)
      } finally {
        await client.end()
      }
    },
  }
}
