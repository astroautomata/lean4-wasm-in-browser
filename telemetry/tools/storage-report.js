import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { probeDisk } from '../src/disk.js'
import { connection } from '../src/env.js'

/** Storage measurement and forecast (plan phase 5.2; docs/capacity.md).
 *
 *   READER_DATABASE_URL=... node tools/storage-report.js [--wal-sample-seconds N]
 *     [--disk-path DIR] [--peak-factor X] [--exact] [--json]
 *
 * Measures every telemetry relation (heap, indexes, TOAST), bytes per live
 * step row and per compacted action (chunks with their receipts and indexes),
 * attempts and feedback, WAL generated over a sampling interval, temporary
 * file usage, free disk, and growth over the last day from trusted ingestion
 * times. Forecasts the days until the 70/80/85 % watermarks at the current and
 * at a peak rate. Read-only; runs as telemetry_reader. Numbers only, no content. */

const TABLES = ['anonymous_users', 'proof_attempts', 'proof_steps', 'trajectory_chunks', 'feedback_reports']
const WATERMARKS = [0.7, 0.8, 0.85]

export function parseArguments(argv) {
  const options = { walSampleSeconds: 60, diskPath: null, peakFactor: 5, exact: false, json: false }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    const value = () => argv[++index]
    if (flag === '--wal-sample-seconds') options.walSampleSeconds = Number(value())
    else if (flag === '--disk-path') options.diskPath = value()
    else if (flag === '--peak-factor') options.peakFactor = Number(value())
    else if (flag === '--exact') options.exact = true
    else if (flag === '--json') options.json = true
    else throw new Error(`unknown argument ${flag}`)
  }
  if (!(options.walSampleSeconds >= 0) || !(options.peakFactor >= 1)) throw new Error('invalid sample seconds or peak factor')
  return options
}

/** Days until each watermark at `bytesPerDay`, from used/total disk bytes. */
export function forecast({ usedBytes, totalBytes, bytesPerDay }) {
  return Object.fromEntries(WATERMARKS.map(mark => {
    const room = mark * totalBytes - usedBytes
    let days
    if (room <= 0) days = 0
    else if (!(bytesPerDay > 0)) days = null
    else days = Number((room / bytesPerDay).toFixed(1))
    return [`${Math.round(mark * 100)}%`, days]
  }))
}

const per = (bytes, count) => (count > 0 ? Number((bytes / count).toFixed(1)) : null)

