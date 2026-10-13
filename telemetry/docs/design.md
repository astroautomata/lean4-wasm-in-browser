# Telemetry collector design

This is the engineering contract for the telemetry remediation (phases 1-8 of
the remediation plan). Every module implements the interfaces and semantics
below. Where this document and code disagree, fix one of them deliberately;
do not let them drift.

Architecture:

```
Browser (Lean runs locally) -> Caddy (TLS, the only public ingress, sets the
client IP header) -> collector (validation, bounded admission, bulk writer)
-> PostgreSQL (recent step rows, attempt summaries, published trajectory
chunks) <- compactor (separate low-priority process) ; exports / replay
extraction / retention / archive / backups run as separate jobs with their own
roles. Metrics are served on a private port.
```

## 1. Module layout

| Path | Purpose |
| --- | --- |
| `src/env.js` | env parsing helpers, `*_FILE` secrets, per-role connection options |
| `src/migrate.js` | migration runner (ledger, checksums, lock), schema compatibility, role provisioning; CLI |
| `src/metrics.js` | Prometheus registry with bounded label sets |
| `src/disk.js` | disk watermark monitor (`statfs`) |
| `src/trajectory/codec.js` | `lean-trajectory/1` codec (see `docs/trajectory-format.md`) |
| `src/config.js` | collector configuration (section 3) |
| `src/server.js` | collector entry point: config, pool, schema check, listen, drain |
| `src/app.js` | `createApp(deps)` → `{ handle(request, response), metricsHandler, ... }`; no I/O at import |
| `src/http/body.js` | bounded body reader |
| `src/http/errors.js` | `HttpError`, PostgreSQL error classification |
| `src/http/respond.js` | guarded response writing, CORS |
| `src/http/client-identity.js` | trusted-proxy client IP, IPv4/IPv6 normalisation |
| `src/rate-limit.js` | bounded, expiring token buckets and global budgets |
| `src/admission.js` | in-flight gates and bounded writer queue |
| `src/validation.js` | strict validation, per-event outcomes |
| `src/database.js` | pool with deadlines and error handling, transactions, feedback storage |
| `src/writer.js` | bulk event writer with identity/duplicate/conflict semantics |
| `src/microbatch.js` | optional cross-request microbatching (off by default) |
| `src/health.js` | liveness, cached readiness |
| `src/trajectory/reader.js` | shared reader: live rows + published chunks (+ archive) |
| `src/trajectory/compactor.js`, `src/jobs/compactor.js` | compaction worker |
| `src/jobs/retention.js`, `src/jobs/archive.js` | policy-gated retention, archive export/verify |
| `tools/verify-chunks.js`, `tools/trajectory_codec.py` | chunk verification; reference Python decoder (shipped in archives) |
| `tools/export.js`, `tools/xlsx.js`, `tools/pg-text.js` | streaming machine export, typed-text human export, PostgreSQL text conventions |
| `tools/storage-report.js` | storage/WAL measurement and forecast |
| `tools/verify-permissions.js` | effective-privilege check against an existing database |
| `bench/` | load generator and verification (run from a separate machine) |
| `ops/` | Caddyfile example, backup/restore scripts |

## 2. Hard rules

- Nothing here deploys. Never point tests, tools or benchmarks at the production
  database, collector or Caddy. Integration tests use `TEST_DATABASE_URL` on a
  disposable cluster (see `test/helpers/database.js`).
- Do not delete, sample or rewrite stored data except through the explicit,
  policy-gated jobs in section 10, whose destructive modes are off by default.
- Never log or export to metrics: proof scripts, commands, feedback text, user
  or attempt UUIDs, IP addresses, credentials. Metric labels come from fixed
  vocabularies.
- Acknowledge (`204`, or `accepted`/`duplicate` in v2) only after the
  PostgreSQL transaction holding the event committed. Every failure before or
  during commit leaves the event unacknowledged and retryable.
- Keep fsync and synchronous commit enabled.
- No new runtime dependencies without a clear need; `pg` is the only one.

## 3. Collector configuration

