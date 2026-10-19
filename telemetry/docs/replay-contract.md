# Replay and identity contract

This document defines what the telemetry store must preserve so that every
accepted attempt can be replayed losslessly, how event identity and duplicates
work, and what any other representation of the data (compressed trajectory
chunks, archives, exports) is obliged to keep. It is the reference for the
writer (`src/writer.js`), the compactor and readers (`src/trajectory/`), the
exports (`tools/export.js`, `extract-replays.py`) and any future schema change.
The wire format is in [protocol.md](protocol.md); the chunk encoding in
[trajectory-format.md](trajectory-format.md).

The rule behind every section: **preserve existing data by default.** No
representation change may remove final scripts, coalesce actions, drop
identities or reduce timestamp precision unless it is proven that the replay
and analysis semantics below remain intact, and no such change is made by this
remediation.

## 1. Units

- An **attempt** is one play-through of one level by one pseudonymous user,
  identified by `attempt_uuid` (`proof_attempts.attempt_id`).
- An **action** is one accepted `proof_step` event: the unit of replay.
- An attempt additionally has at most one recorded **start**
  (`level_start`) and at most one recorded **completion**
  (`level_complete`). Both are events with their own identity and sequence,
  stored on the attempt row.

## 2. What a lossless replay needs

### 2.1 Attempt context

Fixed when the attempt row is created and never changed afterwards:
`user_id`, `game_id`, `world_id`, `level_id`, `mode` (`visual` or `classic`),
`attributes.build`, the game build of the creating event (absent before
October 2026 and for development builds), and `attributes.platform`, the
browser family and device type that event reported (absent before October
2026). The creating event is the batch's
`level_start` for the attempt if present, else its lowest-sequence event. An
event whose context differs from the stored row is rejected
(`context_mismatch`); context is never "corrected" by a later event.

### 2.2 Initial state

- `initial_script`: the proof text the attempt started from, exactly as sent.
  Classic attempts send `''` for an empty start or the proof handed over from
  the visual editor. Visual attempts that start from the level's empty proof
  send none (NULL). A visual attempt that starts from a non-empty proof (a
  solved or unfinished proof restored on reopening the level, or the proof of
  a just-completed attempt that the player then undid or reset) sends its
  starting commands as a JSON array of strings, one per `command` action, in
  order; replay starts from that stack. `''` and NULL are different values and
  both are kept.
- `source_attempt_id`: the visual attempt a classic attempt was handed over
  from, or the completed visual attempt a visual attempt continues; NULL
  otherwise. A visual attempt ends at its completion: undoing or resetting
  after it starts a new attempt, so each attempt has at most one completion.
- `start_event_id`, `start_sequence`, `start_client_ts`, `start_elapsed_ms`:
  the start event itself. NULL when no start was ever accepted (legacy rows,
  or the start was lost or refused).

Both script fields are filled only while NULL, by the first accepted start; a
later start with a different initial state is refused (`start_conflict`).

### 2.3 Actions, order and gaps

Each action holds:

