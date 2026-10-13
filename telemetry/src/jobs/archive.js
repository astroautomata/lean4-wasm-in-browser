import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { ConfigError, connection, integer, string } from '../env.js'
import { decodeChunk, DEFAULT_LIMITS, formatPgTimestamp } from '../trajectory/codec.js'
import { archiveSource, ATTEMPT_COLUMNS, attemptFromRow, chunkManifest } from '../trajectory/reader.js'

/** Archive published trajectory chunks to a directory (docs/compaction.md
 * "Archive"). Off-server upload is the operator's command (ARCHIVE_UPLOAD_CMD
 * in ops docs), run after this job; `--verify` should then be run on the
 * uploaded copy (or a re-downloaded one) before any retention relies on it.
 *
 * Layout, self-contained so a chunk never depends on database context:
 *
 *   FORMAT.md, trajectory_codec.py        format spec and reference decoder
 *   manifest.jsonl                        one line per archived chunk
 *   attempts/<aa>/<attempt_id>/attempt.json     the attempt row and its user
 *   attempts/<aa>/<attempt_id>/chunk-<id>.json  chunk manifest
 *   attempts/<aa>/<attempt_id>/chunk-<id>.ltj.gz  payload, byte-identical
 *   attempts/<aa>/<attempt_id>/verified.json    written by --verify
 *
 * Only attempts whose detail is entirely in published chunks (no live rows)
 * are archived, so an archived attempt is a complete second copy. This job
 * never deletes database rows; retention decides that separately. */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')

export function loadArchiveConfig(env = process.env, argv = []) {
  const options = { verify: false, dir: null, since: null, until: null, limit: null }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    const value = () => {
      if (index + 1 >= argv.length) throw new ConfigError(`${flag} needs a value`)
      return argv[++index]
    }
    if (flag === '--verify') options.verify = true
    else if (flag === '--dir') options.dir = value()
    else if (flag === '--since') options.since = new Date(value())
    else if (flag === '--until') options.until = new Date(value())
    else if (flag === '--limit') options.limit = Number(value())
    else throw new ConfigError(`unknown argument ${flag}`)
  }
  options.dir ??= string(env, 'ARCHIVE_DIR')
  if (!options.dir) throw new ConfigError('--dir or ARCHIVE_DIR is required')
  for (const key of ['since', 'until']) {
    if (options[key] && Number.isNaN(options[key].getTime())) throw new ConfigError(`--${key} must be a date`)
  }
  if (options.limit !== null && !(Number.isInteger(options.limit) && options.limit > 0)) throw new ConfigError('--limit must be a positive integer')
  return {
    ...options,
    connection: options.verify ? null : connection(env, 'READER_'),
    batchSize: integer(env, 'ARCHIVE_BATCH_SIZE', 100, { min: 1, max: 1000 }),
  }
}