All optional unless stated. Defaults are the provisional staging values from
the plan; they are guardrails, not capacity claims.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `METRICS_PORT` | 8080 / 9464 | public HTTP / private metrics (0 disables) |
| `DATABASE_URL(_FILE)` or `PGHOST`,`PGPORT`,`PGDATABASE`,`PGUSER`,`PGPASSWORD(_FILE)` | required | runtime writer credentials (`env.connection(env)`) |
| `ALLOWED_ORIGINS` | `https://leangame.autumnofautumn.com` | exact origins, comma separated |
| `TRUSTED_PROXY_CIDRS` | empty | peers whose `CLIENT_IP_HEADER` is believed (IPv4/IPv6 CIDRs) |
| `CLIENT_IP_HEADER` | `x-telemetry-client-ip` | single IP, overwritten by Caddy |
| `MAX_BODY_BYTES` | 524288 | request body limit (bytes) |
| `MAX_EVENTS_PER_BATCH` | 50 | |
| `BODY_TIMEOUT_MS` | 10000 | whole body must arrive within this |
| `REQUEST_TIMEOUT_MS` | 15000 | overall server handling deadline |
| `HEADERS_TIMEOUT_MS` / `KEEP_ALIVE_TIMEOUT_MS` | 65000 / 60000 | Node server timeouts (keep-alive above Caddy's upstream idle timeout of 30 s configured in `ops/Caddyfile.example`) |
| `PG_POOL_SIZE` | 4 | |
| `EVENT_WRITERS` / `FEEDBACK_WRITERS` | 3 / 1 | concurrent DB writers; sum ≤ pool size |
| `POOL_ACQUIRE_TIMEOUT_MS` | 500 | |
| `STATEMENT_TIMEOUT_MS` / `LOCK_TIMEOUT_MS` / `IDLE_IN_TX_TIMEOUT_MS` | 3000 / 500 / 5000 | sent as PostgreSQL session settings |
| `QUERY_TIMEOUT_MS` | statement + 2000 | client-side backstop; the connection is destroyed when it fires |
| `MAX_INFLIGHT_SUBMISSIONS` | 64 | event submissions uploading or processing |
| `FEEDBACK_INFLIGHT` | 8 | separate feedback allowance |
| `QUEUE_MAX_REQUESTS` / `QUEUE_MAX_EVENTS` / `QUEUE_MAX_BYTES` / `QUEUE_MAX_AGE_MS` | 64 / 1000 / 16777216 / 500 | waiting-for-writer bounds; all enforced |
| `ACCOUNTING_FACTOR` | 3 | accounted bytes = body bytes × factor (Buffer + parsed objects) |
| `RATE_BURST_SECONDS` | 10 | bucket capacity = burst seconds × refill rate (min 1 token) |
| `RATE_IP_REQUESTS_PER_MINUTE` / `RATE_IP_EVENTS_PER_MINUTE` | 1200 / 12000 | generous: classrooms share NAT |
| `RATE_USER_REQUESTS_PER_MINUTE` / `RATE_USER_EVENTS_PER_MINUTE` | 120 / 1500 | per `user_uuid` |
| `RATE_FEEDBACK_IP_PER_MINUTE` / `RATE_FEEDBACK_USER_PER_MINUTE` | 20 / 10 | |
| `GLOBAL_REQUESTS_PER_SECOND` / `GLOBAL_EVENTS_PER_SECOND` / `GLOBAL_BYTES_PER_SECOND` / `GLOBAL_FEEDBACK_PER_SECOND` | 500 / 2500 / 16777216 / 5 | to be sized from the benchmark |
| `RATE_LIMIT_MAX_KEYS` / `RATE_LIMIT_IDLE_MS` | 100000 / 600000 | per limiter map; LRU eviction past the cap |
| `REQUESTS_PER_MINUTE` | — | deprecated; startup warning, ignored |
| `MICROBATCH_WINDOW_MS` / `MICROBATCH_MAX_EVENTS` / `MICROBATCH_MAX_BYTES` | 0 (off) / 200 / 2097152 | |
| `LAST_SEEN_RESOLUTION_MS` | 0 | `anonymous_users.last_seen` only moves forward by more than this |
| `LAST_RECEIVED_RESOLUTION_MS` | 60000 | `proof_attempts.last_received_at` coarsening |
| `LATE_EVENT_MAX_AGE_DAYS` | unset (accept) | reject events for attempts idle longer than this (`late_event`) |
| `DISK_PROBE_PATH` | unset (off) | see `src/disk.js`; ratios `DISK_ALERT_RATIO` 0.70, `DISK_THROTTLE_RATIO` 0.80, `DISK_PAUSE_RATIO` 0.85 |
| `READINESS_INTERVAL_MS` / `READINESS_MAX_AGE_MS` | 5000 / 15000 | cached DB check |
| `DRAIN_TIMEOUT_MS` | 20000 | below the container stop grace period (30 s) |

`src/config.js` exports `loadConfig(env = process.env)`; it throws
`ConfigError` with the variable name on invalid input and validates cross-field
constraints (writers ≤ pool, body timeout < request timeout, ...).

## 4. HTTP protocol

Full client-facing contract: `docs/protocol.md`. Summary:

| Route | Purpose |
| --- | --- |
| `POST /v1/events` | legacy batch; `204` when committed |
| `POST /v2/events` | batch with per-event results |
| `POST /v1/feedback` | feedback report; `204`, `409` on report-id conflict |
| `OPTIONS` on the three above | CORS preflight: `204` allowed origin, `403` otherwise |
| `GET /healthz`, `GET /livez` | liveness: `200 {"status":"ok"}` while the event loop runs |
| `GET /readyz` | readiness JSON; `503` when unready |
| metrics port `GET /metrics` | Prometheus text |
| metrics port `GET /internal/pressure` | `{"pressure":0..1,"draining":bool,"disk":"ok"...}` for the compactor |

Everything else: `404`. Responses to allowed origins always carry CORS headers
including `Access-Control-Expose-Headers: Retry-After`. Error bodies are
`{"error":"<code>"}` with a code from the bounded vocabulary; they never echo
input.

Status classification:

| Status | When | Client action |
| --- | --- | --- |
| 400 | malformed URL/JSON/UTF-8, invalid envelope, no valid event (v1), invalid feedback, PostgreSQL data exception (22xxx) | drop (terminal) |
| 403 | origin not allowed | (browser sees network error) |
| 404 | unknown route; v2 on an old collector | v2 client falls back to v1 |
| 408 | body not received within `BODY_TIMEOUT_MS` | retry with backoff |
| 409 | feedback report id reused with different content | drop |
| 413 | `Content-Length` or streamed bytes over `MAX_BODY_BYTES` | split/drop per client policy |
| 429 | rate limit (per IP, per user, global); `Retry-After` seconds until a token | retry after |
| 503 | draining, disk pause, in-flight/queue full, queue age, pool/DB unavailable, deadline; `Retry-After` | retry after |
| 500 | unexpected internal error | retry with backoff |

Request processing order (each step may end the request):

1. Parse the URL inside the handler's single async boundary; route.
2. Draining → 503. Origin → 403. Client identity (section 6).
3. Disk level `pause` → 503 (`Retry-After: 300`).
4. Per-IP and global request budgets → 429.
5. `Content-Length` > limit → 413 without reading. In-flight gate full → 503.
6. Read the body: count `Buffer` bytes, 413 as soon as the count passes the
   limit (chunked bodies too), 408 on `BODY_TIMEOUT_MS`, abort/close → request
   failure (counted as `aborted`, no response possible). Decode once with
   `new TextDecoder('utf-8', { fatal: true })` → 400 `invalid_utf8`; `JSON.parse`
   → 400 `invalid_json`.
7. Validate envelope and each event (section 5).
8. Per-user and global event/byte budgets → 429 (whole request).
9. Writer queue admission (count, events, accounted bytes, age) → 503.
10. Write; respond only after commit. Overall deadline `REQUEST_TIMEOUT_MS` →
    503; late DB completion is harmless because retries are idempotent.

Responses are written through one guard that does nothing once the response
or socket is finished/destroyed; resources (in-flight slot, queue reservation,
pool client, timers, listeners) are released exactly once on every path.
`server.on('clientError')` answers `400` on a still-writable socket. There is no
process-wide catch-all for programming errors: an unexpected exception outside
a request is a crash, by design.

### v2 events

Request: `{"events":[...1-50 events...], "client": {"health": {...}}}`.
`client` is optional; `health` holds non-negative integers (each ≤ 10^9) for
`queue_events`, `queue_bytes`, `evicted`, `expired`, `oversize`, `rejected`,
`retries`, `sent`; unknown keys ignored; invalid → ignored (never a 400). The
collector adds them to `telemetry_client_health_total{counter}` only after the
request commits, and never stores them per user.

Response `200`:

```json
{"protocol":2,"results":[
  {"index":0,"event_id":"…","status":"accepted"},
  {"index":1,"event_id":"…","status":"duplicate"},
  {"index":2,"event_id":null,"status":"rejected","reason":"invalid_uuid"}]}
```

One result per input event, in order. `event_id` is the normalised id, or null
when invalid. `accepted` and `duplicate` mean durably stored; `rejected` is
terminal. A whole-request failure (408/429/5xx) means nothing in the request
was acknowledged.

### v1 events (compatibility)

Same envelope. Each event is validated individually; valid events are written,
invalid ones are counted under their reason and discarded. `204` once the
valid events committed; `400` if the envelope is invalid or no event is valid.
Duplicates and conflicts answer `204` (old clients cannot act on them) and are
counted.

## 5. Validation (`src/validation.js`)

`validateEvent(value) → { ok: true, event } | { ok: false, reason, eventId }`.
`validateEnvelope(body, { maxEvents })`, `validateFeedback(value)`,
`validatePlatform(value)` (equally lenient; only the fixed `browser` and
`device` values of docs/protocol.md 4.4 are kept), `validateBuild(value)`
(lenient as today: malformed entries are dropped, never
reject the event), `validateClientHealth(value)`.

Event fields (wire name → normalised field):

- `event_id`, `user_uuid`, `attempt_uuid`: `typeof === 'string'` and RFC 4122
  shape (version 1-5, variant 8-b), case-insensitive, normalised to lowercase.
  Non-strings are rejected (`RegExp.test` must never see a coerced array).
- `event_type` ∈ {`level_start`, `proof_step`, `level_complete`}; `mode` ∈ {`visual`, `classic`}.
- `game_id` (slashes allowed) and `world_id`: segments `[A-Za-z0-9._-]{1,80}`, not `.`/`..`, total ≤ 160.
- `level_id` integer 0..100000; `sequence` integer 0..1000000; `elapsed_ms` integer 0..2147483647.
- `ts`: string ≤ 40 chars matching `YYYY-MM-DDTHH:MM:SS[.f{1,6}](Z|±HH:MM)`, a real
  calendar time in [2000-01-01, 2100-01-01). Normalised to `clientTsUs`, exact
  integer microseconds (fraction parsed digit by digit, not via `Date`).
  Client timestamps are untrusted and informational; trusted time is
  `received_at`, set by PostgreSQL.
- Per type (fields irrelevant to the type are cleared to null, never stored):
  - `level_start`: `initial_script` (string or null), `source_attempt_uuid` (UUID string or null).
  - `proof_step`: `step_type` ∈ {`command`,`undo`,`reset`,`edit`}; `command`
    string (may be empty); for `edit`, `from_line` and `removed_lines` integers
    0..1000000; otherwise both cleared.
  - `level_complete`: `play_script`, `lean_script` (string or null).
- Text: must be a string when present (`invalid_type` otherwise); no U+0000
  (`invalid_text`); well-formed UTF-16, no lone surrogates (`invalid_text`);
  length ceilings unchanged from today, in UTF-16 code units: scripts 262144,
  command 65536. Over the ceiling → `script_too_large` (rejected, never truncated).
- `build`: `validateBuild` as before; `platform`: `validatePlatform`. Both are
  stored in the creating event's attempt `attributes` and are not identity.

Reason codes (closed set, used in v2 results and metrics): `invalid_event`,
`invalid_uuid`, `invalid_type`, `invalid_context`, `invalid_sequence`,
`invalid_timestamp`, `invalid_text`, `invalid_step`, `script_too_large`,
`context_mismatch`, `id_conflict`, `sequence_conflict`, `start_conflict`,
`already_completed`, `late_event`.

Feedback: `report_id` UUID string; optional `user_uuid`; `mode`, `game_id`,
`world_id`, `level_id`, `ts` as above; `message` string, trimmed, 1..1000 code
units, no NUL, well-formed; `proof_state` plain object, depth ≤ 64, ≤ 50000
nodes (objects, arrays and scalars), every string and key without NUL and
well-formed, serialised UTF-8 size ≤ 262144 bytes; optional `build` and
`platform`.

## 6. Client identity and rate limits

`clientKey(request, config)`:
- If the socket peer address (IPv4-mapped IPv6 normalised to IPv4) is inside
  `TRUSTED_PROXY_CIDRS`, read `CLIENT_IP_HEADER`; it must be exactly one valid
  IP literal. Missing/invalid header from a trusted proxy → use the peer and
  count `telemetry_client_identity_fallback_total`.
- Otherwise use the peer address. Forwarding headers from untrusted peers are
  ignored entirely.
- Key: IPv4 → the address; IPv6 → its /64 prefix.

Limiters are token buckets in a bounded `Map` (LRU: touched keys move to the
end; past `RATE_LIMIT_MAX_KEYS` the oldest key is evicted; idle keys expire
after `RATE_LIMIT_IDLE_MS`; sweeping is incremental). A bucket charge is
all-or-nothing per request. `Retry-After` is the whole seconds until enough
tokens refill (min 1). Global budgets are single buckets. Feedback has its own
per-IP, per-user and global buckets and its own in-flight and writer slots, so
event overload never starves feedback and vice versa. All of this is
in-process: a second collector process must share enforcement (documented,
not implemented).

## 7. Admission (`src/admission.js`)

- `InflightGate(limit)`: `tryAcquire() → release | null`; release is idempotent.
- `WriterQueue({ writers, maxRequests, maxEvents, maxBytes, maxAgeMs })`:
  `run(job, { events, bytes, signal })` resolves with the job's result or
  rejects with `OverloadError(reason)` (`queue_full`, `queue_timeout`) or
  `AbortError` when `signal` aborts before the job started (client gone,
  deadline). Admission is checked at enqueue against all four bounds; a waiter
  whose age passes `maxAgeMs` is removed and rejected. Gauges: queued requests,
  events, bytes; histogram: wait time.

## 8. Writer semantics (`src/writer.js`)

`createWriter({ pool, config, metrics })` →
`writeEvents(events, { signal }) → outcomes[]` (one per event, same order:
`{ status: 'accepted' | 'duplicate' | 'rejected', reason? }`), throwing a
classified error when the transaction fails (all events then retryable).
`storeFeedback(feedback) → 'accepted' | 'duplicate' | 'conflict'`.

Identity and duplicate rules (normative; `docs/replay-contract.md` restates
them for consumers):

- An event's identity is its `event_id`. Same id and the same canonical
  client content → `duplicate`. Same id with different content, or with a
  different event type or attempt → `id_conflict`.
- Canonical client content: type, attempt, user, game, world, level, mode,
  sequence, `clientTsUs`, `elapsed_ms` and the type's fields (step: type,
  command, from_line, removed_lines; start: initial_script, source attempt;
  completion: play_script, lean_script). Build and platform attributes and `received_at`
  are not part of identity.
