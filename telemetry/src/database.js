import pg from 'pg'
import { abortErrorFrom, AbortError, connectionUnusable, databaseErrorClass, describeError } from './http/errors.js'
import { sqlFromMicros } from './trajectory/codec.js'

const { Pool } = pg

/** The collector's PostgreSQL access: one small pool for the runtime writer
 * role, with deadlines enforced by PostgreSQL itself.
 *
 * statement_timeout, lock_timeout and idle_in_transaction_session_timeout are
 * session settings sent at connect, so the server cancels stuck work even when
 * the collector stops waiting for it. query_timeout is only a client-side
 * backstop; when it fires the connection is destroyed, because the server may
 * still be running the query. A connection whose state is uncertain is never
 * returned to the pool. */

export function poolOptions(config) {
  return {
    ...config.connection,
    max: config.poolSize,
    connectionTimeoutMillis: config.poolAcquireTimeoutMs,
    query_timeout: config.queryTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    lock_timeout: config.lockTimeoutMs,
    idle_in_transaction_session_timeout: config.idleInTxTimeoutMs,
    application_name: 'telemetry-collector',
    idleTimeoutMillis: 30000,
    keepAlive: true,
  }
}

/** Upsert users once per batch, in sorted order: first_seen on insert,
 * last_seen only moves forward, and only by more than the resolution, so an
 * unchanged user row is not rewritten. */
export const UPSERT_USERS_SQL = `
  INSERT INTO anonymous_users AS u (user_id, first_seen, last_seen)
  SELECT v.user_id, ${sqlFromMicros('v.first_us')}, ${sqlFromMicros('v.last_us')}
  FROM unnest($1::uuid[], $2::bigint[], $3::bigint[]) AS v(user_id, first_us, last_us)
  ORDER BY v.user_id
  ON CONFLICT (user_id) DO UPDATE SET last_seen = EXCLUDED.last_seen
  WHERE EXCLUDED.last_seen > u.last_seen + $4::bigint * interval '1 millisecond'`

const INSERT_FEEDBACK_SQL = `
  INSERT INTO feedback_reports
    (report_id, user_id, game_id, world_id, level_id, mode, message, proof_state, client_ts, attributes)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, ${sqlFromMicros('$9')}, $10::jsonb)
  ON CONFLICT (report_id) DO NOTHING
  RETURNING report_id`

// Build and platform attributes are not part of a report's identity.
const SAME_FEEDBACK_SQL = `
  SELECT (user_id IS NOT DISTINCT FROM $2::uuid AND game_id = $3 AND world_id = $4 AND level_id = $5
          AND mode = $6::telemetry_mode AND message = $7 AND proof_state = $8::jsonb
          AND client_ts = ${sqlFromMicros('$9')}) AS same
  FROM feedback_reports WHERE report_id = $1`

/** `attributes` for a new attempt or feedback row: the game build and the
 * player's browser family and device type, each if known. */
export function rowAttributes({ build, platform }) {
  return JSON.stringify({ ...(build ? { build } : {}), ...(platform ? { platform } : {}) })
}

/** createDatabase(config, { metrics, log, pool }) → { pool, withTransaction,
 * storeFeedback, checkReady, observe, sample, close }.
 * `pool` may be injected (tests wrap it to count statements). */
export function createDatabase(config, { metrics = null, log = message => console.error(message), pool = null } = {}) {
  const ownPool = !pool
  pool ??= new Pool(poolOptions(config))
  let observer = { success() {}, failure() {} }

  function count(error) {
    if (error instanceof AbortError) return
    const errorClass = databaseErrorClass(error)
    metrics?.dbErrors.inc({ class: errorClass })
    if (errorClass === 'connection' || errorClass === 'shutdown') observer.failure(error)
  }

  pool.on('error', error => {
    // An idle client lost its connection (server restart, pg_terminate_backend,
    // network). The pool has already discarded it; the next checkout connects anew.
    metrics?.dbErrors.inc({ class: 'idle_client' })
    log(`telemetry: idle database connection lost (${describeError(error)})`)
    observer.failure(error)
  })

  /** Run `fn(query, client)` inside BEGIN/COMMIT on one pool client. `query`
   * refuses to start a statement once `signal` aborted, so an abandoned
   * request rolls back at the next statement boundary instead of committing.
   * Rejects with the original error; nothing is committed unless COMMIT
   * succeeded. */
  async function withTransaction(fn, { signal } = {}) {
    if (signal?.aborted) throw abortErrorFrom(signal)
    const stopAcquire = metrics?.poolAcquire.startTimer()
    let client
    try {
      client = await pool.connect()
    } catch (error) {
      count(error)
      throw error
    } finally {
      stopAcquire?.()
    }
    let lost = null
    // A checked-out client has no pool listener: without this, a connection
    // dropped mid-transaction would emit an unhandled 'error' and crash.
    const onClientError = error => { lost = error }
    client.on('error', onClientError)
    const stopTransaction = metrics?.dbTransaction.startTimer()
    let begun = false
    let unusable = null
    const query = (text, values) => {
      if (signal?.aborted) return Promise.reject(abortErrorFrom(signal))
      metrics?.dbStatements.inc()
      return client.query(text, values)
    }
    try {
      await query('BEGIN')
      begun = true
      const result = await fn(query, client)
      await query('COMMIT')
      observer.success()
      return result
    } catch (error) {
      if (lost || connectionUnusable(error)) {
        unusable = lost ?? error
      } else if (begun) {
        try {
          await client.query('ROLLBACK')
        } catch (rollbackError) {
          unusable = rollbackError
        }
      }
      count(error)
      throw error
    } finally {
      stopTransaction?.()
      client.off('error', onClientError)
      // release(error) destroys the connection instead of pooling it.
      client.release(unusable ?? undefined)
    }
  }

  /** 'accepted', 'duplicate' (same report id and content) or 'conflict'. */
  function storeFeedback(feedback, { signal } = {}) {
    const values = [feedback.reportId, feedback.userId, feedback.gameId, feedback.worldId, feedback.levelId,
      feedback.mode, feedback.message, JSON.stringify(feedback.proofState), feedback.clientTsUs]
    return withTransaction(async query => {
      if (feedback.userId) {
        await query(UPSERT_USERS_SQL, [[feedback.userId], [feedback.clientTsUs], [feedback.clientTsUs], config.lastSeenResolutionMs])
      }
      const inserted = await query(INSERT_FEEDBACK_SQL, [...values, rowAttributes(feedback)])
      if (inserted.rowCount === 1) return 'accepted'
      const existing = await query(SAME_FEEDBACK_SQL, values)
      return existing.rows[0]?.same ? 'duplicate' : 'conflict'
    }, { signal })
  }

  /** One cheap round trip; resolves true or rejects. */
  async function checkReady() {
    await pool.query('SELECT 1')
    observer.success()
    return true
  }

  return {
    pool,
    withTransaction,
    storeFeedback,
    checkReady,
    /** `{ success(), failure(error) }` is told about connectivity (readiness). */
    observe(next) {
      observer = next
    },
    sample() {
      metrics?.poolClients.set({ state: 'total' }, pool.totalCount)
      metrics?.poolClients.set({ state: 'idle' }, pool.idleCount)
      metrics?.poolClients.set({ state: 'waiting' }, pool.waitingCount)
    },
    async close() {
      if (ownPool && !pool.ending && !pool.ended) await pool.end()
    },
  }
}