async function writeAtomic(file, data) {
  const temporary = `${file}.partial-${process.pid}`
  await fs.writeFile(temporary, data)
  await fs.rename(temporary, file)
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function attemptDocument(attempt) {
  const time = value => (value === null ? null : formatPgTimestamp(value))
  return {
    format: 'lean-telemetry-attempt/1',
    attempt_id: attempt.attemptId,
    user: { user_id: attempt.userId, first_seen: time(attempt.userFirstSeenUs), last_seen: time(attempt.userLastSeenUs) },
    source_attempt_id: attempt.sourceAttemptId,
    game_id: attempt.gameId,
    world_id: attempt.worldId,
    level_id: attempt.levelId,
    mode: attempt.mode,
    started_at: time(attempt.startedAtUs),
    completed: attempt.completed,
    completed_at: time(attempt.completedAtUs),
    duration_ms: attempt.durationMs,
    initial_script: attempt.initialScript,
    play_script: attempt.playScript,
    lean_script: attempt.leanScript,
    attributes: attempt.attributes,
    received_at: time(attempt.receivedAtUs),
    last_received_at: time(attempt.lastReceivedAtUs),
    start: { event_id: attempt.startEventId, sequence: attempt.startSequence,
      client_ts: time(attempt.startClientTsUs), elapsed_ms: attempt.startElapsedMs },
    completion: { event_id: attempt.completionEventId, sequence: attempt.completionSequence,
      received_at: time(attempt.completionReceivedAtUs) },
    later_completion_sequences: attempt.laterCompletionSequences,
    // Exact microsecond values, for tools that need more than the text form.
    micros: {
      started_at: attempt.startedAtUs, completed_at: attempt.completedAtUs, received_at: attempt.receivedAtUs,
      last_received_at: attempt.lastReceivedAtUs, start_client_ts: attempt.startClientTsUs,
    },
  }
}

/** Archive eligible attempts. Returns { attempts, chunks, bytes }. */
export async function runArchive(pool, config, { log = () => {} } = {}) {
  const archive = archiveSource(config.dir)
  await fs.mkdir(archive.directory, { recursive: true })
  for (const [source, name] of [[path.join(ROOT, 'tools', 'trajectory_codec.py'), 'trajectory_codec.py'],
    [path.join(ROOT, 'docs', 'trajectory-format.md'), 'FORMAT.md']]) {
    await fs.copyFile(source, path.join(archive.directory, name))
  }
  const manifestFile = path.join(archive.directory, 'manifest.jsonl')
  const totals = { attempts: 0, chunks: 0, bytes: 0 }
  let cursor = '00000000-0000-0000-0000-000000000000'
  const activity = `COALESCE(a.last_received_at, a.received_at, (SELECT applied_at FROM schema_migrations WHERE version = '005'))`
  for (;;) {
    const params = [cursor, config.batchSize]
    const where = ['a.attempt_id > $1::uuid',
      `EXISTS (SELECT 1 FROM trajectory_chunks c WHERE c.attempt_id = a.attempt_id AND c.state = 'published')`,
      'NOT EXISTS (SELECT 1 FROM proof_steps s WHERE s.attempt_id = a.attempt_id)']
    if (config.since) where.push(`${activity} >= $${params.push(config.since)}`)
    if (config.until) where.push(`${activity} < $${params.push(config.until)}`)
    const rows = (await pool.query(`SELECT ${ATTEMPT_COLUMNS}
      FROM proof_attempts a LEFT JOIN anonymous_users u ON u.user_id = a.user_id
      WHERE ${where.join(' AND ')} ORDER BY a.attempt_id LIMIT $2`, params)).rows
    for (const row of rows) {
      cursor = row.attempt_id
      const attempt = attemptFromRow(row)
      const directory = archive.attemptDirectory(attempt.attemptId)
      await fs.mkdir(directory, { recursive: true })
      await writeAtomic(path.join(directory, 'attempt.json'), `${JSON.stringify(attemptDocument(attempt), null, 2)}\n`)
      const chunks = (await pool.query(`
        SELECT chunk_id::text, kind, format, codec, seq_first, seq_last, event_count, uncompressed_bytes, compressed_bytes,
               checksum, payload FROM trajectory_chunks
        WHERE attempt_id = $1 AND state = 'published' ORDER BY seq_first`, [attempt.attemptId])).rows
      for (const chunk of chunks) {
        // Decode before archiving: a corrupt chunk must not become the archive copy.
        decodeChunk(chunk.payload, chunkManifest(chunk, attempt.attemptId), DEFAULT_LIMITS)
        const payloadFile = `chunk-${chunk.chunk_id}.ltj.gz`
        await writeAtomic(path.join(directory, payloadFile), chunk.payload)
        const manifest = {
          chunk_id: chunk.chunk_id, attempt_id: attempt.attemptId, kind: chunk.kind, format: chunk.format, codec: chunk.codec,
          seq_first: chunk.seq_first, seq_last: chunk.seq_last, event_count: chunk.event_count,
          uncompressed_bytes: chunk.uncompressed_bytes, compressed_bytes: chunk.compressed_bytes,
          checksum_sha256: chunk.checksum.toString('hex'), compressed_sha256: sha256(chunk.payload), payload_file: payloadFile,
        }
        await writeAtomic(path.join(directory, `chunk-${chunk.chunk_id}.json`), `${JSON.stringify(manifest, null, 2)}\n`)
        await fs.appendFile(manifestFile, `${JSON.stringify(manifest)}\n`)
        totals.chunks++
        totals.bytes += chunk.compressed_bytes
      }
      // A fresh export invalidates any earlier verification of this attempt.
      await fs.rm(path.join(directory, 'verified.json'), { force: true })
      totals.attempts++
      if (config.limit && totals.attempts >= config.limit) return totals
    }
    log('info', 'archive batch', { attempts: totals.attempts, chunks: totals.chunks })
    if (rows.length < config.batchSize) return totals
  }
}

/** Verify an archive directory: every chunk file's hash, decode within limits,
 * count and range, and its attempt document. Writes verified.json per fully
 * verified attempt; returns { attempts, chunks, failures: [...] }. */
export async function verifyArchive(directory, { limits = DEFAULT_LIMITS } = {}) {
  const archive = archiveSource(directory)
  const result = { attempts: 0, chunks: 0, failures: [] }
  const shards = await fs.readdir(path.join(archive.directory, 'attempts')).catch(() => [])
  for (const shard of shards.sort()) {
    for (const attemptId of (await fs.readdir(path.join(archive.directory, 'attempts', shard))).sort()) {
      const attemptDirectory = archive.attemptDirectory(attemptId)
      const verified = {}
      let ok = true
      try {
        const attempt = JSON.parse(await fs.readFile(path.join(attemptDirectory, 'attempt.json'), 'utf8'))
        if (attempt.attempt_id !== attemptId) throw new Error('attempt document mismatch')
      } catch (error) {
        result.failures.push({ attemptId, code: 'attempt_document', message: error.message })
        continue
      }
      for (const row of await archive.chunksFor(attemptId).catch(error => {
        result.failures.push({ attemptId, code: 'manifest', message: error.message })
        ok = false
        return []
      })) {
        try {
          const manifest = JSON.parse(await fs.readFile(path.join(attemptDirectory, `chunk-${row.chunk_id}.json`), 'utf8'))
          const payload = await row.loadPayload()
          if (sha256(payload) !== manifest.compressed_sha256) throw new Error('payload hash mismatch')
          const actions = decodeChunk(payload, chunkManifest(row, attemptId), limits)
          if (actions.length !== row.event_count) throw new Error('event count mismatch')
          verified[row.chunk_id] = { compressed_sha256: manifest.compressed_sha256, checksum_sha256: manifest.checksum_sha256 }
          result.chunks++
        } catch (error) {
          ok = false
          result.failures.push({ attemptId, chunkId: row.chunk_id, code: error.code ?? 'chunk', message: error.message })
        }
      }
      if (ok) {
        await writeAtomic(path.join(attemptDirectory, 'verified.json'),
          `${JSON.stringify({ verified_at: new Date().toISOString(), chunks: verified }, null, 2)}\n`)
        result.attempts++
      } else {
        await fs.rm(path.join(attemptDirectory, 'verified.json'), { force: true })
      }
    }
  }
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let config
  try {
    config = loadArchiveConfig(process.env, process.argv.slice(2))
  } catch (error) {
    console.error(`archive: ${error.message}`)
    process.exit(2)
  }
  const done = config.verify
    ? verifyArchive(config.dir).then(result => {
      console.log(JSON.stringify(result))
      if (result.failures.length > 0) process.exitCode = 1
    })
    : (async () => {
      const pool = new pg.Pool({ ...config.connection, max: 1, application_name: 'telemetry-archive' })
      try {
        console.log(JSON.stringify(await runArchive(pool, config, {
          log: (level, message, fields) => console.error(JSON.stringify({ level, message, ...fields })),
        })))
      } finally {
        await pool.end()
      }
    })()
  done.catch(error => {
    console.error(`archive failed: ${error.message}`)
    process.exitCode = 1
  })
}