export async function storageReport(queryable, options = {}) {
  const { walSampleSeconds = 0, diskPath = null, peakFactor = 5, exact = false } = options
  const relations = {}
  const sizes = await queryable.query(`
    SELECT c.relname, pg_relation_size(c.oid) AS heap, pg_indexes_size(c.oid) AS indexes,
           COALESCE(pg_total_relation_size(c.reltoastrelid), 0) AS toast, pg_total_relation_size(c.oid) AS total,
           GREATEST(c.reltuples, 0)::bigint AS estimated_rows
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = ANY($1)`, [TABLES])
  for (const row of sizes.rows) {
    relations[row.relname] = {
      heapBytes: Number(row.heap), indexBytes: Number(row.indexes), toastBytes: Number(row.toast),
      totalBytes: Number(row.total), rows: Number(row.estimated_rows), rowsExact: false,
    }
  }
  if (exact) {
    for (const table of TABLES) {
      const count = await queryable.query(`SELECT count(*)::bigint AS n FROM ${table}`)
      relations[table].rows = Number(count.rows[0].n)
      relations[table].rowsExact = true
    }
  }
  const indexes = await queryable.query(`
    SELECT indexrelname AS name, pg_relation_size(indexrelid) AS bytes FROM pg_stat_user_indexes
    WHERE relname = ANY($1) ORDER BY indexrelname`, [TABLES])
  const chunks = (await queryable.query(`
    SELECT count(*)::bigint AS chunks, COALESCE(sum(event_count), 0)::bigint AS actions,
           COALESCE(sum(compressed_bytes), 0)::bigint AS payload_bytes,
           COALESCE(sum(event_count) FILTER (WHERE sources_removed_at IS NOT NULL), 0)::bigint AS replaced_actions,
           COALESCE(sum(event_count) FILTER (WHERE receipt_event_ids IS NOT NULL), 0)::bigint AS receipt_actions
    FROM trajectory_chunks WHERE state = 'published'`)).rows[0]
  const receiptIndex = indexes.rows.find(row => row.name === 'trajectory_chunks_receipts_idx')
  const steps = relations.proof_steps
  const chunkTable = relations.trajectory_chunks

  // Growth over the last day, from trusted ingestion times only.
  const growth = (await queryable.query(`
    SELECT ((SELECT count(*) FROM proof_steps WHERE received_at > now() - interval '1 day') +
            -- Steps already compacted away (sources removed; no double count
            -- with live rows). A chunk counts whole when any source is recent.
            (SELECT COALESCE(sum(event_count), 0) FROM trajectory_chunks
             WHERE sources_removed_at IS NOT NULL AND max_source_received_at > now() - interval '1 day'))::bigint AS steps_day,
           (SELECT count(*) FROM proof_attempts WHERE received_at > now() - interval '1 day')::bigint AS attempts_day,
           (SELECT count(*) FROM feedback_reports WHERE received_at > now() - interval '1 day')::bigint AS feedback_day,
           (SELECT count(*) FROM proof_steps WHERE received_at IS NULL)::bigint AS historic_steps`)).rows[0]

  let wal = null
  try {
    const start = (await queryable.query('SELECT pg_current_wal_lsn() AS lsn')).rows[0].lsn
    if (walSampleSeconds > 0) await new Promise(resolve => setTimeout(resolve, walSampleSeconds * 1000))
    const end = await queryable.query('SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), $1) AS bytes', [start])
    const bytes = Number(end.rows[0].bytes)
    wal = { sampleSeconds: walSampleSeconds, bytes, bytesPerDay: walSampleSeconds > 0 ? Math.round(bytes / walSampleSeconds * 86400) : null }
  } catch (error) {
    wal = { error: error.code ?? 'unavailable' }
  }
  const temp = (await queryable.query(
    'SELECT temp_files, temp_bytes FROM pg_stat_database WHERE datname = current_database()')).rows[0]
  const databaseBytes = Number((await queryable.query('SELECT pg_database_size(current_database()) AS bytes')).rows[0].bytes)

  const liveBytesPerStep = per(steps.totalBytes, steps.rows)
  const attemptsBytesPer = per(relations.proof_attempts.totalBytes, relations.proof_attempts.rows)
  const feedbackBytesPer = per(relations.feedback_reports.totalBytes, relations.feedback_reports.rows)
  const dailyTableBytes = Math.round(
    Number(growth.steps_day) * (liveBytesPerStep ?? 0) +
    Number(growth.attempts_day) * (attemptsBytesPer ?? 0) +
    Number(growth.feedback_day) * (feedbackBytesPer ?? 0))
  const dailyBytes = dailyTableBytes + (wal?.bytesPerDay ?? 0)

  let disk = null
  if (diskPath) {
    const probe = await probeDisk(diskPath)
    const usedBytes = probe.totalBytes - probe.availableBytes
    disk = {
      totalBytes: probe.totalBytes, availableBytes: probe.availableBytes, utilization: Number(probe.ratio.toFixed(4)),
      daysToWatermarkAtCurrentRate: forecast({ usedBytes, totalBytes: probe.totalBytes, bytesPerDay: dailyBytes }),
      daysToWatermarkAtPeakRate: forecast({ usedBytes, totalBytes: probe.totalBytes, bytesPerDay: dailyBytes * peakFactor }),
      peakFactor,
    }
  }

  return {
    measuredAt: new Date().toISOString(),
    databaseBytes,
    relations,
    indexes: Object.fromEntries(indexes.rows.map(row => [row.name, Number(row.bytes)])),
    perRecord: {
      liveStepBytes: liveBytesPerStep,
      compactedActionBytes: per(chunkTable.totalBytes, Number(chunks.actions)),
      compactedPayloadBytesPerAction: per(Number(chunks.payload_bytes), Number(chunks.actions)),
      receiptIndexBytesPerAction: receiptIndex ? per(Number(receiptIndex.bytes), Number(chunks.receipt_actions)) : null,
      attemptBytes: attemptsBytesPer,
      feedbackBytes: feedbackBytesPer,
    },
    chunks: {
      published: Number(chunks.chunks), actions: Number(chunks.actions), replacedActions: Number(chunks.replaced_actions),
      payloadBytes: Number(chunks.payload_bytes),
    },
    lastDay: {
      steps: Number(growth.steps_day), attempts: Number(growth.attempts_day), feedback: Number(growth.feedback_day),
      estimatedTableBytes: dailyTableBytes,
      historicStepsWithoutIngestionTime: Number(growth.historic_steps),
    },
    wal,
    tempFiles: { files: Number(temp.temp_files), bytes: Number(temp.temp_bytes) },
    estimatedDailyGrowthBytes: dailyBytes,
    disk,
    notes: [
      'Bytes per row include each table\'s indexes and TOAST; row counts are planner estimates unless --exact.',
      'Daily growth uses live-row sizes for new steps (before compaction) plus the sampled WAL rate.',
      'Budget the whole disk (docs/capacity.md): recent rows + compacted paths + summaries/receipts/indexes + WAL + OS/logs + backup staging + compaction headroom.',
    ],
  }
}