- `(attempt, sequence)` identifies one action. A step whose sequence is
  already taken by another event of the attempt (step, start, completion or a
  recorded later completion) → `sequence_conflict`.
- An attempt's context (user, game, world, level, mode) is fixed by the event
  that created its row. Any event with a different context → `context_mismatch`.
- `level_start`: if the attempt has no recorded start, record it
  (`start_event_id`, `start_sequence`, `start_client_ts`, `start_elapsed_ms`),
  fill `initial_script`/`source_attempt_id` only where NULL, and set
  `started_at = LEAST(started_at, start ts)` → `accepted`. If a legacy row
  already holds a different non-NULL `initial_script` → `start_conflict`.
  Same start id → compare (duplicate / `id_conflict`). Different start id →
  `start_conflict`.
- `level_complete` is immutable once accepted: first completion sets
  `completed`, `completed_at`, `duration_ms`, scripts, `completion_event_id`,
  `completion_sequence`, `completion_received_at` → `accepted`. Same
  completion id → compare. A legacy completed row without a completion id:
  identical content → `duplicate` (and its identity is recorded); otherwise
  `already_completed`. Any other later completion → `already_completed`, and its
  sequence is appended to `later_completion_sequences` (at most 64 entries) so
  readers can tell it from a lost step.
- A completion may arrive before steps it follows; completeness is computed
  by readers from sequences, never inferred from arrival order.
