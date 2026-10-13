# Lean game telemetry collector

The optional, separately hosted collector for the static game. Browsers run
Lean locally and, with the player's consent, send pseudonymous level attempts
and ordered proof actions; the collector validates them, admits them within
fixed bounds and stores them in PostgreSQL, acknowledging an event only after
it is committed. It does not execute Lean and is not part of proof
validation. A separate worker compresses complete trajectories losslessly.

```
Browser ──> Caddy (TLS, sole ingress, client IP header) ──> collector ──> PostgreSQL
                                                                 ▲            ▲
                                       private metrics :9464 ────┘   compactor, exports,
                                                                     retention, backups
```

## Documentation

| Topic | Document |
| --- | --- |
| Engineering contract: modules, configuration, semantics | [docs/design.md](docs/design.md) |
| Client-facing HTTP protocol (v1, v2, feedback) | [docs/protocol.md](docs/protocol.md) |
| Event identity, duplicates and the replay contract | [docs/replay-contract.md](docs/replay-contract.md) |
| Compressed trajectory format and compaction | [docs/trajectory-format.md](docs/trajectory-format.md), [docs/compaction.md](docs/compaction.md) |
| Exports and replay extraction | [docs/exports.md](docs/exports.md) |
| Benchmark and capacity | [docs/benchmark.md](docs/benchmark.md), [docs/capacity.md](docs/capacity.md) |
| **Deployment, releases, monitoring, backups, restores** | [docs/operations.md](docs/operations.md) |
| What the remediation implemented and what remains | [docs/remediation-status.md](docs/remediation-status.md) |

## Development

Node 22, PostgreSQL 17 for integration tests, Python 3.12 for the replay tools.

```sh
npm ci
npm test                                   # unit tests, no database
docker run -d --rm --name tlm-dev-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:17.10-alpine3.24
TEST_DATABASE_URL=postgresql://postgres:test@127.0.0.1:55432/postgres npm run test:integration
npm run test:python
```

Integration tests create and drop their own databases on the disposable
cluster in `TEST_DATABASE_URL`; never point them at a real deployment. The
backup/restore tests also need Docker.

## Deployment in brief

[`compose.yml`](compose.yml) is the steady-state stack: pinned PostgreSQL, the
collector from an immutable release image (`COLLECTOR_IMAGE`, a `sha-<commit>`
tag and digest built by
[`.github/workflows/telemetry-release.yml`](../.github/workflows/telemetry-release.yml)),
an explicit `migrate` release job that alone holds the bootstrap credential,
and least-privilege roles for the collector, compactor, exports, retention and
backups. Containers are unprivileged with read-only root filesystems, resource
limits and rotated logs; nothing publishes a port, and nothing updates itself
(no Watchtower, no Docker socket). Caddy reaches the collector over a private
edge network ([`ops/Caddyfile.example`](ops/Caddyfile.example)).

```sh
cp .env.example .env                  # COLLECTOR_IMAGE, POSTGRES_VOLUME, ...
# create secrets/ as described in secrets/README.md
docker compose up -d --wait postgres
docker compose run --rm migrate       # migrations + role passwords (release step)
docker compose run --rm verify-permissions
docker compose up -d --wait collector
```

The full procedures, including the step-by-step migration of the existing
deployment, canary releases, rollback, disk watermarks, backups
([`ops/backup.sh`](ops/backup.sh)) and restore drills
([`ops/restore-test.sh`](ops/restore-test.sh)), are in
[docs/operations.md](docs/operations.md). Post-deploy checks:
`ops/smoke-test.sh https://telemetry.leangame.autumnofautumn.com` (read-only).

For a different collector URL, build the website with
`VITE_TELEMETRY_URL=https://your-collector.example` and set `ALLOWED_ORIGINS`
to the exact site origins allowed to submit events.

## Data model

- `anonymous_users`: a random UUID plus first/last seen times.
- `proof_attempts`: game/world/level/mode once per attempt, start and
  completion identity, final scripts, completion status, trusted ingestion
  times, an optional link from a classic export to its visual attempt, and
  the `attributes` below.
- `proof_steps`: recent proof actions as rows. Visual steps are `command`,
  `undo` or `reset`; classic editor steps are line edits (`from_line`,
  `removed_lines`, inserted `command`).
- `trajectory_chunks`: compressed, versioned, verified chunks of older actions
  ([trajectory-format.md](docs/trajectory-format.md)). After compaction in
  `replace` mode an attempt's actions live partly in chunks, so read paths
  through `src/trajectory/reader.js`, `tools/export.js` or
  `extract-replays.py`, not `proof_steps` alone.
- `feedback_reports`: player-submitted messages with their game, level, mode,
  proof state and `attributes`; `user_id` only when telemetry is enabled.
- `attributes` (attempts and feedback) holds, each when the client reported it,
  `build`: the game build the player ran (source revisions `site`, `client`,
  `runtime`, `nng4`, `visualtest`, `lean`, each suffixed `-dirty` when built
  from a modified checkout, and the UTC build time `built`; recorded by
  `scripts/sync-lean4game-client.mjs` and published at
  `/lean4game/version.json`), and `platform`: the player's `browser` family
  (`chrome`, `safari`, `firefox`, `edge`, `brave`, `samsung`, `opera` or
  `unknown`) and `device` (`mobile` for phones and tablets, otherwise
  `desktop`), classified in the browser. Values outside those lists are
  dropped, so a user-agent string never reaches the database. Both are absent
  for clients before October 2026 and are not part of an event's identity. An
  attempt keeps those of the event that created it. Query them as, for
  example, `attributes->'build'->>'client'` or
  `attributes->'platform'->>'device'`.
- `schema_migrations`: the migration ledger with checksums.

Example completion report (summaries stay relational):

```sql
SELECT game_id, world_id, level_id, mode,
       count(*) AS attempts,
       count(*) FILTER (WHERE completed) AS completions,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)
         FILTER (WHERE completed) AS median_completion_ms
FROM proof_attempts
GROUP BY game_id, world_id, level_id, mode
ORDER BY game_id, world_id, level_id, mode;
```

## Privacy

The application asks for opt-in consent. On acceptance it creates the
first-party `lean_game_anonymous_id` cookie on the game site and sends the
identifier in the JSON body. Refusal deletes the identifier and pending
events. The collector does not store IP addresses or user-agent strings (only the
coarse browser family and device type above); it uses the client address only
in memory for rate limiting. Caddy keeps no access log for
the telemetry site and strips addresses from its error log entries. Logs and
metrics never contain proof text, feedback, identifiers or addresses. Proof
scripts and feedback can still contain sensitive text, so exports, archives
and backups are private and encrypted.
