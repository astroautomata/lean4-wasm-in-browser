import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { ConfigError, connection } from '../src/env.js'

/** Verifies the effective privileges of the runtime roles on an EXISTING
 * database, connecting as each role with its own credentials.
 *
 * Grants are what a role can actually do, which on an upgraded volume can
 * differ from what a fresh install would give it (tables created by the old
 * superuser, leftover grants, role memberships, ownership). So every check
 * asks PostgreSQL about the connected role itself (has_*_privilege,
 * pg_has_role, ownership) and then probes the important denials with real
 * statements inside a transaction that is always rolled back. Nothing is
 * written; a probe that unexpectedly succeeds is undone by the rollback.
 *
 * The expected matrix mirrors migration 009 exactly: any write privilege not
 * listed here is a failure, so a migration that changes grants must update
 * ROLE_SPECS in the same change (the release workflow runs this tool).
 *
 * Credentials per role: `<PREFIX>DATABASE_URL(_FILE)`, or PGHOST/PGPORT/
 * PGDATABASE with `<PREFIX>PGPASSWORD(_FILE)` (`<PREFIX>PGUSER` defaults to the
 * role name). Output never contains passwords or connection strings. */

const ATTEMPT_WRITER_COLUMNS = Object.freeze([
  'started_at', 'initial_script', 'source_attempt_id', 'last_received_at',
  'start_event_id', 'start_sequence', 'start_client_ts', 'start_elapsed_ms',
  'completed', 'completed_at', 'duration_ms', 'play_script', 'lean_script',
  'completion_event_id', 'completion_sequence', 'completion_received_at',
  'later_completion_sequences',
])

/** Per table: privilege → true (whole table) or a list of columns. Anything
 * absent must not be held. `selectAll` roles may read every relation. */