- Once retention expired an attempt's step detail (`detail_expired_at`,
  migration 010), every further step of it is `late_event`.
- After compaction a step's live row may be gone. Its `(attempt, sequence)`
  is then covered by a published chunk and its id by the chunk's
  `receipt_event_ids`. The writer must check those (decoding at most the
  covering chunks, bounded by the codec limits) and answer `duplicate` or a
  conflict exactly as for a live row. It never re-inserts a compacted step.
  If receipts were expired by an explicit policy, `(attempt, sequence)`
  coverage still prevents resurrection; only reuse of an expired id under a
  different attempt goes undetected (documented in `docs/replay-contract.md`).

Transaction shape (one transaction per batch, READ COMMITTED, a small fixed
number of statements, all parameterised with `unnest` arrays):

1. Within-batch identity: repeated `event_id` in one batch → compare; second
   copy is `duplicate` or `id_conflict`.
2. Upsert users once per batch, sorted by id: first_seen on insert; last_seen
   advanced to the batch maximum only when later by more than
   `LAST_SEEN_RESOLUTION_MS` (`ON CONFLICT ... DO UPDATE ... WHERE`).
3. Insert attempts once per distinct attempt, sorted, `ON CONFLICT DO NOTHING
   RETURNING attempt_id`; the creating event is the batch's `level_start` for
   that attempt if present, else its lowest-sequence event (`started_at` = its
   client ts, `attributes` = its build and platform).