| Field | Meaning |
| --- | --- |
| `event_id` | the client's stable id (identity, section 3) |
| `sequence` | position within the attempt; replay order |
| `step_type` | `command` appends one step; `undo` removes the last step; `reset` returns to the opening position in one action (logged as `undo` by clients before October 2026); `edit` is a classic line edit; `rejected` (a visual gesture refused by the canvas or by Lean) and `view` (a visual switch into or out of Transformation or Construction Mode) leave the proof unchanged |
| `command` | for `command`: the step's text; for `edit`: the inserted text (possibly several lines, possibly empty); for `undo`/`reset`: the label the client sent; for `rejected`: the refused gesture in play-tactic notation; for `view`: the switch (`transform goal`, `transform h`, `side left`, `direction reverse`, `construct goal`, `close`, ...) |
| `from_line`, `removed_lines` | `edit` only: replace `removed_lines` lines starting at zero-based line `from_line` with `command`; NULL for other types |
| `client_ts` | client wall-clock time, microseconds (untrusted, informational) |
| `elapsed_ms` | client milliseconds since the attempt began |
| `received_at` | trusted server time of ingestion (NULL for rows ingested before migration 005) |
| `attributes` | supported extension attributes of the action, preserved verbatim: `{}` except for `rejected`, which may hold `reason` (why it was refused, e.g. `lean-error`, `busy`, `statement-does-not-fit-goal`) and `error` (Lean's message). Not part of the action's identity (section 3) |

Replay applies actions in ascending `sequence`. Transport order is irrelevant:
events may arrive out of order, in any batch, and late. Sequences need not be
contiguous: clients number every action, including ones they never sent
(telemetry consent given mid-level, a queue eviction), so a gap means "an
action may be missing here", never "nothing happened". The start's sequence is
the client counter when the attempt began (normally 0); steps follow; the
first completion takes the next number. Steps after the completion
sequence are legitimate (a player may keep editing).

`(attempt, sequence)` identifies one action slot. A sequence held by a step,
the recorded start, the recorded completion or a recorded later completion
cannot be taken by another event (`sequence_conflict`; a second start is a
`start_conflict` and a second completion `already_completed`).

### 2.4 Exact content

Commands, edits and scripts are stored and returned byte-exact (UTF-8 of
well-formed text without NUL), with no trimming, normalisation or truncation.
Values the collector cannot store exactly are refused at validation
(`invalid_text`, `script_too_large`), never altered. Timestamps are kept at
PostgreSQL's microsecond resolution and move between the database and code
only as integer microseconds (`codec.sqlMicros` / `codec.sqlFromMicros`),
never through JavaScript `Date`. Legacy rows hold millisecond client times
(the old collector parsed them with `Date`).

### 2.5 Final scripts and completion

The first accepted `level_complete` sets `completed = true`, `completed_at`
(its client time), `duration_ms` (its `elapsed_ms`), `play_script`,
`lean_script`, `completion_event_id`, `completion_sequence` and the trusted
`completion_received_at`. Completion is **immutable**: no later event changes
these fields. A different later completion is refused (`already_completed`)
and only its sequence is appended to `later_completion_sequences` (at most 64
entries, sequences not already held), so readers can tell that slot from a
lost step. There is no correction protocol; introducing one requires a new
protocol version.

Completion is client-reported. It records what the client claimed; it is not a
verified proof of the theorem.

### 2.6 Completeness

Completeness is computed by readers from stored sequences, never inferred from
arrival order: a completion may arrive before the steps it follows. Readers
report, per attempt:

- whether a start is recorded, and its sequence;
- whether a completion is recorded, its sequence, and any later completion
  sequences;
- the missing sequences between the start (or the first known action) and the
  last known action or completion, excluding slots held by the start, the
  completion and later completions;
- any slot held by more than one representation with different content
  (live row vs chunk, or two chunks): a conflict, reported and never hidden;
- unreadable chunks (corrupt, unsupported format, over limits).

A path is complete when a start and a completion are recorded and no sequence
between them is missing. **Legacy rows** (before migration 006) have no start
or completion sequence: their completeness is `unknown` unless a retried
start/completion recorded those identities later (section 4.4). The old
collector also stored the first event of an attempt with whatever its type
was, so a legacy attempt may lack its start entirely.

### 2.7 Game, build and platform context

Game, world, level, mode, build and platform are attempt-level (2.1). They are never
repeated per action, and a replay that loses them is not self-contained: any
archive of actions must carry the attempt context with it.

### 2.8 Times

`client_ts`, `started_at`, `completed_at` and `elapsed_ms` are client values:
useful for replay pacing and analysis, untrusted for operations. Trusted
times, set by PostgreSQL: `proof_steps.received_at`,
`proof_attempts.received_at` (row creation), `last_received_at` (last accepted
event, coarsened to `LAST_RECEIVED_RESOLUTION_MS`, default 60 s) and
`completion_received_at`. Rows created before migration 005 have NULL trusted
times; their ingestion time is bounded above by migration 005's `applied_at`
in `schema_migrations`. A client time is never used in place of a missing
trusted time. `started_at` is the earliest client time of the start or the
creating event (`LEAST` when a start arrives late). `anonymous_users.first_seen`
and `last_seen` are client times; `last_seen` moves forward only, and only by
more than `LAST_SEEN_RESOLUTION_MS`.

## 3. Identity and duplicates (normative)

These rules are implemented by `src/writer.js` and tested in
`test/integration/writer*.test.js`.

1. An event's identity is its `event_id`. The same id with the same canonical
   client content is a **duplicate**: it is reported as stored and changes
   nothing (no row version, no `last_seen`/`last_received_at` move). The same
   id with different content, a different event type or a different attempt
   is an **`id_conflict`**.
2. Canonical client content: event type, attempt, user, game, world, level,
   mode, sequence, client time (microseconds), `elapsed_ms`, and the type's
   fields (step: `step_type`, `command`, `from_line`, `removed_lines`; start:
   `initial_script`, `source_attempt_uuid`; completion: `play_script`,
   `lean_script`). Build attributes and server times are not part of identity.
3. `(attempt, sequence)` identifies one action (2.3). Another event in a
   taken slot is a `sequence_conflict`, never silently accepted.
4. Starts: the first accepted start of an attempt is recorded; the same start
   again is a duplicate; another start id is a `start_conflict`. A start for
   an attempt created by its steps (the start arrived late) is accepted and
   reconciles the initial state without touching the context.
5. Completions: immutable after the first (2.5).
6. Within one batch, the first copy of an id is decided against the database
   and later copies follow it: identical copies of an accepted or duplicate
   event are duplicates, identical copies of a rejected event get the same
   rejection, and different content is an `id_conflict`.
7. Outcomes are decided under the attempt row lock (`SELECT ... FOR UPDATE`,
   attempts locked in sorted order), the same lock the compactor takes to
   publish or replace chunks, so a decision never races a representation
   change of the same attempt.
8. A failed transaction acknowledges nothing; every event in it stays
   retryable. Database and network errors are retryable; an invalid client
   field is a terminal per-event rejection and never fails the batch.
9. Feedback: `report_id` is the identity; same id and same content (user,
   context, message, `proof_state` as JSON, client time) is a duplicate (204),
   otherwise a conflict (409).

Concurrency limit: identity lookups see committed data. Two transactions that
concurrently store the *same* id under *different* event types can both
succeed (each sees nothing). This needs a client to reuse an id across event
types at the same moment, which correct clients never do, and is documented
rather than prevented.

## 4. Deduplication lifetime

### 4.1 Live rows

While a step's live row exists, its id (primary key) and `(attempt,
sequence)` (unique) are checked directly. Start and completion identities live
on the attempt row as long as the attempt exists.

### 4.2 After compaction

Compaction replaces live step rows by published chunks
(`trajectory_chunks`, `state = 'published'`) and records the highest covered
sequence in `proof_attempts.compacted_through`. The writer then:

- finds an id in published chunks through `receipt_event_ids` (GIN index), and
  answers `id_conflict` at once if the chunk belongs to another attempt;
- for its own attempts, decodes at most the chunks that hold one of the
  batch's ids or cover one of its sequences at or below `compacted_through`,
  within the codec's limits, and decides exactly as for a live row;
- never inserts a step whose slot or id is held by a chunk. A late step for a
  sequence that falls in a chunk's range but is absent from it (a gap) is new:
  it is stored live and later becomes a delta chunk.

Shadow chunks are not authoritative and are ignored; their source rows are
still live. If a chunk needed for a decision cannot be decoded (corruption,
unsupported format, limits), the batch fails with 500 rather than guess; the
client retries after the operator restores the chunk.

### 4.3 After receipt expiry

`RETENTION_RECEIPT_DAYS` may clear `receipt_event_ids` of chunks whose sources
were removed (explicit policy only). `(attempt, sequence)` coverage still
prevents resurrection and still detects changed content for the same slot.
What is lost: an expired id reused under a *different* attempt is no longer
recognised and would be stored as a new action of that attempt.

### 4.4 Legacy rows

Rows written before migration 006 have no start or completion identity. A
retried start whose initial state matches (or fills a NULL) is accepted and
recorded. A retried completion with identical content (client time, duration,
scripts) is a duplicate and its id and sequence become the completion's
identity; any other completion is `already_completed`. Legacy steps have ids
and are matched like any live row (their client times are millisecond values,
so retries from old clients match exactly).

### 4.5 Expiry and late events

Deduplication lasts as long as the data it protects: receipts and coverage for
compacted steps, rows for live data. When an attempt itself is removed by an
explicit retention policy, nothing remains to compare with, and a retry would
create a new partial attempt. Therefore:

- every retention window must exceed the client's maximum retry age (the age
  bound of the client queue) plus a margin;
- `LATE_EVENT_MAX_AGE_DAYS` (off by default) refuses new events (`late_event`)
  for attempts idle longer than that, so a late retry cannot extend an attempt
  that operations already consider closed; duplicates of stored events are
  still answered `duplicate`. Set it to at least the client's maximum retry
  age and below the shortest detail-retention window before enabling such a
  window.
- When retention removes an attempt's step detail but keeps its summary
  (`RETENTION_DETAIL_DAYS`), it sets `proof_attempts.detail_expired_at`
  (migration 010). The writer then refuses every further step of that attempt
  (`late_event`): a retry of an expired step can never come back as new data,
  whatever `LATE_EVENT_MAX_AGE_DAYS` says. Readers report the detail as
  expired (`completeness.detailExpired`), not as missing sequences.

## 5. Obligations of compressed and archived storage

Any representation other than live rows (trajectory chunks, archives, exports
meant to be restorable) must:

1. Preserve every action field of 2.3 exactly, including `event_id`,
   microsecond `client_ts`, `received_at` (NULL stays NULL), and arbitrary
   supported `attributes`. Never split an action, never coalesce actions,
   never drop "redundant" ones (an undo after a command is data).
2. Carry a manifest: format and codec versions, attempt id, action count,
   first/last sequence, uncompressed length and checksum; readers verify all of
   it and the declared sizes before trusting a payload.
3. Keep attempt-level fields (2.1, 2.2, 2.5) relational on the attempt row, or
   with the archive when exported off-server: a chunk without its attempt
   context is not a self-contained recovery.
4. Keep the deduplication information of section 4 for at least the
   deduplication horizon: receipts, sequence coverage and
   `compacted_through`.
5. Change representation only under the attempt lock (3.7), publish only after
   decoding and comparing every source field, and remove only the exact
   verified source rows. A concurrent late action must remain present.
6. Let readers merge live rows and chunks by sequence, return each accepted
   action exactly once, and report gaps, conflicts and unreadable chunks
   (2.6).

## 6. Decision record: smaller live-row schema (plan Phase 4, item 9)

Status: **evaluated, deferred until measured.** Date: October 2026.

### 6.1 Options evaluated

| Option | Expected effect | Costs and risks |
| --- | --- | --- |
| Internal integer attempt key: `proof_attempts.attempt_key bigint` identity, `proof_steps.attempt_key` instead of the UUID `attempt_id` | about 8 bytes less per step row and per entry of the `(attempt, sequence)` unique index and FK lookups; the public UUID stays once on the attempt | new column on every step row, batched backfill, new unique index built concurrently, constraint swap, then dropping the UUID column (space only reclaimed by a rewrite or by rows aging out); every reader, export, compactor and backup query changes; the writer needs the key before inserting steps (it already locks the attempt row, so no extra statement) |
| Drop the always-empty `proof_steps.attributes` | the `'{}'` jsonb value costs a few bytes per row plus alignment | the column is the documented extension point and the codec preserves attributes; dropping it is a storage-contract change; `DROP COLUMN` frees nothing until rows are rewritten |
| Normalise repeated build records into a `builds` table referenced by integer | the build JSON (about 200-250 bytes) is stored once per attempt today, never per step; savings scale with attempts, not actions | an extra lookup or upsert per new attempt, migration of `attributes->'build'` readers (README queries, exports) |
| `(attempt, sequence)` as the action identity, dropping the per-step event UUID and its primary-key index | the largest per-row saving: 16 bytes of UUID plus a whole btree index (roughly 30-40 bytes per row) | requires a new protocol version: old clients send UUIDs and rely on them for retries; cross-attempt id reuse detection, chunk receipts and machine exports all use event ids; must not be done by dropping the existing UUID or its uniqueness check |

### 6.2 Why deferred

- No measurement exists yet. The plan requires migration and index costs and
  real savings in the decision; `tools/storage-report.js` (BENCH) measures
  per-table heap/index/TOAST bytes, bytes per action and per attempt, WAL and
  the compressed footprint. The numbers in the plan (500 bytes per stored step)
  are a planning assumption, not a measurement.
- Compaction (Phase 5) removes most step rows after the recent-row window.
  Live-row savings then apply only to that window, while the migrations above
  touch every existing row. The trade-off depends on the window chosen and on
  measured compaction throughput.
- Each option changes contracts that old clients, exports and the rollback
  image depend on. The plan's rollout rule (server first, v1 kept while old
  clients exist, rollback without data loss) makes these multi-release
  changes, not part of the hardening release.

Revisit when `tools/storage-report.js` on a representative staging dataset
shows that live step rows and their indexes (not chunks, attempt rows, WAL or
backups) dominate the retained footprint at the chosen recent-row window, and
a forecast shows the disk budget would otherwise be exceeded. The first
candidate is then the internal attempt key; the event-UUID change last.

### 6.3 Compatibility tests any such change needs

1. Old clients: v1 and v2 retries of events stored before the migration answer
   `duplicate`; conflicting retries keep their conflict reasons; old payload
   limits keep working.
2. Mixed rows: attempts with steps on both sides of the migration replay
   identically through `src/trajectory/reader.js` and the exports.
3. Chunks published before the change still decode and still deduplicate
   (receipts and coverage), and new chunks preserve `attributes` if the column
   is dropped from live rows.
4. The migration is online: batched backfill with bounded transactions,
   indexes built `CONCURRENTLY`, the writer keeps accepting during it, and the
   migration runner's ledger and lock handle interruption and resumption.
5. Rollback: the previous release image runs against the migrated schema (or
   the change ships with a tested compatibility layer); no rollback step
   deletes or rewrites migrated data.
6. Least privilege: `tools/verify-permissions.js` passes with the new columns
   (the writer may need new column grants; nothing more).
7. Statement count per batch stays fixed (`test/integration/writer.test.js`),
   and identity semantics (section 3) are unchanged, including after
   compaction.
8. Exports keep their field meanings (`docs/exports.md`).