function human(report) {
  const mb = bytes => (bytes === null || bytes === undefined ? 'n/a' : `${(bytes / 1e6).toFixed(1)} MB`)
  const lines = [`Telemetry storage report ${report.measuredAt}`, `Database: ${mb(report.databaseBytes)}`, '']
  for (const [name, relation] of Object.entries(report.relations)) {
    lines.push(`${name.padEnd(18)} rows ${String(relation.rows).padStart(10)}  heap ${mb(relation.heapBytes).padStart(10)}  ` +
      `indexes ${mb(relation.indexBytes).padStart(10)}  toast ${mb(relation.toastBytes).padStart(10)}`)
  }
  lines.push('', `Live step row: ${report.perRecord.liveStepBytes ?? 'n/a'} B; compacted action: ${report.perRecord.compactedActionBytes ?? 'n/a'} B ` +
    `(payload ${report.perRecord.compactedPayloadBytesPerAction ?? 'n/a'} B, receipts index ${report.perRecord.receiptIndexBytesPerAction ?? 'n/a'} B)`)
  lines.push(`Last day: ${report.lastDay.steps} steps, ${report.lastDay.attempts} attempts, ${report.lastDay.feedback} feedback; ` +
    `estimated growth ${mb(report.estimatedDailyGrowthBytes)}/day`)
  if (report.wal?.bytes !== undefined) lines.push(`WAL: ${mb(report.wal.bytes)} in ${report.wal.sampleSeconds} s`)
  if (report.disk) {
    lines.push(`Disk: ${(report.disk.utilization * 100).toFixed(1)} % used of ${mb(report.disk.totalBytes)}`)
    lines.push(`Days to watermarks (current): ${JSON.stringify(report.disk.daysToWatermarkAtCurrentRate)}`)
    lines.push(`Days to watermarks (${report.disk.peakFactor}x peak): ${JSON.stringify(report.disk.daysToWatermarkAtPeakRate)}`)
  }
  return `${lines.join('\n')}\n`
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options
  try {
    options = parseArguments(process.argv.slice(2))
  } catch (error) {
    console.error(`storage-report: ${error.message}`)
    process.exit(2)
  }
  const pool = new pg.Pool({ ...connection(process.env, 'READER_'), max: 1, application_name: 'telemetry-storage-report' })
  storageReport(pool, options)
    .then(report => process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : human(report)),
      error => {
        console.error(`storage-report failed: ${error.message}`)
        process.exitCode = 1
      })
    .finally(() => pool.end())
}