export const ROLE_SPECS = Object.freeze({
  writer: {
    role: 'telemetry_writer',
    prefix: 'WRITER_',
    tables: {
      anonymous_users: { SELECT: true, INSERT: true, UPDATE: ['last_seen'] },
      proof_attempts: { SELECT: true, INSERT: true, UPDATE: ATTEMPT_WRITER_COLUMNS },
      proof_steps: { SELECT: true, INSERT: true },
      feedback_reports: { SELECT: true, INSERT: true },
      trajectory_chunks: { SELECT: true },
      schema_migrations: { SELECT: true },
    },
    settings: { statement_timeout: 'timeout', lock_timeout: 'timeout', idle_in_transaction_session_timeout: 'timeout' },
    probes: {
      allowed: ['SELECT 1 FROM public.proof_attempts WHERE false FOR UPDATE'],
      denied: [
        'DELETE FROM public.proof_steps WHERE false',
        'DELETE FROM public.proof_attempts WHERE false',
        'UPDATE public.proof_attempts SET user_id = user_id WHERE false',
        'UPDATE public.proof_steps SET command = command WHERE false',
        'INSERT INTO public.trajectory_chunks OVERRIDING SYSTEM VALUE SELECT * FROM public.trajectory_chunks WHERE false',
      ],
    },
  },
  compactor: {
    role: 'telemetry_compactor',
    prefix: 'COMPACTOR_',
    tables: {
      proof_attempts: { SELECT: true, UPDATE: ['compacted_through'] },
      proof_steps: { SELECT: true, DELETE: true },
      trajectory_chunks: { SELECT: true, INSERT: true, DELETE: true, UPDATE: ['state', 'published_at', 'sources_removed_at'] },
      schema_migrations: { SELECT: true },
    },
    settings: { lock_timeout: 'timeout', idle_in_transaction_session_timeout: 'timeout' },
    probes: {
      allowed: ['SELECT 1 FROM public.proof_attempts WHERE false FOR NO KEY UPDATE'],
      denied: [
        'DELETE FROM public.proof_attempts WHERE false',
        'UPDATE public.proof_attempts SET completed = completed WHERE false',
        'INSERT INTO public.proof_steps SELECT * FROM public.proof_steps WHERE false',
      ],
    },
  },
  reader: {
    role: 'telemetry_reader',
    prefix: 'READER_',
    tables: Object.fromEntries(['anonymous_users', 'proof_attempts', 'proof_steps', 'trajectory_chunks',
      'feedback_reports', 'schema_migrations'].map(table => [table, { SELECT: true }])),
    settings: {
      default_transaction_read_only: 'on',
      statement_timeout: 'timeout',
      idle_in_transaction_session_timeout: 'timeout',
      temp_file_limit: 'limit',
      work_mem: 'present',
    },
    probes: {
      allowed: ['SELECT 1 FROM public.proof_steps LIMIT 0'],
      denied: [
        'INSERT INTO public.anonymous_users SELECT * FROM public.anonymous_users WHERE false',
        'DELETE FROM public.proof_steps WHERE false',
      ],
    },
  },
  retention: {
    role: 'telemetry_retention',
    prefix: 'RETENTION_',
    tables: {
      anonymous_users: { SELECT: true, DELETE: true },
      // detail_expired_at (migration 010): marks attempts whose step detail a
      // policy removed, so the writer refuses late retries of it.
      proof_attempts: { SELECT: true, DELETE: true, UPDATE: ['detail_expired_at'] },
      proof_steps: { SELECT: true, DELETE: true },
      feedback_reports: { SELECT: true, DELETE: true },
      trajectory_chunks: { SELECT: true, DELETE: true, UPDATE: ['receipt_event_ids'] },
      schema_migrations: { SELECT: true },
    },
    settings: { statement_timeout: 'timeout', lock_timeout: 'timeout' },
    probes: {
      allowed: [],
      denied: [
        'INSERT INTO public.anonymous_users SELECT * FROM public.anonymous_users WHERE false',
        'UPDATE public.proof_attempts SET completed = completed WHERE false',
      ],
    },
  },
  backup: {
    role: 'telemetry_backup',
    prefix: 'BACKUP_',
    selectAll: true,
    memberOf: ['pg_read_all_data'],
    tables: {},
    settings: { default_transaction_read_only: 'on' },
    probes: {
      allowed: ['SELECT 1 FROM public.proof_steps LIMIT 0', 'SELECT 1 FROM public.trajectory_chunks LIMIT 0'],
      denied: [
        'INSERT INTO public.anonymous_users SELECT * FROM public.anonymous_users WHERE false',
        'DELETE FROM public.proof_steps WHERE false',
      ],
    },
  },
})

export const ROLE_NAMES = Object.freeze(Object.keys(ROLE_SPECS))

/** Statements every runtime role must be refused (DDL and role creation). */
const COMMON_DENIED = Object.freeze([
  'CREATE TABLE public.verify_permissions_probe (id integer)',
  'ALTER TABLE public.proof_steps ADD COLUMN verify_permissions_probe integer',
  'CREATE INDEX verify_permissions_probe ON public.proof_steps (sequence)',
  'CREATE SCHEMA verify_permissions_probe',
  'CREATE ROLE verify_permissions_probe NOLOGIN',
])

