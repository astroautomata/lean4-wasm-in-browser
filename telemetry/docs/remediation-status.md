# Remediation status

Implementation status of the telemetry remediation plan (12 October 2026) on
branch `telemetry-remediation` of this repository and of
`ryyanmapes/lean4game` (the browser client). Nothing here is deployed: the
plan authorised implementation, not deployment, deletion, sampling or consent
changes. What remains needs an operator, a separate machine or a recorded
policy decision; it is listed per phase.

The branch is based on lean4.js `7c6ff78` (browser family and device type
with telemetry) and carries that change into the rewritten collector:
`platform` is validated to its fixed values (`validatePlatform`), stored with
`build` in `attributes` of the attempt's creating event and of feedback
reports, kept out of event identity, exported in every format and replay, sent
by the load generator, and checked by the release workflow's smoke test. The
lean4game branch adds the in-browser classification that sends it
(`client/src/utils/telemetryPlatform.ts`) and describes it in the privacy
text; no such client change existed upstream yet.

Verification at the time of writing: 129 unit tests, 90 PostgreSQL
integration tests and 17 Python tests in `telemetry/`; 18 client tests in
lean4game (`npm run test:telemetry`). A disposable Compose deployment of this
stack was exercised end to end: migration job, role provisioning, permission
verification, collector as `telemetry_writer`, load-generator traffic through
the edge network, verification of every acknowledged event, compaction in
`replace` mode as `telemetry_compactor`, re-verification, CSV/XLSX exports,
archive and archive verification, a retention dry run, the refused unrecorded
`--execute`, and a graceful drain.

## Phase 1 — crashes and input corruption: done

| Plan item | Where |
| --- | --- |
| One async request boundary; aborted uploads, closed sockets, guarded writes, exactly-once cleanup, no global catch-all | `src/app.js` (`handle`), `src/http/respond.js`; tests `test/app.test.js`, `test/integration/lifecycle.test.js` |
| Byte-counted bodies, early and streamed 413, single fatal UTF-8 decode, controlled 400s | `src/http/body.js`; `test/body.test.js` (every chunk split of multi-byte text) |
| Strict UUIDs, bounded integers, cleared irrelevant fields, timestamp policy, NUL/surrogates, feedback depth/size, explicit rejection of oversized scripts | `src/validation.js`; `test/validation.test.js` |
| Pool error listener, destroyed uncertain connections, readiness on connectivity | `src/database.js`, `src/health.js`; `test/integration/http.test.js` (pg_terminate_backend) |
| 400/403/408/413/429/503/500 classification with Retry-After | `src/http/errors.js`; `test/errors.test.js` |

## Phase 2 — overload and privileges: done (deployment pending)

| Plan item | Where |
| --- | --- |
| Caddy as sole ingress, overwritten client-IP header, trust only the proxy, IPv4/IPv6 | `ops/Caddyfile.example`, `src/http/client-identity.js` (/64 keys for IPv6) |
| Bounded expiring per-IP, per-user and global budgets; separate feedback budgets and reserved capacity | `src/rate-limit.js`, `src/app.js` |
| In-flight, queue count/events/bytes/age bounds; refusal before buffering | `src/admission.js`; `test/admission.test.js` |
| PostgreSQL-side statement/lock/idle deadlines, acquisition and request deadlines | `src/database.js`, migration 009 role settings; `test/integration/http.test.js` (stalled database) |
| Separate migration role and runtime roles; verified against an existing volume | migrations 009/010, `src/migrate.js --provision-roles`, `tools/verify-permissions.js` |
| Ledgered, checksummed, locked migrations; collector only checks compatibility | `src/migrate.js`; `test/integration/migrations.test.js` |
| Non-root, resource limits, read-only roots, log rotation, secrets, no Watchtower/Docker socket, pinned images | `compose.yml`, `Dockerfile`, `secrets/README.md` |

Remaining: apply the production migration procedure in
`docs/operations.md` (back up first; run the migration job with the existing
superuser; provision role passwords; verify permissions on the real volume;
switch the collector to `telemetry_writer`; join Caddy to the edge network and
replace the Caddyfile block; remove Watchtower and the published 8090 port).
Size the global budgets from the benchmark. Server-issued anonymous tokens are
optional in the plan and not implemented.

## Phase 3 — browser delivery and retries: done (release pending)

lean4game `client/src/utils/telemetry.ts`, `telemetryQueue.ts`,
`telemetryScheduler.ts`, `client/test/telemetry.test.mjs`,
`doc/telemetry-client.md`: one scheduler, jittered 2-5 s batching, ordinary
fetch with a 20 s deadline, keepalive bodies within 60 KiB, Retry-After in both
forms, jittered exponential backoff with a ceiling that new events cannot
bypass, spread-out reconnects, a queue bounded by bytes/count/age with counted
evictions, a transactional IndexedDB queue with a cross-tab sender lease,
consent refusal clearing every store and ignoring in-flight results, v2
per-event results with v1 fallback, low-volume client health.

Remaining: deploy the collector (with `/v2`) first, then rebuild and publish
the client (`scripts/sync-lean4game-client.mjs` and the site release). Old
cached clients keep working through `/v1`.

## Phase 4 — database work and event integrity: done

