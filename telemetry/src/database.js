import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const { Pool } = pg
const directory = path.dirname(fileURLToPath(import.meta.url))

/** `attributes` for a new attempt or feedback row: the game build, if known. */
function buildAttributes(build) {
  return JSON.stringify(build ? { build } : {})
}

export function createDatabase(connectionString) {
  const pool = new Pool({
    ...(connectionString ? { connectionString } : {}),
    max: Number(process.env.PG_POOL_SIZE || 10),
  })

  async function migrate() {
    const migrationsDirectory = path.join(directory, '..', 'migrations')
    const migrationFiles = (await fs.readdir(migrationsDirectory))
      .filter(file => file.endsWith('.sql')).sort()
    const client = await pool.connect()
    try {
      await client.query('SELECT pg_advisory_lock(710426314)')
      for (const file of migrationFiles) {
        const sql = await fs.readFile(path.join(migrationsDirectory, file), 'utf8')
        await client.query(sql)
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(710426314)').catch(() => {})
      client.release()
    }
  }

  async function store(events) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const event of events) {
        await client.query(`
          INSERT INTO anonymous_users (user_id, first_seen, last_seen)
          VALUES ($1, $2, $2)
          ON CONFLICT (user_id) DO UPDATE SET last_seen = GREATEST(anonymous_users.last_seen, EXCLUDED.last_seen)
        `, [event.userId, event.clientTs])
        // An attempt runs within one page load, so the build reported by the
        // event that creates it holds for the whole attempt.
        await client.query(`
          INSERT INTO proof_attempts
            (attempt_id, user_id, source_attempt_id, game_id, world_id, level_id, mode, started_at, initial_script,
             attributes)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (attempt_id) DO NOTHING
        `, [event.attemptId, event.userId, event.sourceAttemptId, event.gameId, event.worldId,
          event.levelId, event.mode, event.clientTs, event.initialScript, buildAttributes(event.build)])

        if (event.eventType === 'proof_step') {
          await client.query(`
            INSERT INTO proof_steps
              (event_id, attempt_id, sequence, client_ts, elapsed_ms, step_type, command, from_line, removed_lines)
            SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
            WHERE EXISTS (
              SELECT 1 FROM proof_attempts
              WHERE attempt_id = $2 AND user_id = $10 AND game_id = $11
                AND world_id = $12 AND level_id = $13 AND mode = $14
            )
            ON CONFLICT DO NOTHING
          `, [event.eventId, event.attemptId, event.sequence, event.clientTs, event.elapsedMs,
            event.stepType, event.command, event.fromLine, event.removedLines, event.userId,
            event.gameId, event.worldId, event.levelId, event.mode])
        } else if (event.eventType === 'level_complete') {
          await client.query(`
            UPDATE proof_attempts SET
              completed_at = $2, duration_ms = $3, completed = true,
              play_script = $4, lean_script = $5
            WHERE attempt_id = $1 AND user_id = $6 AND game_id = $7
              AND world_id = $8 AND level_id = $9 AND mode = $10
          `, [event.attemptId, event.clientTs, event.elapsedMs, event.playScript, event.leanScript,
            event.userId, event.gameId, event.worldId, event.levelId, event.mode])
        }
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async function storeFeedback(feedback) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      if (feedback.userId) {
        await client.query(`
          INSERT INTO anonymous_users (user_id, first_seen, last_seen)
          VALUES ($1, $2, $2)
          ON CONFLICT (user_id) DO UPDATE SET last_seen = GREATEST(anonymous_users.last_seen, EXCLUDED.last_seen)
        `, [feedback.userId, feedback.clientTs])
      }
      await client.query(`
        INSERT INTO feedback_reports
          (report_id, user_id, game_id, world_id, level_id, mode, message, proof_state, client_ts, attributes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (report_id) DO NOTHING
      `, [feedback.reportId, feedback.userId, feedback.gameId, feedback.worldId,
        feedback.levelId, feedback.mode, feedback.message, feedback.proofState, feedback.clientTs,
        buildAttributes(feedback.build)])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  return { pool, migrate, store, storeFeedback }
}
