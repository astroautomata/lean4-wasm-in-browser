# Telemetry collector HTTP protocol

This is the complete client-facing contract of the telemetry collector: what a
browser client may send, what each answer means and what the client must do
next. It covers `POST /v1/events` (legacy), `POST /v2/events` (current),
`POST /v1/feedback`, and the health endpoints. Identity, duplicate and replay
semantics are specified in [replay-contract.md](replay-contract.md); this
document refers to them but does not repeat their rationale. Engineering
details live in [design.md](design.md).

Anonymous telemetry is untrusted input. Nothing in this protocol proves that a
request came from a real player or that a reported proof or completion is
correct; an allowed `Origin` only keeps other web sites' scripts out. The
collector protects itself with validation, quotas and admission bounds, not by
trusting clients.

## 1. Transport

- HTTPS through Caddy, the only public ingress
  (`https://telemetry.leangame.autumnofautumn.com`). The collector itself is
  not reachable from the internet.
- Request bodies are UTF-8 JSON, sent with `Content-Type: application/json`.
  A leading byte-order mark is tolerated; any malformed UTF-8 is refused.
- Every submission must carry an `Origin` header naming an allowed site
  origin (`ALLOWED_ORIGINS`, exact match such as
  `https://leangame.autumnofautumn.com`).
- Bodies may use `Content-Length` or chunked transfer encoding. Both are
  limited to `MAX_BODY_BYTES` (default 524288 bytes = 512 KiB), counted in
  received bytes.
- The whole body must arrive within `BODY_TIMEOUT_MS` (default 10 s); the
  server answers within `REQUEST_TIMEOUT_MS` (default 15 s) or with 503.
  Clients should abort a fetch after about 20 s.

## 2. Endpoints

| Method and path | Purpose | Success |
| --- | --- | --- |
| `POST /v2/events` | event batch with per-event results | `200` + JSON results |
| `POST /v1/events` | legacy event batch (kept while old clients exist) | `204` |
| `POST /v1/feedback` | one player feedback report | `204` |
| `OPTIONS` on the three paths above | CORS preflight | `204` for an allowed origin, otherwise `403` |
| `GET`/`HEAD /healthz`, `/livez` | liveness | `200 {"status":"ok"}` |
| `GET`/`HEAD /readyz` | readiness | `200` ready, `503` unready (JSON body either way) |

Any other path answers `404 {"error":"not_found"}`. A known path with a wrong
method answers `405 {"error":"method_not_allowed"}` with an `Allow` header.
Metrics are served only on the private metrics port and are never proxied.

## 3. Responses, errors and CORS

- Every response to an allowed origin carries
  `Access-Control-Allow-Origin: <origin>`, `Vary: Origin` and
  `Access-Control-Expose-Headers: Retry-After`, so browser code can read
  `Retry-After` on 429 and 503. Preflight responses add
  `Access-Control-Allow-Methods: POST, OPTIONS`,
  `Access-Control-Allow-Headers: content-type` and
  `Access-Control-Max-Age: 86400`.
- Error bodies are `{"error":"<code>"}` with a code from the closed list in
  section 7. They never echo submitted data.
- `Retry-After` is always sent as whole seconds (at least 1). Clients must
  also accept the HTTP-date form, which a proxy could produce.
- Responses carry `Cache-Control: no-store`. A response that refuses a body it
  did not read, and every response while the collector drains, carries
  `Connection: close`.

## 4. Events

### 4.1 Envelope

```json
{"events": [ ...1 to 50 events... ], "client": {"health": { ... }}}
```