Bulk writer with a fixed statement count per batch, sorted locking, coalesced
user and attempt updates, exact duplicate/conflict semantics for steps,
starts and completions, immutable completion with recorded later completion
sequences, out-of-order start reconciliation, post-compaction identity checks,
v2 per-event results, optional microbatching (off): `src/writer.js`,
`src/microbatch.js`, migrations 005-007; contract in `docs/protocol.md` and
`docs/replay-contract.md`; tests `test/integration/writer*.test.js`.

Item 9 (smaller live-row keys) is deliberately deferred until
`tools/storage-report.js` measurements exist; the decision record is in
`docs/replay-contract.md`.

## Phase 5 — compression, retention and recovery: done; policies not chosen

Versioned lossless codec (`src/trajectory/codec.js`, Python reference
decoder), chunk store (migration 008), compactor with shadow/publish/replace
lifecycle, crash recovery and canary bound (`src/trajectory/compactor.js`,
`src/jobs/compactor.js`), shared reader, policy-gated retention with a
last-copy guard (`src/jobs/retention.js`, migration 010), archive export and
verification (`src/jobs/archive.js`), disk watermarks in collector and
compactor, backups and restore drills (`ops/backup.sh`, `ops/restore-test.sh`),
storage measurement (`tools/storage-report.js`). Tests inject a crash at every
compaction boundary.

Remaining decisions and operations (none are defaults):

- the recent-row window, compressed-path window, attempt/feedback windows and
  receipt lifetime (`docs/operations.md` decision template);
- `COMPACTION_MODE=replace` only after the shadow comparison, a restore-tested
  backup and a canary (`docs/compaction.md` "Modes and rollout");
- an off-server, encrypted backup and archive target (`BACKUP_ENCRYPT_CMD`,
  `BACKUP_UPLOAD_CMD`, archive upload), the recovery point objective, and
  regular restore drills;
- whole-attempt sampling and partitioning are documented as later options, not
  implemented, as the plan prescribes.

The codec was measured on a small local export (63.6 compressed bytes per
action as stored); the full retained footprint must be measured on
representative data.

## Phase 6 — readiness, observability and releases: done (deployment pending)

`/livez`, `/healthz`, cached `/readyz`, private metrics with bounded labels,
pressure endpoint for the compactor, SIGTERM draining below the stop grace
period, compactor metrics including WAL, dead tuples and vacuum age
(`src/health.js`, `src/collector-metrics.js`, `src/server.js`,
`src/jobs/compactor.js`). The release workflow tests (unit, integration,
Python), audits dependencies, scans the image and publishes only immutable
`sha-` tags (`.github/workflows/telemetry-release.yml`). Runbooks, gates,
rollback and the external uptime check are in `docs/operations.md`.

Remaining: configure scraping/alerting and an external uptime check of
`/readyz`; follow the release runbook for the first rollout.

## Phase 7 — exports and replays: done

Streaming CSV (same 29 columns and PostgreSQL text conventions, checked
against the previous psql export), JSONL with identities and completeness, a
typed-text XLSX human export, filters, checkpoints and resume
(`tools/export.js`, `tools/xlsx.js`, `export-telemetry.sh`); streaming
`extract-replays.py` with byte-identical replays to the previous version,
bounded per-attempt work, checkpointed proofs and resume. See
`docs/exports.md`.

## Phase 8 — benchmark: tools ready, measurements not taken

`bench/loadgen.js` (open loop, the plan's scenario matrix, fault injection,
production refusal), `bench/verify.js`, `bench/scenarios/`,
`bench/profiles/` and `docs/benchmark.md`, `docs/capacity.md`. The tools were
exercised only at harmless rates against disposable stacks on this host. The
real benchmark must run from a separate machine against staging, as the plan
requires; publish the envelope table in `docs/benchmark.md`.

## Original findings

| Finding | Status |
| --- | --- |
| 1. URL/upload crashes | fixed, regression-tested |
| 2. Proxy-shared rate limit | fixed in code; needs the Caddy/edge-network deployment |
| 3. Unbounded database wait | fixed (bounds, PostgreSQL deadlines) |
| 4. Unhandled pool errors | fixed |
| 5. Per-event query/write amplification | fixed (bulk writer; client batching); microbatching available, off |
| 6. Forged/abusive anonymous ingestion | bounded by quotas and global budgets; tokens optional and not implemented; data remains untrusted by contract |
| 7. Unbounded retained data | compaction, trusted ingestion times, watermarks and policy-gated retention implemented; windows to be decided |
| 8. Runtime superuser | fixed in code; needs the production role migration |
| 9. Unicode corruption/character cap | fixed (byte limits, fatal decoding, explicit rejection) |
| 10. Invalid SQL-bound inputs | fixed, per-event outcomes |
| 11. Transport/retry failures | fixed in the client; needs the client release |
| 12. Silent conflicts/mutable completion | fixed, including after compaction and retention |
| 13. Readiness/shutdown/release gaps | fixed in code and workflow; runbooks written |
| 14. Spreadsheet formulas | fixed (typed-text XLSX; machine export unchanged) |
| 15. Export/replay scaling | fixed (streaming, shared reader, checkpoints) |

## Implementation notes beyond the original contract

- Migration 010 (`detail_expired_at`): without it, a retry of a step whose
  detail a retention policy removed would have been accepted as new data.
- Retention refuses to expire the last copy of detail unless a verified
  archive holds it or the policy records `RETENTION_EXPIRE_LAST_COPY=true`.
- Feedback `proof_state` validation accepts JSON `null` (an earlier draft
  rejected it, which would have refused legitimate reports).