4. `SELECT ... FROM proof_attempts WHERE attempt_id = ANY($1) ORDER BY
   attempt_id FOR UPDATE` — the attempt lock that serialises the writer with
   the compactor's publish/replace transactions for the same attempt. All
   chunk checks happen after this lock.
5. Context check, late-event policy, then one identity lookup for the batch's
   remaining ids: live `proof_steps` by `event_id`, attempts by
   `start_event_id`/`completion_event_id`, published chunks by
   `receipt_event_ids && $ids`.
6. Steps: chunk coverage for sequences ≤ `compacted_through`; bulk insert the
   rest `ON CONFLICT DO NOTHING RETURNING event_id`; for rows not returned,
   fetch the existing `(attempt, sequence)` rows and decide.
7. Bulk update starts, then completions (`UPDATE ... FROM unnest(...)`).
8. `last_received_at = now()` for attempts with an accepted event, when NULL
   or older than `LAST_RECEIVED_RESOLUTION_MS`.
9. `COMMIT`.

Timestamps go to SQL as exact microseconds (`codec.sqlFromMicros`) and are
compared as `codec.sqlMicros(column)`; never through JavaScript `Date`.

`src/database.js`: `createDatabase(config)` → `{ pool, withTransaction(fn,
{ signal }), checkReady(), close() }`. The pool sets `statement_timeout`,
`lock_timeout`, `idle_in_transaction_session_timeout`, `application_name`,
`connectionTimeoutMillis` (= acquisition timeout) and `query_timeout`.
`pool.on('error')` counts `telemetry_db_errors_total{class="idle_client"}` and
logs only the SQLSTATE/errno. A client is released with an error (destroyed,
never reused) when a query failed with a connection-class error, a client
timeout, or when `ROLLBACK` failed or was not attempted. Errors are classified
(`src/http/errors.js`): SQLSTATE classes 08, 53, `57P01-03`, `57014`,
`55P03`, `40001`, `40P01`, `25P03`, node socket errors and pool timeouts →
retryable 503; class 22 → 400 (counted, should be unreachable); others → 500.