`events` must be an array of 1 to `MAX_EVENTS_PER_BATCH` (default 50) entries;
otherwise the whole request is `400 invalid_envelope` (more than the limit is
the client's batching bug, not an event property). `client` is optional and
only read by v2 (section 4.6). Unknown top-level keys are ignored.

Each array entry is validated on its own: one invalid event never refuses the
others.

### 4.2 Event fields

Every event:

| Field | Type and constraint | Rejection reason |
| --- | --- | --- |
| `event_id` | UUID string (RFC 4122 layout, version 1-5, variant 8-b), any case; normalised to lowercase. Stable across retries. | `invalid_uuid` |
| `user_uuid` | UUID string, the pseudonymous player id | `invalid_uuid` |
| `attempt_uuid` | UUID string, one play-through of one level | `invalid_uuid` |
| `event_type` | `level_start`, `proof_step` or `level_complete` | `invalid_event` |
| `mode` | `visual` or `classic` | `invalid_context` |
| `game_id` | 1-160 characters; `/`-separated segments of `[A-Za-z0-9._-]{1,80}`, none `.` or `..` | `invalid_context` |
| `world_id` | one such segment | `invalid_context` |
| `level_id` | integer 0..100000 | `invalid_context` |
| `sequence` | integer 0..1000000; the action's position within the attempt | `invalid_sequence` |
| `elapsed_ms` | integer 0..2147483647; milliseconds since the attempt began (client clock) | `invalid_timestamp` |
| `ts` | client wall-clock time, see 4.3 | `invalid_timestamp` |
| `build` | optional object, see 4.4 | never rejected |
| `platform` | optional object, see 4.4 | never rejected |

Values must have exactly these JSON types. Strings for numbers, arrays for
strings (`["<uuid>"]`) and other coercible values are rejected, never
converted.

Per event type (fields that do not belong to the type are ignored and stored as
NULL, whatever their value):

| `event_type` | Fields |
| --- | --- |
| `level_start` | `initial_script` (string or absent/null): the proof text the attempt started from, e.g. a proof handed over from the visual editor, or for a visual attempt that does not start from the empty proof a JSON array of its starting commands ([replay-contract.md](replay-contract.md) 2.2); `source_attempt_uuid` (UUID string or absent/null): the attempt it was handed over from or continues |
| `proof_step` | `step_type`: `command` (append one step), `undo` (remove the last step), `reset` (clear the proof), `edit` (classic line edit), `rejected` (a visual gesture that was refused; the proof is unchanged), `view` (a visual switch into or out of Transformation or Construction Mode; the proof is unchanged); `command`: string, may be empty, required; for `edit` also `from_line` and `removed_lines`, integers 0..1000000 (the edit replaces `removed_lines` lines starting at line `from_line` with the text in `command`); for `rejected` optionally `reason`, 1-64 characters of `[a-z0-9_-]` starting with a letter or digit, and `error`, text up to 65536 code units (stored in the action's `attributes`, not part of its identity) |
| `level_complete` | `play_script`, `lean_script` (each a string or absent/null): the final proof as played and as Lean source |

Missing or invalid step fields are `invalid_step`.

### 4.3 Text and timestamps

- Text must be a JSON string when present (`invalid_type` otherwise), must not
  contain U+0000 and must be well-formed UTF-16 without lone surrogates
  (`invalid_text`). Text is stored exactly as sent; nothing is trimmed,
  normalised or truncated.
- Length ceilings in UTF-16 code units (JavaScript `string.length`):
  `initial_script`, `play_script`, `lean_script` 262144; `command` 65536. A
  longer value rejects the event with `script_too_large`. Clients must not
  truncate to fit: a truncated proof is a corrupted proof. (Clients before
  October 2026 truncated; see section 9.)
- `ts` must be a string of at most 40 characters of the form
  `YYYY-MM-DDTHH:MM:SS[.f]Z` or `...±HH:MM`, with 1 to 6 fraction digits, a
  real calendar date and time (no leap seconds), between
  `2000-01-01T00:00:00Z` (inclusive) and `2100-01-01T00:00:00Z` (exclusive).
  `Date.prototype.toISOString()` output qualifies. The value is kept to the
  microsecond. Client times are informational only: the collector records its
  own trusted receipt times separately and never substitutes one for the
  other.

### 4.4 Build and platform

`build` describes the game build the client runs: optional revision strings
`site`, `client`, `runtime`, `nng4`, `visualtest`, `lean` (7-40 lowercase hex
digits, optionally suffixed `-dirty`) and `built` (a date string of at most 32
characters). Malformed entries are dropped silently; a malformed `build` never
rejects the event.

`platform` is the client's own coarse classification of where it runs:
`browser`, one of `chrome`, `safari`, `firefox`, `edge`, `brave`, `samsung`,
`opera` or `unknown`, and `device`, `mobile` (phones and tablets) or
`desktop`. Any other value, and any other key, is dropped silently, so free
text such as a user-agent string is never stored; a malformed `platform` never
rejects the event. Clients before October 2026 send none.

Both are stored as `attributes.build` and `attributes.platform` on the attempt
created by the event (and on feedback reports). Send them with every event: an
attempt keeps those of the event that creates it. Neither is part of event
identity, so a retry that differs only in them is a duplicate.

### 4.5 `POST /v2/events`

Response `200`, after the database transaction holding the valid events
committed:

```json
{"protocol": 2, "results": [
  {"index": 0, "event_id": "d707e185-136e-4f54-bca8-e1aaffbbe396", "status": "accepted"},
  {"index": 1, "event_id": "0b8c7b52-31a4-4c55-9d43-6b0f2b7f7c11", "status": "duplicate"},
  {"index": 2, "event_id": null, "status": "rejected", "reason": "invalid_uuid"},
  {"index": 3, "event_id": "9d1f7a56-7fd2-4f0a-8f6c-0b1d2e3f4a5b", "status": "rejected", "reason": "sequence_conflict"}
]}
```

- One result per submitted event, in submission order, with its `index`.
- `event_id` is the lowercase id, or `null` when the id itself was invalid.
- `accepted`: stored by this request. `duplicate`: already stored with
  identical content (an earlier attempt of this request, or another copy).
  Both mean durably stored: remove the event from the queue.
- `rejected`: terminal; retrying the same content can never succeed. Remove
  the event and count it. `reason` is from section 4.7.
- Any other status (408, 413, 429, 5xx, a network error, a timeout) means
  nothing in the request is acknowledged: keep every event and retry later,
  unchanged, with the same ids. Duplicates make this safe.

A v2 request whose events are all invalid still answers `200` with only
rejections and causes no database work.

### 4.6 Client health (v2 only)

```json
"client": {"health": {"queue_events": 12, "queue_bytes": 20480, "evicted": 0,
  "expired": 0, "oversize": 0, "rejected": 1, "retries": 3, "sent": 140}}
```

Optional. Each known key is a non-negative integer of at most 10^9: the
client's current queue size (`queue_events`, `queue_bytes`) and counters since
the client last reported successfully (`evicted` by the queue bound,
`expired` by the age bound, `oversize` events refused locally, `rejected` by
the server, `retries`, `sent`). Unknown keys and invalid values are ignored;
client health never causes a 400. The collector adds the values to the
`telemetry_client_health_total{counter}` metric only after the request
committed, and never stores them per user. Send it at most about once a minute
per page, on a request that is being sent anyway: it estimates client-side
loss without generating traffic of its own.

### 4.7 Rejection reasons

| Reason | Meaning |
| --- | --- |
| `invalid_event` | not an object, unknown `event_type`, or a value PostgreSQL could not store (should not occur) |
| `invalid_uuid` | an id field is not a UUID string |
| `invalid_type` | a text field is not a string |
| `invalid_context` | bad `mode`, `game_id`, `world_id` or `level_id` |
| `invalid_sequence` | `sequence` out of range |
| `invalid_timestamp` | bad `ts` or `elapsed_ms` |
| `invalid_text` | NUL or a lone surrogate in text |
| `invalid_step` | bad or missing `step_type`, `command`, `from_line`, `removed_lines`, or a bad `reason` |
| `script_too_large` | text over its ceiling (4.3) |
| `context_mismatch` | the attempt already exists with a different user, game, world, level or mode |
| `id_conflict` | this `event_id` is already stored with different content, type or attempt |
| `sequence_conflict` | another event already holds this `(attempt, sequence)` |
| `start_conflict` | the attempt already has a different start |
| `already_completed` | the attempt already has a different completion; completions are immutable |
| `late_event` | the attempt has been idle longer than the late-event policy allows (off by default) |

### 4.8 `POST /v1/events` (compatibility)

Same envelope and validation. Valid events are written and invalid ones are
counted and discarded. The answer is `204` once the valid events committed,
including when some were duplicates or conflicts (old clients cannot act on
per-event outcomes). It is `400 no_valid_events` if no event is valid and
`400 invalid_envelope` for a bad envelope. Other statuses as in section 7.

## 5. Feedback: `POST /v1/feedback`

```json
{"report_id": "<uuid>", "user_uuid": "<uuid, only with telemetry consent>",
 "game_id": "g/local/NNG4", "world_id": "Tutorial", "level_id": 2, "mode": "visual",
 "message": "The drop target did not react.", "proof_state": { ... },
 "ts": "2026-08-12T12:00:00.000Z", "build": { ... },
 "platform": {"browser": "safari", "device": "mobile"}}
```

- `report_id`: UUID string, stable across retries. `user_uuid` is optional
  and must be omitted unless the player enabled anonymous telemetry.
- `game_id`, `world_id`, `level_id`, `mode`, `ts`, `build`, `platform`: as for events.
- `message`: string; leading and trailing whitespace is trimmed; then 1 to
  1000 UTF-16 code units, no NUL, well-formed.
- `proof_state`: a JSON object, nested at most 64 levels, at most 50000 nodes
  (objects, arrays and scalars together), every key and string without NUL and
  well-formed, numbers finite, at most 262144 bytes when serialised as UTF-8
  JSON.
- `204`: stored, or already stored with identical content (retry).
  `409 {"error":"feedback_conflict"}`: the `report_id` is already stored with
  different content; drop it. `400 {"error":"invalid_feedback"}`: drop it.
  Other statuses as in section 7.

Feedback has its own rate budgets, in-flight allowance and database writer, so
event overload never blocks feedback and the reverse.

## 6. Health endpoints

- `/healthz` and `/livez` do no I/O and answer `200 {"status":"ok"}` while
  the process runs.
- `/readyz`:

  ```json
  {"status":"ready","database":"ok","schema":"compatible","draining":false,
   "disk":"ok","overload":{"inflight":3,"queued":0}}
  ```

  `database` is `ok`, `error` (the last check or connection failed) or `stale`
  (no successful check within `READINESS_MAX_AGE_MS`); `schema` is
  `compatible`, `incompatible` or `unknown` (not yet checked); `disk` is the
  watermark level (`ok`, `alert`, `throttle`, `pause`, `unknown`). Ready means
  compatible schema, database `ok`, not draining and disk not `pause`.
  Overload is reported but never makes the collector unready. Database checks
  are cached and coalesced (at most one per `READINESS_INTERVAL_MS`, skipped
  while writes succeed), so probing does not load the database.

## 7. Status codes

| Status | Error code(s) | When | Client action |
| --- | --- | --- | --- |
| 200 | | v2 results | apply per-event results |
| 204 | | v1 committed; feedback stored or duplicate; preflight | remove the sent events |
| 400 | `invalid_url`, `invalid_utf8`, `invalid_json`, `invalid_envelope`, `no_valid_events`, `invalid_feedback`, `invalid_event` | malformed request; nothing valid; a database data exception | terminal: drop the request's events |
| 403 | `origin` | origin not allowed (browsers see a CORS failure) | stop sending from this origin |
| 404 | `not_found` | unknown path, or v2 on a collector predating it | v2 clients fall back to v1 |
| 405 | `method_not_allowed` | known path, wrong method | client bug |
| 408 | `body_timeout` | the body did not arrive within `BODY_TIMEOUT_MS` | retry with backoff |
| 409 | `feedback_conflict` | feedback id reused with other content | drop |
| 413 | `body_too_large` | `Content-Length` or streamed bytes over `MAX_BODY_BYTES` | split the batch; a single event that alone exceeds the limit is dropped and counted (`oversize`) |
| 429 | `rate_ip`, `rate_user`, `rate_global` | a rate budget is exhausted; `Retry-After` = seconds until enough budget refills | wait at least `Retry-After`, then retry; new events wait too |
| 500 | `internal` | unexpected collector fault (also an unreadable compressed history chunk) | retry with exponential backoff |
| 503 | `draining`, `disk_pause`, `inflight_full`, `queue_full`, `queue_timeout`, `deadline`, `db_unavailable` | shutting down; disk watermark; admission bounds; deadline; database unavailable, locked or timing out; schema not yet verified | wait at least `Retry-After` (2 s for admission, 5 s for database/deadline/draining, 300 s for `disk_pause`), retry with jitter |

A request answered with anything but 200/204 acknowledged nothing. Whatever
the status, an event is acknowledged only after the PostgreSQL transaction
holding it committed; when the collector cannot tell (connection lost during
COMMIT), it answers 503 and the client's retry is resolved by duplicate
detection. A network error or timeout means the same: retry the same events.

Retry policy for clients: exponential backoff with full jitter and a ceiling
(about 1 s doubling to 60 s), never earlier than `Retry-After`; respect
backoff for new traffic too, including after 429 and 503; spread retries after
reconnecting (`online`) instead of retrying in lockstep; bound the queue by
count, bytes and age and count what it discards. Lifecycle sends
(`keepalive`/`sendBeacon`) must stay well below 64 KiB per request.

## 8. Limits and budgets

| Limit | Default | Variable |
| --- | --- | --- |
| Body | 524288 bytes | `MAX_BODY_BYTES` |
| Events per request | 50 | `MAX_EVENTS_PER_BATCH` |
| Body receipt | 10 s | `BODY_TIMEOUT_MS` |
| Server handling | 15 s | `REQUEST_TIMEOUT_MS` |
| Requests per IP | 1200/min, burst 10 s | `RATE_IP_REQUESTS_PER_MINUTE`, `RATE_BURST_SECONDS` |
| Events per IP | 12000/min | `RATE_IP_EVENTS_PER_MINUTE` |
| Requests / events per user | 120/min / 1500/min | `RATE_USER_REQUESTS_PER_MINUTE`, `RATE_USER_EVENTS_PER_MINUTE` |
| Feedback per IP / per user | 20/min / 10/min | `RATE_FEEDBACK_IP_PER_MINUTE`, `RATE_FEEDBACK_USER_PER_MINUTE` |
| Global requests / events / bytes / feedback | 500/s, 2500/s, 16 MiB/s, 5/s | `GLOBAL_*_PER_SECOND` |
| Event submissions uploading or processing | 64 | `MAX_INFLIGHT_SUBMISSIONS` |
| Feedback submissions | 8 | `FEEDBACK_INFLIGHT` |
| Waiting for a database writer | 64 requests, 1000 events, 16 MiB accounted, 500 ms | `QUEUE_MAX_*` |

The defaults are provisional guardrails to be sized from the benchmark
(docs/benchmark.md, docs/capacity.md), not capacity promises. Rate budgets are
token buckets: the burst is `RATE_BURST_SECONDS` of the rate. A request is
charged all or nothing: its request, event and byte costs on every bucket it
touches.

Client identity for the per-IP budgets: Caddy overwrites one header
(`X-Telemetry-Client-IP`) with the TCP peer address, and the collector
believes that header only from `TRUSTED_PROXY_CIDRS`; client-supplied
forwarding headers never change the bucket. IPv4 clients are keyed by address,
IPv6 clients by their /64. The per-IP budget is generous because a classroom
shares one NAT address; per-user and global budgets bound individual and total
load. The per-user budget is keyed by the client-chosen `user_uuid`, so it
limits honest clients only; the global budgets are what bound abuse. All
limiter state is in-process and bounded (`RATE_LIMIT_MAX_KEYS` keys per
limiter, idle keys expire after `RATE_LIMIT_IDLE_MS`). A second collector
process or a second ingress would each enforce their own budgets: running more
than one requires shared enforcement, which is not implemented.

## 9. Compatibility and rollout

Rules:

1. **Server first.** A collector release must accept every request the
   previous collector and every client still in use send. Deploy it before any
   client that depends on it. Schema migrations are additive and are applied
   by the migration job before the collector release (the collector refuses
   to start on an incompatible schema and never migrates).
2. **v1 stays** while old clients exist. Browsers cache the static site, and
   pages stay open for days, so old clients keep sending v1 for weeks after a
   client release. Remove v1 only after `telemetry_http_requests_total
   {route="v1_events"}` has stayed near zero for a full transition window
   (proposed: four weeks after the last client release that used v1), and
   keep the legacy payload limits for that window.
3. **v2 clients fall back.** A v2 client that receives 404 from
   `/v2/events` (an older collector) resends the same events to `/v1/events`.
4. **Identity is stable.** A client never changes the content of an event
   after assigning its `event_id`, and never reuses an id. Sequences are
   assigned once per action.

What changed for v1 clients in the October 2026 hardening (all backward
compatible for correct clients):

- A batch with some invalid events is no longer refused as a whole: valid
  events are stored and `204` is returned (previously `400` for the whole
  batch, which old clients then dropped).
- Database failures answer `503` with `Retry-After` instead of `500`. Old
  clients retry both.
- Validation is strict: arrays or strings where scalars are expected,
  out-of-range integers, NUL, lone surrogates and impossible timestamps are
  rejected per event instead of reaching the database.
- Scripts and commands over the ceilings are rejected (`script_too_large`)
  instead of being silently truncated by the collector. Old clients truncate
  them before sending, which may split a surrogate pair; such events are now
  rejected as `invalid_text` rather than stored altered.
- A slow upload is cut off with `408` and an oversized body with `413`. Old
  clients drop any 4xx except 429, so they lose such a batch; the new client
  retries 408 and splits on 413.
- `429` carries the real time until budget refills in `Retry-After` instead
  of a fixed 60. Old clients ignore it and back off on their own.
- Duplicates and conflicting retries answer `204` and are counted; repeated
  completions no longer overwrite the first accepted completion.
- `REQUESTS_PER_MINUTE` is deprecated and ignored (startup warning); use the
  budgets in section 8.

Before October 2026, visual "reset proof" was logged as `undo`; current clients
send `reset`. The `rejected` and `view` step types need migration 011 and this
collector release; deploy both before the client that sends them (rule 1). Event semantics for readers are in
[replay-contract.md](replay-contract.md).