const TABLE_PRIVILEGES = Object.freeze(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
const COLUMN_PRIVILEGES = Object.freeze(new Set(['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']))
const SEQUENCE_PRIVILEGES = Object.freeze(['USAGE', 'SELECT', 'UPDATE'])
const DENIED_CODES = new Set(['42501', '25006'])

function check(results, name, ok, detail = '') {
  results.push({ check: name, ok: Boolean(ok), detail })
}

function sameSet(left, right) {
  return left.length === right.length && left.every(value => right.includes(value))
}

function describe(columns) {
  return columns.length === 0 ? 'none' : columns.join(', ')
}

async function checkAttributes(client, spec, results) {
  const { rows: [role] } = await client.query(`
    SELECT current_user AS name, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
    FROM pg_roles WHERE rolname = current_user`)
  check(results, 'connected as the expected role', role.name === spec.role,
    role.name === spec.role ? '' : `connected as ${role.name}`)
  const elevated = ['rolsuper', 'rolcreaterole', 'rolcreatedb', 'rolreplication', 'rolbypassrls'].filter(key => role[key])
  check(results, 'no superuser, createrole, createdb, replication or bypassrls attribute', elevated.length === 0,
    elevated.join(', '))

  const { rows: memberships } = await client.query(`
    SELECT r.rolname, r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls AS elevated
    FROM pg_roles r
    WHERE r.rolname <> current_user AND pg_has_role(current_user, r.oid, 'MEMBER')
    ORDER BY r.rolname`)
  const names = memberships.map(row => row.rolname)
  const expected = spec.memberOf ?? []
  check(results, `role memberships are exactly: ${describe(expected)}`, sameSet(names, expected), describe(names))
  const elevatedMembership = memberships.filter(row => row.elevated).map(row => row.rolname)
  check(results, 'no membership in a privileged role', elevatedMembership.length === 0, elevatedMembership.join(', '))
}

async function checkOwnershipAndSchema(client, results) {
  const { rows: [owned] } = await client.query(`
    SELECT
      (SELECT pg_has_role(current_user, datdba, 'USAGE') FROM pg_database WHERE datname = current_database()) AS database,
      pg_has_role(current_user, n.nspowner, 'USAGE') AS schema,
      (SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = n.oid AND pg_has_role(current_user, c.relowner, 'USAGE')) AS relations,
      (SELECT count(*)::int FROM pg_type t WHERE t.typnamespace = n.oid AND pg_has_role(current_user, t.typowner, 'USAGE')) AS types,
      (SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = n.oid AND pg_has_role(current_user, p.proowner, 'USAGE')) AS functions,
      has_schema_privilege(current_user, n.oid, 'USAGE') AS schema_usage,
      has_schema_privilege(current_user, n.oid, 'CREATE') AS schema_create,
      has_database_privilege(current_user, current_database(), 'CREATE') AS database_create
    FROM pg_namespace n WHERE n.nspname = 'public'`)
  const ownership = [
    owned.database && 'the database',
    owned.schema && 'schema public',
    owned.relations > 0 && `${owned.relations} relation(s)`,
    owned.types > 0 && `${owned.types} type(s)`,
    owned.functions > 0 && `${owned.functions} function(s)`,
  ].filter(Boolean)
  check(results, 'owns nothing (no ALTER/DROP through ownership)', ownership.length === 0, ownership.join(', '))
  check(results, 'USAGE on schema public', owned.schema_usage)
  check(results, 'no CREATE on schema public', !owned.schema_create)
  check(results, 'no CREATE on the database', !owned.database_create)
}

async function checkRelations(client, spec, results, serverVersion) {
  const privileges = serverVersion >= 170000 ? [...TABLE_PRIVILEGES, 'MAINTAIN'] : TABLE_PRIVILEGES
  const { rows: relations } = await client.query(`
    SELECT c.oid, c.relname, c.relkind
    FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    ORDER BY c.relname`)
  for (const name of Object.keys(spec.tables)) {
    check(results, `table ${name} exists`, relations.some(row => row.relname === name && row.relkind !== 'S'))
  }
  for (const relation of relations) {
    if (relation.relkind === 'S') {
      const { rows: [held] } = await client.query(`SELECT ${SEQUENCE_PRIVILEGES.map((privilege, index) =>
        `has_sequence_privilege(current_user, $1::oid, '${privilege}') AS p${index}`).join(', ')}`, [relation.oid])
      const granted = SEQUENCE_PRIVILEGES.filter((privilege, index) => held[`p${index}`])
      const allowed = spec.selectAll ? ['SELECT'] : []
      const unexpected = granted.filter(privilege => !allowed.includes(privilege))
      check(results, `sequence ${relation.relname}: no ${SEQUENCE_PRIVILEGES.filter(p => !allowed.includes(p)).join('/')}`,
        unexpected.length === 0, unexpected.join(', '))
      continue
    }
    const expected = spec.tables[relation.relname] ?? {}
    const { rows: columns } = await client.query(`
      SELECT attnum, attname FROM pg_attribute
      WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped ORDER BY attnum`, [relation.oid])
    for (const privilege of privileges) {
      const { rows: [table] } = await client.query(
        `SELECT has_table_privilege(current_user, $1::oid, '${privilege}') AS held`, [relation.oid])
      let heldColumns = []
      if (COLUMN_PRIVILEGES.has(privilege) && !table.held) {
        const { rows } = await client.query(`
          SELECT attname FROM pg_attribute
          WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped
            AND has_column_privilege(current_user, $1::oid, attnum, '${privilege}')
          ORDER BY attnum`, [relation.oid])
        heldColumns = rows.map(row => row.attname)
      }
      let want = expected[privilege]
      if (want === undefined && privilege === 'SELECT' && spec.selectAll) want = true
      const label = `${relation.relname}: ${privilege}`
      if (want === true) {
        check(results, `${label} on the whole table`, table.held,
          table.held ? '' : `missing${heldColumns.length > 0 ? ` (only columns ${heldColumns.join(', ')})` : ''}`)
      } else if (Array.isArray(want)) {
        const ok = !table.held && sameSet(heldColumns, want)
        check(results, `${label} only on columns ${want.join(', ')}`, ok,
          table.held ? 'granted on the whole table' : `held on ${describe(heldColumns)}`)
        if (want.some(column => !columns.some(row => row.attname === column))) {
          check(results, `${label}: expected columns exist`, false,
            want.filter(column => !columns.some(row => row.attname === column)).join(', '))
        }
      } else {
        const ok = !table.held && heldColumns.length === 0
        check(results, `${label} not held`, ok,
          ok ? '' : table.held ? 'granted on the whole table' : `granted on columns ${heldColumns.join(', ')}`)
      }
    }
  }
}

async function checkSettings(client, spec, results) {
  const { rows } = await client.query(`
    SELECT unnest(s.setconfig) AS setting
    FROM pg_db_role_setting s
    WHERE s.setrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
      AND s.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))`)
  const configured = new Map(rows.map(row => {
    const index = row.setting.indexOf('=')
    return [row.setting.slice(0, index), row.setting.slice(index + 1)]
  }))
  for (const [name, kind] of Object.entries(spec.settings)) {
    const { rows: [effective] } = await client.query('SELECT current_setting($1) AS value', [name])
    const value = configured.get(name)
    let ok = value !== undefined
    if (kind === 'on') ok &&= value === 'on' && effective.value === 'on'
    if (kind === 'timeout' || kind === 'limit') ok &&= !/^(0|-1)([a-z]*)$/u.test(value) && !/^(0|-1)([a-z]*)$/u.test(effective.value)
    check(results, `role setting ${name} (${kind === 'present' ? 'set' : kind === 'on' ? 'on' : 'set and non-zero'})`, ok,
      `role: ${value ?? 'unset'}, effective: ${effective.value}`)
  }
}

function deniedError(error) {
  return DENIED_CODES.has(error.code) || /must be owner/u.test(error.message)
}

async function runProbes(client, spec, results) {
  await client.query('BEGIN')
  try {
    await client.query(`SET LOCAL lock_timeout = '200ms'`)
    await client.query(`SET LOCAL statement_timeout = '5s'`)
    for (const statement of spec.probes.allowed) {
      await client.query('SAVEPOINT probe')
      try {
        await client.query(statement)
        check(results, `allowed: ${statement}`, true)
      } catch (error) {
        check(results, `allowed: ${statement}`, false, `refused (${error.code ?? 'error'})`)
      }
      await client.query('ROLLBACK TO SAVEPOINT probe')
    }
    for (const statement of [...COMMON_DENIED, ...spec.probes.denied]) {
      await client.query('SAVEPOINT probe')
      try {
        await client.query(statement)
        check(results, `refused: ${statement}`, false, 'statement succeeded (rolled back)')
      } catch (error) {
        check(results, `refused: ${statement}`, deniedError(error), deniedError(error) ? '' : `unexpected error ${error.code ?? ''}`)
      }
      await client.query('ROLLBACK TO SAVEPOINT probe')
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {})
  }
}

/** Verify one role. Returns { role, prefix, status: 'pass'|'fail'|'error', checks, error? }. */
export async function verifyRole(name, env) {
  const spec = ROLE_SPECS[name]
  if (!spec) throw new ConfigError(`unknown role ${name}; expected one of ${ROLE_NAMES.join(', ')}`)
  const report = { role: spec.role, prefix: spec.prefix, status: 'fail', checks: [] }
  let options
  try {
    const roleEnv = { ...env }
    if (!roleEnv[`${spec.prefix}PGUSER`]) roleEnv[`${spec.prefix}PGUSER`] = spec.role
    options = connection(roleEnv, spec.prefix)
  } catch (error) {
    report.status = 'error'
    report.error = error instanceof ConfigError ? error.message : 'invalid connection settings'
    return report
  }
  const client = new pg.Client({ ...options, application_name: 'telemetry-verify-permissions', connectionTimeoutMillis: 10000 })
  client.on('error', () => {})
  try {
    await client.connect()
  } catch (error) {
    report.status = 'error'
    report.error = `cannot connect as ${spec.role}: ${error.code ?? 'error'} ${error.message}`
    return report
  }
  try {
    const { rows: [server] } = await client.query(`SELECT current_setting('server_version_num')::int AS version`)
    await checkAttributes(client, spec, report.checks)
    await checkOwnershipAndSchema(client, report.checks)
    await checkRelations(client, spec, report.checks, server.version)
    await checkSettings(client, spec, report.checks)
    await runProbes(client, spec, report.checks)
    report.status = report.checks.every(item => item.ok) ? 'pass' : 'fail'
  } catch (error) {
    report.status = 'error'
    report.error = `verification aborted: ${error.code ?? 'error'} ${error.message}`
  } finally {
    await client.end().catch(() => {})
  }
  return report
}

export async function verifyPermissions(env, roles = ROLE_NAMES) {
  const reports = []
  for (const role of roles) reports.push(await verifyRole(role, env))
  return { ok: reports.length > 0 && reports.every(report => report.status === 'pass'), reports }
}

export function formatReport(result, { verbose = false } = {}) {
  const lines = []
  for (const report of result.reports) {
    const failed = report.checks.filter(item => !item.ok).length
    const summary = report.status === 'error' ? report.error : `${report.checks.length - failed}/${report.checks.length} checks passed`
    lines.push(`${report.status.toUpperCase().padEnd(5)} ${report.role} (${report.prefix}*): ${summary}`)
    for (const item of report.checks) {
      if (item.ok && !verbose) continue
      lines.push(`  ${item.ok ? 'ok  ' : 'FAIL'}  ${item.check}${item.detail ? ` [${item.detail}]` : ''}`)
    }
  }
  const failing = result.reports.filter(report => report.status !== 'pass').length
  lines.push(result.ok ? `result: PASS (${result.reports.length} roles)` : `result: FAIL (${failing} of ${result.reports.length} roles)`)
  return `${lines.join('\n')}\n`
}

function parseArguments(argv) {
  const options = { roles: ROLE_NAMES, json: false, verbose: false }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--json') options.json = true
    else if (argument === '--verbose') options.verbose = true
    else if (argument === '--roles') {
      const value = argv[++index]
      if (!value) throw new ConfigError('--roles needs a comma-separated list')
      options.roles = value.split(',').map(role => role.trim()).filter(Boolean)
      const unknown = options.roles.filter(role => !ROLE_NAMES.includes(role))
      if (unknown.length > 0 || options.roles.length === 0) {
        throw new ConfigError(`--roles accepts ${ROLE_NAMES.join(', ')}`)
      }
    } else {
      throw new ConfigError(`unknown argument ${argument}; usage: verify-permissions.js [--roles ${ROLE_NAMES.join(',')}] [--json] [--verbose]`)
    }
  }
  return options
}

async function main(argv, env) {
  const options = parseArguments(argv)
  const result = await verifyPermissions(env, options.roles)
  process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : formatReport(result, options))
  return result.ok ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).then(
    code => { process.exitCode = code },
    error => {
      console.error(`verify-permissions: ${error instanceof ConfigError ? error.message : 'failed'}`)
      process.exitCode = 2
    })
}