### Microbatching (`src/microbatch.js`, off by default)

When `MICROBATCH_WINDOW_MS > 0`, validated event batches from concurrent
requests are combined for at most that window (bounded by
`MICROBATCH_MAX_EVENTS`/`BYTES`) into one `writeEvents` call; each request
receives its own outcomes after the shared commit. A retryable failure fails
all requests; a non-retryable failure retries each request's events alone so
one request cannot poison the others. Feedback is never microbatched.

## 9. Health, metrics, draining, disk

- `/livez`/`/healthz`: no I/O.
- `/readyz`: `{"status":"ready"|"unready","database":"ok"|"error"|"stale",
  "schema":"compatible"|"incompatible"|"unknown","draining":bool,
  "disk":"<level>","overload":{"inflight":n,"queued":n}}`. Ready iff schema
  compatible, last DB check (`SELECT 1` on the pool, at most every
  `READINESS_INTERVAL_MS`, coalesced) succeeded within `READINESS_MAX_AGE_MS`,
  and not draining. Overload and disk `alert`/`throttle` are reported but do
  not make the collector unready; disk `pause` does.
- Startup: listen first (liveness), then check schema compatibility with the
  writer role; DB unreachable → keep retrying, unready; incompatible → log the
  missing/mismatched files and exit 1. The collector never migrates.
