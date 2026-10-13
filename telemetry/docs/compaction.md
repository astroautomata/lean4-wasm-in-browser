# Trajectory compaction, retention and archives

Plan phase 5. Compaction changes how accepted proof steps are stored, never
which steps are stored: every accepted action stays replayable, losslessly,
with its identity, timing and content. Retention and archiving are separate,
explicitly decided policies; nothing here deletes data by default.

- Format: `docs/trajectory-format.md`. Contract for consumers:
  `docs/replay-contract.md`. Schema: migrations 005-010.
- Code: `src/trajectory/compactor.js` (library), `src/jobs/compactor.js`
  (worker), `src/trajectory/reader.js` (shared reader), `src/jobs/retention.js`,
  `src/jobs/archive.js`, `tools/verify-chunks.js`, `tools/trajectory_codec.py`.

## Lifecycle

```
live rows ──build──▶ shadow chunk ──verify──▶ ──publish──▶ published chunk ──replace──▶ published, sources removed
  ▲                        │ (mismatch: delete chunk;            │ (mode replace, after the delay,
  │                        │  rows stay live)                    │  canary-bounded; exact source set only)
late steps ─────────────────────────────────────────────────────▶ new live rows ─▶ delta chunks
```

1. **Eligibility** (trusted times only). A step row is eligible when its
   `received_at` (or, for rows ingested before migration 005, that
   migration's `applied_at`) is older than the recent-row window
   `COMPACTION_MIN_AGE_SECONDS` and it is in no chunk yet. Its attempt must be
   completed, or idle (`last_received_at`) for `COMPACTION_INACTIVE_SECONDS`.
   A long active attempt with at least `COMPACTION_ACTIVE_CHUNK_THRESHOLD`
   eligible rows is chunked in full chunks only; the remainder waits.
2. **Build.** Rows are grouped (≤ `COMPACTION_CHUNK_MAX_EVENTS` actions and
   about `COMPACTION_CHUNK_MAX_BYTES` encoded bytes, never splitting an action;
   an over-large group is halved until it fits the codec limits), encoded
   outside any transaction and inserted as a **shadow** chunk with its receipts.
   The stored chunk is read back, decoded and compared field by field with the
   source rows; a mismatch deletes the shadow chunk and counts a verification
   failure.
3. **Publish**, one short transaction: lock the attempt row (`FOR NO KEY
   UPDATE`, which conflicts with the collector writer's `FOR UPDATE`), re-read
   exactly the source rows by event id and require them unchanged, require no
   overlap with another published chunk, set `state = 'published'` and advance
   `proof_attempts.compacted_through`. Stale sources → the shadow chunk is
   discarded and the rows are chunked again later.
4. **Replace** (`COMPACTION_MODE=replace` only), one short transaction per
   chunk published longer than `COMPACTION_REPLACE_DELAY_SECONDS`: lock the
   attempt, re-read the source rows by id, require exact equality with the
   decoded chunk and its receipts, delete exactly those rows, require the
   deleted count, set `sources_removed_at`. Rows of the attempt that arrived
   later are never touched. At most `COMPACTION_REPLACE_LIMIT` chunks are
   replaced per worker run (default 100; `unlimited` to lift it) — the canary
   bound.
5. **Late steps** for sequences that no chunk holds (gaps, or actions after
   the last chunk) are ordinary live rows; they are compacted later as `delta`
   chunks. The writer decides retries of compacted steps from the chunk and its
   receipts (`docs/design.md` section 8), so a retry is a duplicate or a
   conflict and is never inserted again.
6. **Crash recovery.** Every step is a complete transaction or idempotent
   insert. A crash after building leaves a shadow chunk whose sources are
   still live (readers ignore shadow chunks); recovery (`COMPACTION_RECOVER_AFTER_SECONDS`,
   default 1 h) verifies and publishes it, or deletes it if its sources changed.
   A crash after publishing resumes at replacement. At every point at least one
   complete, readable copy of every action exists; the integration tests inject
   a crash at each boundary.

## Modes and rollout

| `COMPACTION_MODE` | Effect |
| --- | --- |
| `off` | the worker idles |
| `shadow` (default) | build, verify and publish; source rows are kept |
| `replace` | additionally remove verified sources (step 4) |

Roll out in this order (plan "Implementation and rollout sequence"):

1. Deploy readers first: collector (post-compaction identity checks),
   exports and replay tools that use `src/trajectory/reader.js`.
2. Run `shadow` mode. Compare complete outputs of `tools/export.js` and
   `extract-replays.py` from a backup restored before compaction with the same
   export afterwards (they must be identical), run `tools/verify-chunks.js`,
   and watch the metrics below.
3. Take and restore-test a backup (`ops/restore-test.sh`), confirm a
   format-compatible rollback image exists (any collector from this release
   on understands chunks; collectors before it do not and are not a valid
   rollback once sources were replaced).
4. Canary `replace` with a small `COMPACTION_REPLACE_LIMIT`, verify again,
   then raise the limit gradually while verification, intake latency,
   compaction backlog and disk headroom stay healthy.

Disabling the worker at any point leaves published chunks readable.

## Resources and pausing

One worker, its own pool of `COMPACTOR_POOL_SIZE` (2) connections as
`telemetry_compactor`, statement timeout 30 s, Compose limits of 384 MiB
memory and one CPU with low CPU shares. A duty cycle (`COMPACTION_DUTY_CYCLE`,
0.25) rests three times as long as it worked. Building pauses while:

- the collector's `/internal/pressure` (metrics port) exceeds
  `COMPACTOR_PRESSURE_THRESHOLD` (0.5), or is unreachable;
- the disk is at the throttle (80 %) or pause (85 %) watermark — building
  temporarily needs space for the chunk beside its sources. Replacement, which
  frees space, continues. With an unreadable disk probe the cycle is skipped.

Sustained compaction throughput must exceed incoming eligible data; alert on a
growing `telemetry_compaction_eligible_rows` or
`telemetry_compaction_backlog_oldest_seconds`, and move compaction off-host
if it competes with intake.

Metrics (worker port 9465): `telemetry_compaction_chunks_total{event,kind}`,
`_rows_total{event}`, `_input_bytes_total`, `_output_bytes_total`,
`_cpu_seconds_total`, `_verification_failures_total{stage}`,
`_orphan_chunks`, `_eligible_rows`, `_backlog_oldest_seconds`,
`_shadow_chunks`, `_awaiting_replace_chunks`, `_cycles_total{result}`,
`_paused{reason}`, `_replace_limit_reached`; database observations
`telemetry_db_relation_bytes{relation,part}` (heap, indexes, TOAST),
`telemetry_db_dead_tuples`, `telemetry_db_last_autovacuum_age_seconds`,
`telemetry_db_wal_bytes`, `telemetry_db_temp_bytes`;
`telemetry_disk_utilization_ratio`. Any verification failure is an incident:
stop replacement (`COMPACTION_MODE=shadow`) and investigate.

## Physical space

Deleting rows makes space reusable inside PostgreSQL's files; it does not
shrink them. After replacement, autovacuum marks the space free and new rows
reuse it, so the files stop growing rather than shrinking. Do not run
`VACUUM FULL` or other table rewrites on a nearly full host: they need a
complete second copy of the table. While shadow chunks and their sources
coexist, storage temporarily grows by the chunks' size; plan that headroom
before a backfill and keep the disk below the throttle watermark.

## Storage sample (not representative)

Measured locally on an export of 3,357 steps in 376 attempts (8.9 steps per
attempt; commands 21.2 UTF-8 bytes on average; almost entirely visual-mode),
encoding one chunk per attempt in this format:

| Content | Compressed bytes per step |
| --- | --- |
| everything except event ids | 44.5 |
| everything, with event ids (as stored) | 63.6 |
| plus trusted ingestion times (new rows have them) | 68.8 |

The per-chunk header (format, attempt, column list, base) costs about 11 bytes
per step at 9 steps per chunk and less for longer attempts. Add, per step, the
16-byte receipt in `receipt_event_ids` and its GIN index entry, and per chunk
the table row; the attempt summaries, feedback, WAL and backups are separate.
These figures are a promising sample, not a capacity claim: measure the whole
retained footprint with `tools/storage-report.js` on representative data
(`docs/capacity.md`, `docs/benchmark.md`).

## Retention (policy-gated)

`node src/jobs/retention.js` (Compose service `retention`, profile `tools`,
role `telemetry_retention`). Every window is unset by default and the job is
a dry run unless given `--execute` **and** `RETENTION_POLICY_ID`, the
identifier of the recorded decision (template in `docs/operations.md`).

| Setting | Removes | Notes |
| --- | --- | --- |
| `RETENTION_DETAIL_DAYS` | live steps and chunks of attempts idle this long | the attempt summary stays with `detail_expired_at`; the collector then rejects late steps for it (`late_event`) |
| `RETENTION_ATTEMPT_DAYS` | attempt rows (summaries and scripts) idle this long, with any detail; then pseudonymous users left without attempts or feedback | must be ≥ the detail window |
| `RETENTION_FEEDBACK_DAYS` | feedback reports by `received_at` | decide explicitly; feedback can contain free text |
| `RETENTION_RECEIPT_DAYS` | duplicate-detection receipts of chunks whose sources were removed this long ago | ≥ 7 days (the clients' maximum queue age); after expiry a reused event id is only caught by its (attempt, sequence) |

Times are trusted ingestion times; historic rows use migration 005's
`applied_at` as their upper bound. Batches (`RETENTION_BATCH_SIZE`, 200) run
in short transactions with `RETENTION_SLEEP_MS` pauses and lock rows with
`SKIP LOCKED`, so intake is never blocked for long.

Expiring detail or attempts removes the **last copy** unless a verified
archive holds it. Either set `RETENTION_ARCHIVE_DIR` to a verified archive —
each attempt is then removed only if the archive has its context and every
published chunk with matching checksums (payload files are re-hashed) and it
has no live rows — or set `RETENTION_EXPIRE_LAST_COPY=true`, which records
that the policy accepts losing the only copy. The job refuses to start with
neither.

If compression, off-server archives and an acceptable window still cannot
meet the disk budget, whole-attempt sampling is the next policy option (plan
phase 5 item 8). It is not implemented: it biases analysis, can be gamed by
anonymous clients, and must record sampling probabilities and versions so a
sampled-out attempt is distinguishable from dropout.

## Archive

`node src/jobs/archive.js --dir DIR [--since ISO] [--until ISO] [--limit N]`
(role `telemetry_reader`) writes attempts whose detail is entirely in
published chunks: the attempt context (`attempt.json`, including scripts and
the pseudonymous user's first/last seen), each chunk's manifest and
byte-identical payload, `manifest.jsonl`, and a copy of this format's
specification and Python decoder, so an archive is self-contained.
`--verify --dir DIR` re-hashes and decodes everything and writes
`verified.json` per fully verified attempt. Upload with your own tool (for
example `rclone copy`), then run `--verify` on the uploaded or re-downloaded
copy before pointing retention at it. Archives contain proof scripts and may
contain free text: keep them private, encrypted in transit and at rest, with
narrowly scoped credentials. Compression is not anonymisation. The archive
job never deletes database rows.

## Partitioning (later)

At tens of millions of retained rows, consider partitioning by a trusted,
immutable retention key with whole-attempt boundaries. PostgreSQL's unique
keys on a partitioned table must include the partition key, so the global
`event_id` and per-attempt `(attempt_id, sequence)` uniqueness the writer
relies on would need a separate mechanism (for example routing by attempt);
do not add daily partitions naively. Re-measure first: compaction keeps live
rows to the recent window.

## Disk budget

```
recent-row footprint + retained compacted paths + summaries, receipts and indexes
  + WAL + OS, images and logs + backup staging + peak compaction/backfill headroom
```

Include the backlog that accumulates while the worker is paused and a bounded
catch-up time. `tools/storage-report.js` measures each table/index/TOAST part,
WAL rate and free space and forecasts the days left to each watermark
(`docs/capacity.md`).