- `SIGTERM`/`SIGINT`: set draining (readyz 503, new submissions 503), stop
  accepting connections, close idle keep-alive sockets, wait for in-flight
  requests and commits up to `DRAIN_TIMEOUT_MS`, destroy remaining sockets
  (their events stay unacknowledged), end the pool, exit 0.
- Collector metrics (all prefixed `telemetry_`):
  `http_requests_total{route,status}`, `http_request_duration_seconds{route}`,
  `events_total{outcome}` with outcome ∈ received, accepted, duplicate,
  rejected, rate_limited, overloaded, dropped (admitted but abandoned before
  commit), `events_rejected_total{reason}`,
  `requests_rejected_total{reason}` (origin, rate_ip, rate_user, rate_global,
  body_too_large, invalid_json, invalid_utf8, invalid_envelope, body_timeout,
  aborted, inflight_full, queue_full, queue_timeout, deadline, draining,
  disk_pause, db_unavailable, internal), `feedback_total{outcome}`,
  `inflight_submissions{kind}`, `writer_queue_requests`, `writer_queue_events`,
  `writer_queue_bytes`, `writer_queue_wait_seconds`, `pool_acquire_seconds`,
  `pool_clients{state}`, `db_errors_total{class}`, `db_transaction_seconds`,
  `batch_events` (histogram), `event_loop_lag_seconds{stat}` (p50, p99, max via
  `perf_hooks.monitorEventLoopDelay`), `process_resident_memory_bytes`,
  `process_heap_used_bytes`, `disk_utilization_ratio`, `disk_level{level}`,
  `draining`, `ready`, `rate_limit_keys{scope}`,
  `client_identity_fallback_total`, `client_health_total{counter}`,
  `client_health_reports_total`, `microbatch_requests` (histogram).
- Pressure for the compactor (`/internal/pressure`): max of in-flight ratio,
  queue ratio (by the tightest bound) and recent overload rejections; 1 while
  draining or disk-paused.

## 10. Trajectory store, compaction, retention, archive

Format and codec: `src/trajectory/codec.js` and `docs/trajectory-format.md`.
Table: `trajectory_chunks` (migration 008). Lifecycle:

1. Eligibility (trusted times only; NULL `received_at` rows count as ingested
   at migration 005's `applied_at`): live steps not covered by a chunk, of
   attempts that are completed or idle for `COMPACTION_INACTIVE_SECONDS`, and
   older than the recent-row window `COMPACTION_MIN_AGE_SECONDS`; long active
   attempts are chunked in full chunks once they have
   `COMPACTION_ACTIVE_CHUNK_THRESHOLD` eligible-age rows. Chunks hold at most
   `COMPACTION_CHUNK_MAX_EVENTS` actions and `COMPACTION_CHUNK_MAX_BYTES`
   encoded bytes; an action is never split.
2. Read a bounded, ordered source set; encode outside any transaction; insert
   as `state='shadow'`; read it back, decode and compare every field with the
   sources (`codec.sameAction`); on mismatch delete the shadow chunk and count
   a verification failure.
3. Publish in one short transaction: lock the attempt row (`FOR NO KEY
   UPDATE`), re-read the exact source rows by `event_id` and require them
   unchanged, require no sequence overlap with other published chunks, set
   `state='published'`, `published_at`, `proof_attempts.compacted_through =
   GREATEST(...)`.
4. Replace (only `COMPACTION_MODE=replace`, only for chunks published longer
   than `COMPACTION_REPLACE_DELAY_SECONDS`, at most
   `COMPACTION_REPLACE_LIMIT` chunks per process run as a canary bound): in one
   transaction lock the attempt, re-read the rows by id and require exact
   equality with the decoded chunk, delete exactly those ids, require the
   deleted count, set `sources_removed_at`. Concurrent late steps are never
   touched.
5. Late steps (sequences not in any chunk) stay live and later become `delta`
   chunks. Readers merge by sequence, report conflicts and gaps.
6. Crash safety: unpublished shadow chunks older than an hour are verified and
   published, or deleted (their sources are intact); published chunks resume at
   step 4. Every step is idempotent; at least one readable copy always exists.

`COMPACTION_MODE`: `off` | `shadow` (default; build, verify, publish, keep
sources) | `replace`. The compactor pauses while collector pressure exceeds
`COMPACTOR_PRESSURE_THRESHOLD` (via `COMPACTOR_PRESSURE_URL`), while disk is at
`throttle` or above (except replacement, which frees space), and bounds CPU by
a duty cycle. Its role is `telemetry_compactor` (prefix `COMPACTOR_`).

Retention (`src/jobs/retention.js`): every window unset by default (keep
everything). Dry run is the default and reports what would be removed; deleting
requires `--execute` and `RETENTION_POLICY_ID` naming the recorded decision.
Windows are independent: `RETENTION_DETAIL_DAYS` (steps and chunks of attempts
idle that long; the summary stays and `detail_expired_at` is set),
`RETENTION_ATTEMPT_DAYS` (attempt rows and scripts, ≥ the detail window),
`RETENTION_FEEDBACK_DAYS`, `RETENTION_RECEIPT_DAYS` (≥ 7 days; clear
`receipt_event_ids` of chunks whose sources were removed). Expiring detail or
attempts deletes the last copy unless a verified archive holds it: the job
requires `RETENTION_ARCHIVE_DIR` (checked per attempt) or an explicit
`RETENTION_EXPIRE_LAST_COPY=true`. Bounded batches, trusted times only,
measured and logged.

Archive (`src/jobs/archive.js`): writes bounded chunks plus their attempt
context, manifest and checksums to a directory (off-server upload is an
operator-configured command), verifies by re-reading and decoding, and never
deletes local data itself.

Reader (`src/trajectory/reader.js`), used by exports and tests:
`readAttempt(queryable, attemptId, options)` →
`{ attempt, actions, sources, completeness, errors }` and
`readAttempts(queryable, filter)`, an async iterator in keyset order with
resumable cursors. Shadow chunks are ignored; each accepted action is returned
exactly once in sequence order; missing sequences, unavailable/corrupt chunks
and chunk/live disagreements are reported, never hidden.

## 11. Testing

- Unit tests: `npm test` (`test/*.test.js`), no database.
- Integration: `npm run test:integration` with `TEST_DATABASE_URL`; one fresh
  database per test via `createTestDatabase()`; run serially.
- Python: `npm run test:python` (`test/python`, standard library `unittest`).
- Reproduce each defect from the plan's review as a regression test before
  fixing it where practical (malformed URLs, aborted uploads, multi-byte
  characters split across chunks, `RegExp`-coerced arrays, out-of-range
  integers, NUL bytes, idle pool errors, ...).
