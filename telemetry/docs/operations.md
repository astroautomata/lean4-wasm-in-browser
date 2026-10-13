# Telemetry operations

How to deploy, release, observe, back up and restore the telemetry collector
on the single Hetzner host (4 vCPU, 8 GB RAM, 160 GB disk). The engineering
contract is [design.md](design.md); this document is the operator's side of
it. Nothing in the repository deploys by itself: every step below is run
deliberately by an operator.

Contents: [Deployment layout](#deployment-layout) ·
[First-time setup](#first-time-setup) ·
[Migrating the existing deployment](#migrating-the-existing-deployment) ·
[Releases, canary and rollback](#releases-canary-and-rollback) ·
[Shutdown and draining](#shutdown-and-draining) ·
[Monitoring](#monitoring) · [Disk watermarks](#disk-watermarks) ·
[Backups](#backups) · [Restore drills](#restore-drills) ·
[Retention policy](#retention-policy) · [Resource budget](#resource-budget) ·
[Single-host limitations](#single-host-limitations)

## Deployment layout

```
Internet ──TLS──> Caddy (root project; ports 80/443; the only public ingress)
                    │  edge network (internal, fixed subnet 10.247.81.0/28)
                    ▼
                 collector :8080 (public routes)   :9464 (metrics, private)
                    │  db network (internal)
                    ▼
                 postgres :5432 <── migrate (release job) · compactor · tools
```

| Service | Profile | Image | Credential it holds | Notes |
| --- | --- | --- | --- | --- |
| `postgres` | default | `postgres:17.10-alpine3.24` | bootstrap password (first init only) | uid 70, read-only root, `db` network only |
| `migrate` | `migrate` | `COLLECTOR_IMAGE` | bootstrap superuser + all role passwords | one-shot: `node src/migrate.js --provision-roles` |
| `collector` | default | `COLLECTOR_IMAGE` | `telemetry_writer` | `db` + `edge`; no published port |
| `compactor` | `compactor` | `COLLECTOR_IMAGE` | `telemetry_compactor` | metrics on 9465; [compaction.md](compaction.md) |
| `exporter` | `tools` | `COLLECTOR_IMAGE` | `telemetry_reader` | `node tools/export.js`; [exports.md](exports.md) |
| `retention` | `tools` | `COLLECTOR_IMAGE` | `telemetry_retention` | dry run unless a recorded policy says otherwise |
| `verify-permissions` | `tools` | `COLLECTOR_IMAGE` | all five runtime roles | read-only privilege check |
| `ops/backup.sh` | host script | `postgres` image as client | `telemetry_backup` | encrypted `pg_dump` |

Every application container is unprivileged (uid 1000 or 70), has a read-only
root filesystem with a small `/tmp` tmpfs, drops all capabilities, sets
`no-new-privileges`, runs under `init`, has memory/PID/CPU limits and rotated
`json-file` logs (5 × 10 MB). There is no Watchtower and no Docker socket in the
stack: releases are deliberate changes of `COLLECTOR_IMAGE` to an immutable
tag and digest.

**Secrets** are files in `telemetry/secrets/` (gitignored, never in the build
context), owned by root, group `TELEMETRY_SECRETS_GID` (10001), mode 0440; see
[`secrets/README.md`](../secrets/README.md). Compose mounts only the files a
service lists, so the collector can read the writer password and nothing else.
The bootstrap (superuser) credential is mounted only into `migrate` and, for
initialising an empty volume, `postgres`.

**Networks** have fixed names (`telemetry_db`, `telemetry_edge`) so Caddy's
project, backups and a metrics scraper can attach. Both are `internal`: the
collector and the jobs have no route to the internet. The edge subnet is
fixed so that `TRUSTED_PROXY_CIDRS` can name it; dynamic addresses come from
`10.247.81.8/29`, which leaves `10.247.81.2` free to pin Caddy.

**Volumes**: `POSTGRES_VOLUME` is external, so a wrong name fails loudly
instead of initialising an empty database. `disk_probe` is an empty volume on
the same Docker data root as the database volume, mounted read-only at
`/run/disk-probe` in the collector and compactor for the disk watermarks.

## First-time setup

Requirements: Docker Engine 25+ with Compose 2.24+ (the host runs 29.3 /
5.1), the DNS name pointing at the host, and an off-server backup target.

```sh
cd /root/opt/lean4-wasm-in-browser/telemetry      # the checkout Compose includes
cp .env.example .env                              # then edit: COLLECTOR_IMAGE, POSTGRES_VOLUME, ...
# Secrets: see secrets/README.md (random role passwords, 0440, group 10001).
docker volume create telemetry_postgres           # POSTGRES_VOLUME=telemetry_postgres
docker compose pull postgres collector migrate
docker compose up -d --wait postgres
docker compose run --rm migrate                   # applies migrations, enables the roles
docker compose run --rm verify-permissions        # must end with "result: PASS (5 roles)"
docker compose up -d --wait collector
```

Then attach Caddy to the edge network and install the site block from
[`ops/Caddyfile.example`](../ops/Caddyfile.example) as described in steps 7-9
of the migration below, set up [backups](#backups) and the
[external uptime check](#external-uptime-check), and run
`ops/smoke-test.sh https://telemetry.leangame.autumnofautumn.com`
(read-only checks).

Enable the compactor only after reading [compaction.md](compaction.md); it
starts in `shadow` mode, which never removes source rows:
`docker compose --profile compactor up -d compactor`.

## Migrating the existing deployment

Current state (October 2026): `/root/docker-compose.yml` (project `root`)
includes `/root/opt/lean4-wasm-in-browser/telemetry/compose.yml` with
`telemetry/.env`. PostgreSQL 17.10 runs with the volume
`root_telemetry_postgres`; the collector runs
`ghcr.io/astroautomata/lean4-wasm-in-browser-telemetry:latest` **as the
superuser `lean_telemetry`**, migrates at startup, publishes
`127.0.0.1:8090`, and carries a Watchtower label; Watchtower is defined with
the Docker socket (not running). Caddy (`caddy:latest`, same project) proxies
`collector:8080` over `root_default` with the block in
`/root/etc/caddy/Caddyfile`.

The order below keeps the old collector serving while the schema is upgraded
online (migrations 005-009 are additive and the old collector keeps working on
them), and limits the intake interruption to the few seconds in step 8.
`$T` is `/root/opt/lean4-wasm-in-browser/telemetry` and `$IMAGE` the release's
`COLLECTOR_IMAGE` (`ghcr.io/...-telemetry:sha-<commit>@sha256:<digest>` from
the release run summary).

1. **Record the rollback point.**
   `git -C /root/opt/lean4-wasm-in-browser rev-parse HEAD`, a copy of `$T/.env`,
   `/root/docker-compose.yml` and `/root/etc/caddy/Caddyfile`, and the digest of
   the image the old collector runs:
   `docker image inspect --format '{{index .RepoDigests 0}}' ghcr.io/astroautomata/lean4-wasm-in-browser-telemetry:latest`.
2. **Create the secrets** (`$T/secrets/`, see [`secrets/README.md`](../secrets/README.md)).
   `postgres_password` is the **existing** superuser password; the five role
   passwords are new random values. On this host the valid password was the
   `POSTGRES_PASSWORD` line of `/root/.env`, not the one in `telemetry/.env`.
   Check a candidate over the Docker network, never from inside the
   container (the image trusts local and 127.0.0.1 connections, so any
   password appears to work there):
   `docker run --rm --network root_default -e PGPASSWORD="$candidate" postgres:17.10-alpine3.24 psql -h postgres -U lean_telemetry -d lean_telemetry -Atc 'select 1'`.
3. **Back up first**, as the existing superuser (the backup role does not exist
   yet), onto the old network, and ship it off the host:
   ```sh
   BACKUP_DIR=/root/backups/telemetry BACKUP_PGUSER=lean_telemetry \
   BACKUP_PGPASSWORD_FILE=$T/secrets/postgres_password BACKUP_DOCKER_NETWORK=root_default \
   BACKUP_ENCRYPT_CMD='age -r age1...' BACKUP_ENCRYPTED_SUFFIX=.age \
   BACKUP_UPLOAD_CMD='rclone copy "$1" offsite:telemetry/$(basename "$1")' \
   $T/ops/backup.sh
   ```
   Restore-test it, preferably on another machine, with
   `RESTORE_ALLOW_UPGRADE=1` (a pre-009 dump has no runtime roles yet, so the
   drill also proves the new release upgrades a copy of the real data):
   `RESTORE_DECRYPT_CMD='age -d -i key.txt' RESTORE_ALLOW_UPGRADE=1 ops/restore-test.sh <set>`.
4. **Upgrade the schema online** with the new image, the existing superuser as
   the migration credential, on the old network. The old collector keeps
   serving; the runner shares its advisory lock, so a restart of the old
   collector cannot interleave with it.
   ```sh
   secret() { printf -- '-v %s:/run/secrets/%s:ro ' "$T/secrets/$1" "$1"; }
   docker run --rm --network root_default --read-only --cap-drop ALL \
     --security-opt no-new-privileges --user 1000:1000 --group-add 10001 \
     $(secret postgres_password) $(secret telemetry_writer_password) \
     $(secret telemetry_compactor_password) $(secret telemetry_reader_password) \
     $(secret telemetry_retention_password) $(secret telemetry_backup_password) \
     -e PGHOST=postgres -e PGDATABASE=lean_telemetry \
     -e MIGRATION_PGUSER=lean_telemetry -e MIGRATION_PGPASSWORD_FILE=/run/secrets/postgres_password \
     -e TELEMETRY_WRITER_PASSWORD_FILE=/run/secrets/telemetry_writer_password \
     -e TELEMETRY_COMPACTOR_PASSWORD_FILE=/run/secrets/telemetry_compactor_password \
     -e TELEMETRY_READER_PASSWORD_FILE=/run/secrets/telemetry_reader_password \
     -e TELEMETRY_RETENTION_PASSWORD_FILE=/run/secrets/telemetry_retention_password \
     -e TELEMETRY_BACKUP_PASSWORD_FILE=/run/secrets/telemetry_backup_password \
     "$IMAGE" node src/migrate.js --provision-roles
   ```
   Migration 007 builds its indexes `CONCURRENTLY`; on a large table it takes a
   while but does not block intake. If it reports an invalid index, follow the
   message (drop it concurrently and rerun).
5. **Verify effective permissions against the existing volume** (not a fresh
   install): same `docker run` prefix with the five role secrets,
   `-e PGHOST=postgres -e PGDATABASE=lean_telemetry`,
   `-e WRITER_PGPASSWORD_FILE=/run/secrets/telemetry_writer_password` (and
   `COMPACTOR_`, `READER_`, `RETENTION_`, `BACKUP_`), command
   `node tools/verify-permissions.js`. It must print `result: PASS (5 roles)`.
   It checks role attributes, memberships, ownership, every table and column
   privilege against the expected matrix, role settings, and probes DDL and
   deletes inside a rolled-back transaction (so PostgreSQL's log shows a few
   expected `permission denied` / `must be owner` errors, without statement
   text).
6. **Prepare the new definitions** (nothing restarts yet):
   - Update the checkout to the release commit
     (`git -C /root/opt/lean4-wasm-in-browser pull --ff-only` or checkout the
     release tag).
   - Write `$T/.env` from `.env.example`: `COLLECTOR_IMAGE=$IMAGE`,
     `POSTGRES_VOLUME=root_telemetry_postgres`, `TRUSTED_PROXY_CIDRS=10.247.81.2/32`.
     Delete the old `POSTGRES_PASSWORD`, `REQUESTS_PER_MINUTE` and
     `WATCHTOWER_POLL_INTERVAL` lines: the password now lives only in
     `secrets/postgres_password`.
   - Check the data directory owner, since PostgreSQL now starts directly as
     uid 70: `docker run --rm -v root_telemetry_postgres:/d:ro alpine:3 stat -c '%u:%g %a' /d`
     must print `70:70 700`.
   - Edit `/root/docker-compose.yml`: pin Caddy and attach it to the edge
     network with a fixed address outside the dynamic range:
     ```yaml
     services:
       caddy:
         image: caddy:2.11.2            # the version running today; review upgrades
         restart: unless-stopped
         ports: ["80:80", "443:443"]
         volumes: [ ... unchanged ... ]
         networks:
           default: {}
           edge:                        # defined by the included telemetry compose.yml
             ipv4_address: 10.247.81.2
     ```
     (with `include:` unchanged). Validate: `docker compose -f /root/docker-compose.yml config --quiet`.
   - Replace the `telemetry.leangame.autumnofautumn.com { ... }` block of
     `/root/etc/caddy/Caddyfile` with the snippet and site block of
     [`ops/Caddyfile.example`](../ops/Caddyfile.example), and put its global
     options block at the very top of the file. Validate with
     `docker run --rm -v /root/etc/caddy/Caddyfile:/etc/caddy/Caddyfile:ro caddy:2.11.2 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`.
7. **Switch** (intake is interrupted for the seconds between a and c; clients
   keep unacknowledged events and retry):
   ```sh
   cd /root
   docker compose up -d --wait postgres     # a: hardened PostgreSQL, db network
   docker compose up -d --wait collector    # b: new image, telemetry_writer, no port 8090
   docker compose up -d caddy               # c: joins edge, loads the new Caddyfile
   docker compose up -d --remove-orphans    # d: removes the Watchtower container
   ```
   Recreating Caddy briefly interrupts the other two sites as well. To avoid
   that, run `docker network connect --ip 10.247.81.2 telemetry_edge root-caddy-1`
   and `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`
   instead of step c, and let the next routine `up -d` recreate Caddy.
8. **Verify**:
   - `$T/ops/smoke-test.sh https://telemetry.leangame.autumnofautumn.com`
     (read-only checks; never `--write` against production).
   - `docker compose ps` shows no published 8090; `ss -ltn | grep 8090` is empty.
   - Nothing mounts the Docker socket:
     `docker ps -a --filter volume=/var/run/docker.sock` is empty. Remove the
     image too: `docker image rm containrrr/watchtower:latest`.
   - Metrics: `docker compose exec collector wget -qO- http://127.0.0.1:9464/metrics | grep -E 'telemetry_(ready|disk_level|events_total)'`.
   - Client identity: after some traffic `telemetry_rate_limit_keys{scope="ip_requests"}`
     is well above 1 and `telemetry_client_identity_fallback_total` stays 0.
     A single key would mean every client shares Caddy's (or Docker's) address.
   - [IPv6](#ipv6): check that IPv6 clients keep their own address.
9. **Afterwards**: schedule [backups](#backups) as `telemetry_backup` on the
   `telemetry_db` network, run a [restore drill](#restore-drills) of the first
   one, configure the [external uptime check](#external-uptime-check), then
   enable the compactor in `shadow` mode.

**Rolling back this migration**: check out the recorded commit, restore the
old `.env`, `/root/docker-compose.yml` and Caddyfile, pin the old collector by
the recorded digest instead of `latest`, and `docker compose up -d`. The old
collector works on the upgraded schema (the migrations are additive and
nothing is removed), so no database restore is needed. This stops being true
once compaction has run in `replace` mode (see
[rollback floor](#rollback-floor)).

## Rollout of the remediation

The plan's phases reach production in this order; each step is a normal
[release](#releases-canary-and-rollback) with its gates, and nothing later
starts until the earlier gate holds.

1. **Server first** (phases 1, 2, 4, 6): this release, through the
   [migration](#migrating-the-existing-deployment) above. It keeps `/v1/events`
   and `/v1/feedback` fully compatible, so every cached old client keeps
   working; `/v2/events` is additive.
2. **Backups and disk alerts working** (phase 5, items 11-13) before traffic
   grows: scheduled encrypted off-server backups, one passed restore drill,
   the external uptime check and disk alerts.
3. **Client** (phase 3): rebuild and sync the browser bundle only after the
   server is live; old cached clients continue on v1 until they reload. Keep the
   legacy body limits until the old-client window has passed.
4. **Compaction in `shadow` mode** (phase 5): enable the compactor; it keeps
   every source row. Deploy the dual-format readers and exports (phase 7) and
   compare their output on live versus compacted attempts.
5. **Benchmark** (phase 8) on staging from a separate machine, never against
   production; size the global budgets and publish the envelope
   ([benchmark.md](benchmark.md), [capacity.md](capacity.md)).
6. **`replace` canary**, only after a recorded [policy](#retention-policy), a
   passed mixed-format restore drill and a recorded
   [rollback floor](#rollback-floor): `COMPACTION_MODE=replace` with a small
   `COMPACTION_REPLACE_LIMIT`, then widen while verification, intake latency,
   backlog and disk stay healthy.
7. **Retention**, archive deletion or receipt expiry: separate policy
   decisions, dry runs first.

Microbatching (`MICROBATCH_WINDOW_MS`) stays off unless the benchmark shows
single-event requests are the bottleneck.

## Releases, canary and rollback

CI ([`.github/workflows/telemetry-release.yml`](../../.github/workflows/telemetry-release.yml))
runs the unit, integration (PostgreSQL) and Python tests, `npm audit` for
runtime dependencies (fails on high), migrates a fresh database, provisions and
verifies the roles, boots the collector as `telemetry_writer` and smoke-tests
v1, v2 and feedback, then builds the image, smoke-tests the image itself
read-only and unprivileged, scans it with a digest-pinned Trivy (fails on
fixable high/critical) and pushes only `sha-<full commit>` (and the tag name
for `v*` tags). There is no `latest`. The run summary prints the exact
`COLLECTOR_IMAGE=...@sha256:...` line.

Base images are pinned by exact version (`node:22.23.2-alpine3.24`,
`postgres:17.10-alpine3.24`). To pin digests as well, append
`@sha256:<index digest>` from `docker buildx imagetools inspect <tag>`.
Review base-image and dependency updates like code changes.

### Release procedure

1. Read the release's changes: new migrations? storage-format change? new
   grants (tools/verify-permissions.js changes with them)?
2. If it has migrations, take a [backup](#backups) first.
3. Note the running image (`docker compose images collector`) as the rollback
   target, then set `COLLECTOR_IMAGE` in `.env` to the new tag and digest.
4. `docker compose pull collector migrate` and
   `docker compose run --rm migrate`. Migrations are additive and must keep the
   running (older) collector working; older collectors tolerate newer ledger
   entries.
5. `docker compose run --rm verify-permissions`.
6. **Canary** (when memory allows; it doubles the collector's pool and
   in-process limits for its duration): start a second collector from the new
   image next to the old one and send it a share of the traffic:
   ```sh
   docker compose run -d --rm --name telemetry-canary collector
   ```
   In the Caddyfile, change both `reverse_proxy collector:8080 {` lines to
   `reverse_proxy collector:8080 telemetry-canary:8080 {` and add
   `lb_policy round_robin` inside them, then
   `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`.
   Watch the gates below for at least 30 minutes of normal traffic.
7. **Switch**: `docker compose up -d --wait collector` (recreates the main
   collector with the new image; draining, see below), revert the Caddyfile
   and reload, then `docker stop telemetry-canary` (it drains too). Update the
   compactor if it runs: `docker compose --profile compactor up -d compactor`.
8. Re-run `ops/smoke-test.sh` against the public URL.

### Deployment gates

Stop and roll back when any of these holds for the new version (canary or
switched):

| Gate | Signal |
| --- | --- |
| Crashes | container restart count rises (`docker inspect -f '{{.RestartCount}}'`), `telemetry_http_requests_total{status="500"}` grows, process exits in `docker compose logs` |
| Acknowledgement mismatch | accepted events not found in the database: over a window, the increase of `telemetry_events_total{outcome="accepted"}` (all collectors) should match new rows (steps by `received_at`, completions by `completion_received_at`, new attempts with a recorded start) within a small tolerance; `telemetry_events_total{outcome="dropped"}` and client-reported `telemetry_client_health_total{counter="rejected"}` do not jump |
| Pool waits / overload | p99 of `telemetry_pool_acquire_seconds` and `telemetry_writer_queue_wait_seconds` well under 0.5 s; no sustained `telemetry_requests_rejected_total{reason=~"queue_full|queue_timeout|inflight_full|db_unavailable|deadline"}`; `telemetry_event_loop_lag_seconds{stat="p99"}` under 0.1 s |
| Compaction | zero verification failures; eligible backlog age not growing (metric names in [compaction.md](compaction.md)) |
| Disk pressure | `telemetry_disk_utilization_ratio` below 0.70 and not stepping up after the release |
| Latency (targets to validate, not promises) | p95 acknowledgement < 250 ms, p99 < 1 s from `telemetry_http_request_duration_seconds` |

A SQL helper for the acknowledgement gate, run read-only inside the database
container (`docker compose exec postgres psql -U lean_telemetry -d lean_telemetry`;
it reads counts only):

```sql
SELECT
  (SELECT count(*) FROM proof_steps WHERE received_at > now() - interval '30 minutes') AS steps,
  (SELECT count(*) FROM proof_attempts WHERE completion_received_at > now() - interval '30 minutes') AS completions,
  (SELECT count(*) FROM proof_attempts WHERE received_at > now() - interval '30 minutes'
     AND start_event_id IS NOT NULL) AS new_attempts_with_start;
```

### Rollback

Set `COLLECTOR_IMAGE` back to the recorded previous tag and digest and
`docker compose up -d collector` (and the compactor). Never "down-migrate":
schema changes are additive and stay; rollback never deletes or reverses
migrated data. The rollback image must be **schema-compatible** (it is, as
long as migrations stay additive) and **storage-format-compatible**:

<a id="rollback-floor"></a>**Rollback floor.** Once the compactor has run in
`replace` mode, some steps exist only inside trajectory chunks. A collector
that predates chunk-aware duplicate checks would accept a retried step as a
new live row, and an exporter or replay reader that predates the dual-format
reader would silently miss compacted steps. From the first `replace` run on,
the oldest valid rollback image is the first release with the chunk-aware
writer and reader (this remediation's release). Record it in `.env` as a
comment (`# ROLLBACK_FLOOR=<image>`) before enabling `replace`, and never roll
back below it. The pre-remediation image is a valid rollback only while no
source rows have been replaced.

## Shutdown and draining

`docker compose stop|restart|up -d` sends `SIGTERM` (through `init`). The
collector then marks itself draining (`/readyz` answers 503, new submissions
get 503 with `Retry-After`), stops accepting connections, closes idle
keep-alive sockets, waits for in-flight requests and their commits for up to
`DRAIN_TIMEOUT_MS` (20 s), destroys what is left (those events stay
unacknowledged and the clients retry them; retries are idempotent), closes the
pool and exits 0. `stop_grace_period` is 30 s, above the drain deadline, so
Docker does not `SIGKILL` a draining collector. Keep
`DRAIN_TIMEOUT_MS < stop_grace_period` if you change either. Avoid
`docker kill`: it skips the drain (acknowledged events are still safe; only
in-flight ones are retried).

The compactor stops at a publication boundary within its 60 s grace period;
an interrupted run leaves shadow chunks that the next run verifies and
publishes or deletes, and never removes unverified source rows. PostgreSQL
stops with a fast shutdown (`SIGINT`, the image's stop signal) and has 60 s for
its shutdown checkpoint.

## Monitoring

### Metrics

The collector serves Prometheus metrics on port 9464 and the compactor on
9465, inside the deployment only: no port is published and Caddy never
proxies them. Ways to read them:

- Ad hoc: `docker compose exec collector wget -qO- http://127.0.0.1:9464/metrics`.
- A scraper container (Prometheus, Grafana Alloy, ...) attached to the
  `telemetry_db` network, scraping `collector:9464` and `compactor:9465`, and
  sending to a monitoring system off the host. Do not publish the metrics
  port; reach dashboards through a VPN or SSH tunnel.

Label sets are bounded (route, status, reason, level); metrics never carry
UUIDs, IP addresses, scripts or feedback text. Also monitor the host itself
(node_exporter: CPU including steal time, memory, disk I/O latency, root
filesystem) and PostgreSQL (`pg_stat_*` views, autovacuum activity, WAL
volume, see `tools/storage-report.js` and [capacity.md](capacity.md)).

Starting alert rules (Prometheus syntax; thresholds are provisional):

```yaml
groups:
  - name: telemetry
    rules:
      - alert: TelemetryNotReady
        expr: telemetry_ready == 0
        for: 2m
      - alert: TelemetryDiskAlert          # 70 %: investigate growth
        expr: telemetry_disk_utilization_ratio >= 0.70
        for: 10m
      - alert: TelemetryDiskThrottle       # 80 %: background work pauses; act now
        expr: telemetry_disk_utilization_ratio >= 0.80
        for: 5m
      - alert: TelemetryDiskPause          # 85 %: intake answers 503; page
        expr: telemetry_disk_utilization_ratio >= 0.85
      - alert: TelemetryServerErrors
        expr: sum(rate(telemetry_http_requests_total{status="500"}[5m])) > 0
        for: 5m
      - alert: TelemetryOverload
        expr: sum(rate(telemetry_requests_rejected_total{reason=~"queue_full|queue_timeout|inflight_full|db_unavailable|deadline"}[5m])) > 0.1
        for: 10m
      - alert: TelemetryPoolWaits
        expr: histogram_quantile(0.99, sum by (le) (rate(telemetry_pool_acquire_seconds_bucket[5m]))) > 0.25
        for: 10m
      - alert: TelemetryBackupStale       # from ops/backup.sh BACKUP_METRICS_FILE
        expr: time() - telemetry_backup_last_stored_timestamp_seconds > 26 * 3600 or telemetry_backup_last_uploaded == 0
```

### External uptime check

Local monitoring dies with the host, so configure a check **from outside the
host** (a hosted uptime service, or a scheduled job on another machine): `GET
https://telemetry.leangame.autumnofautumn.com/readyz` every 1-5 minutes,
expecting status 200 and `"status":"ready"`, alerting after two consecutive
failures, plus TLS certificate expiry. It detects a dead host, Caddy,
collector or database, and disk `pause`. `/readyz` also answers 503 while a
collector drains, so expect a blip during deliberate restarts. Pair it with a
dead-man's switch for backups (for example the upload command pings a
heartbeat URL after a successful upload).

### IPv6

The collector keys IPv6 clients by /64, but only if Caddy sees their real
address. Caddy is published on `[::]:443`; when its Docker network has no IPv6,
Docker's userland proxy accepts IPv6 connections and forwards them over IPv4,
so every IPv6 client appears as the bridge gateway and they all share one rate
limit key. Either enable IPv6 on Caddy's network (`enable_ipv6: true` with a
ULA subnet on the root project's `default` network, Docker 27+ with ip6tables)
so Docker forwards IPv6 natively, or run Caddy with host networking. Verify
with a request from an IPv6 client that `telemetry_rate_limit_keys{scope="ip_requests"}`
gains a key.

## Disk watermarks

The collector and compactor sample the filesystem holding Docker volumes
(including PostgreSQL's data) through the `disk_probe` volume every 15 s
(`DISK_PROBE_PATH=/run/disk-probe`). If PostgreSQL's data ever moves to
another filesystem (for example a Hetzner Volume), set `DISK_PROBE_SOURCE` to
an empty directory on that filesystem.

| Level | Ratio (default) | Automatic effect | Operator action |
| --- | --- | --- | --- |
| `alert` | ≥ 0.70 (`DISK_ALERT_RATIO`) | metrics and alerts only | find the growth (`node tools/storage-report.js`, `docker system df`); plan retention/archive/off-server moves or a bigger disk before the forecast crosses 0.80 |
| `throttle` | ≥ 0.80 (`DISK_THROTTLE_RATIO`) | compactor pauses space-consuming work (shadow compaction, backfill; `replace`, which frees space, continues); `ops/backup.sh` refuses to start (`BACKUP_MAX_DISK_RATIO`); restore drills refuse; exports should not run | free space now: remove old local backup sets and exports, unused images (`docker image prune`), move archives off-server; do not start large maintenance |
| `pause` | ≥ 0.85 (`DISK_PAUSE_RATIO`) | the collector answers 503 (`Retry-After: 300`) to new submissions and acknowledges nothing; `/readyz` is unready, so the external check fires | emergency: free space; clients hold their bounded queues and retry. Never delete PostgreSQL files and never run `VACUUM FULL` (it needs free space equal to the table) |

The 15 % above `pause` is the reserve for WAL, temporary files, autovacuum, a
compaction batch holding old and new representations, and an in-progress
backup: do not plan data into it. A failed probe reports `unknown` and never
blocks intake by itself. Deleting rows does not shrink files immediately;
PostgreSQL reuses the space.

## Backups

[`ops/backup.sh`](../ops/backup.sh) takes a database-aware backup: one
consistent `pg_dump --format=custom` snapshot (live rows, attempt summaries,
trajectory chunks, the migration ledger and grants) plus the role globals, as
`telemetry_backup` (read-only, `pg_read_all_data`). Hetzner server backups and
snapshots are **not** consistent PostgreSQL backups (they are taken from a
running disk and exclude attached Volumes); keep them only as an additional
layer.

Properties:

- **Encrypted before it touches the disk**: every data file goes through
  `BACKUP_ENCRYPT_CMD`; plaintext output is refused unless
  `BACKUP_ALLOW_PLAINTEXT=1` (local tests only). Use a public-key tool so the
  server cannot read old backups: `age -r <recipient>` (private key kept
  offline) or `gpg --encrypt --recipient`. Proof scripts and feedback can hold
  sensitive text; pseudonymous ids and compression are not anonymisation.
- **Checksums**: `SHA256SUMS` of the stored files, and the manifest records the
  plaintext sha256 that the restore drill checks after decryption.
- **Off-server** through `BACKUP_UPLOAD_CMD`, which receives the set directory
  (`rclone copy "$1" ...`, `restic backup "$1"`, `scp -r`). Give the upload
  credential write access only (no delete), and let the storage enforce the
  lifecycle (bucket lifecycle rules, Storage Box snapshots).
- **Never fills the disk**: it estimates the size (previous set's measured
  ratio, else the database size), refuses to start if staging would pass
  `BACKUP_MAX_DISK_RATIO` (0.80), and hard-caps what it writes so usage cannot
  pass `BACKUP_ABORT_DISK_RATIO` (0.84) or `BACKUP_MAX_BYTES`; hitting the cap
  removes the partial set. Local staging keeps `BACKUP_KEEP_LOCAL` (1) sets; a
  set that never reached off-server storage is not deleted.
- The password reaches the throwaway `pg_dump` container on stdin, never on a
  command line, in container configuration or in a file inside it.

Schedule it at low traffic with a systemd timer (or cron), configured in a
root-only environment file:

```ini
# /etc/systemd/system/telemetry-backup.service
[Service]
Type=oneshot
EnvironmentFile=/etc/telemetry-backup.env      # mode 0600
ExecStart=/root/opt/lean4-wasm-in-browser/telemetry/ops/backup.sh
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7

# /etc/systemd/system/telemetry-backup.timer
[Timer]
OnCalendar=*-*-* 03:30:00 UTC
RandomizedDelaySec=15m
Persistent=true
[Install]
WantedBy=timers.target
```

```sh
# /etc/telemetry-backup.env
BACKUP_DIR=/root/backups/telemetry
BACKUP_DOCKER_NETWORK=telemetry_db
BACKUP_PGPASSWORD_FILE=/root/opt/lean4-wasm-in-browser/telemetry/secrets/telemetry_backup_password
BACKUP_ENCRYPT_CMD=age -r age1...
BACKUP_ENCRYPTED_SUFFIX=.age
BACKUP_UPLOAD_CMD=rclone copy "$1" offsite:telemetry/$(basename "$1")
BACKUP_METRICS_FILE=/var/lib/node_exporter/textfile/telemetry_backup.prom
```

A dump holds one snapshot open for its duration, which delays vacuum cleanup
on busy tables; run it when traffic is low and watch its duration as the
database grows.

### Recovery point objective (choose explicitly)

| Option | Data lost after host loss | Cost |
| --- | --- | --- |
| Nightly `ops/backup.sh` (starting point) | up to ~24 h plus upload time | one full dump per day; simple |
| Dumps every N hours | up to N h | full dump each time; grows with the database |
| Continuous WAL archiving + base backups (pgBackRest or WAL-G to object storage) | minutes | archive monitoring, retention of base backups and WAL, point-in-time-recovery drills |
| Zero loss of acknowledged events after host failure | — | not achievable on one host: needs synchronous replication to independent storage or a second database host |

Record the choice and the backup lifecycle (for example 14 daily, 8 weekly, 6
monthly) next to the [retention policy](#retention-policy): backups keep data
that retention later deletes, so their lifecycle bounds how long deleted data
really persists. Archives written by `src/jobs/archive.js` follow the same
recovery objective and need their own off-server copies and drills.

## Restore drills

[`ops/restore-test.sh`](../ops/restore-test.sh) restores a backup set into a
uniquely named throwaway PostgreSQL container (never the production one) and
verifies it:

1. `SHA256SUMS` of the stored files; decryption straight into the container;
   plaintext checksum against the manifest.
2. A cluster bootstrapped with the source's superuser name (manifest
   `bootstrap_superuser`), the globals (roles, settings, memberships), then
   `pg_restore --create --exit-on-error`.
3. `node src/migrate.js --check`: the schema matches this release.
4. One-time random passwords for the runtime roles, then
   `tools/verify-permissions.js` against the restored copy.
5. Row counts between the counts recorded just before and after the dump,
   including **logical steps** (live rows + steps held only in compacted
   chunks), so mixed live/compacted data must be complete.
6. `tools/verify-chunks.js` decodes and verifies every trajectory chunk.
7. The container and its network are removed (keep them with `RESTORE_KEEP=1`).

Run it monthly, after every migration or storage-format change, and before
enabling any destructive setting. Prefer a separate machine (it needs Docker,
this checkout with `npm ci` or `RESTORE_TOOLS=image` with the release image,
and the decryption key, which should not live on the production host). On
the production host it refuses when the restore could push the disk past 0.80.

```sh
RESTORE_DECRYPT_CMD='age -d -i ~/telemetry-backup-key.txt' ops/restore-test.sh /path/to/telemetry-20261012T033000Z
```

For mixed-format confidence beyond counts and decoding, export a sample of
attempts from the restored copy (`tools/export.js` against the drill
container, `RESTORE_KEEP=1`) and compare them with the same attempts exported
from production.

**Disaster recovery** on a new host: install Docker, create the volume and
secrets (new superuser password), start `postgres` with the **same
`POSTGRES_USER`** as the source (the manifest's `bootstrap_superuser`,
`lean_telemetry` in production: PostgreSQL 16+ records role grants as granted
by that superuser and only a bootstrap superuser of that name can replay
them), apply the set's `globals.sql` with `psql` as that superuser
(`role ... already exists` for the superuser itself is expected),
`pg_restore -d postgres --create --exit-on-error` the dump, run `docker compose run --rm migrate` (new role
passwords), `verify-permissions`, start the collector, attach Caddy, update
DNS. Restore archive storage alongside if it is used. Expect data loss back to
the last off-server backup.

## Retention policy

Every destructive setting is off by default: `COMPACTION_MODE=shadow` keeps
source rows; the retention job is a dry run with every window unset; archives
never delete local data; backups are only pruned locally once uploaded.
Before enabling **any** of the following, record a decision with this
template (in the repository's issue tracker or ops log) and refer to it by id
(`RETENTION_POLICY_ID`):

- `COMPACTION_MODE=replace` (removes verified source rows),
- `node src/jobs/retention.js --execute` with any `RETENTION_*_DAYS`,
- receipt expiry (`RETENTION_RECEIPT_DAYS`),
- deleting local detail after archiving, or shortening backup/archive lifecycles.

```
Policy id:            telemetry-retention-YYYY-NN
Decided on / by:      <date> / <people>
Scope:                which settings this enables, from which release
Recent live-row window:            <days> (COMPACTION_MIN_AGE_SECONDS / replace delay)
Compressed full-path window:       <days or "indefinite"> (RETENTION_DETAIL_DAYS)
Attempt and completion summaries:  <days or "indefinite"> (RETENTION_ATTEMPT_DAYS)
Feedback reports:                  <days or "indefinite"> (RETENTION_FEEDBACK_DAYS)
Duplicate receipts:                <days> (RETENTION_RECEIPT_DAYS); must exceed the
                                   longest client retry age and LATE_EVENT_MAX_AGE_DAYS
Off-server archive:                location, encryption, lifecycle, who can read it
Backups:                           RPO choice, lifecycle, location
Consent / legal basis:             what players were told; deletion requests
Evidence:                          storage forecast (tools/storage-report.js), dry-run
                                   output reviewed, compaction verification clean for N days,
                                   restore drill of mixed live/compacted data passed on <date>,
                                   dual-format exports/replays released, rollback floor recorded
Irreversible effects:              what cannot be recovered after the first run
Review date:
```

Seven days of full detail is a candidate to price against measured sizes, not
an automatic choice. Sampling is a later, separate decision and must keep
whole attempts together.

## Resource budget

Starting point for the 4 vCPU / 8 GB (7.6 GiB usable) / 160 GB (150 GB
filesystem) host, to be revised from measurements
([capacity.md](capacity.md), [benchmark.md](benchmark.md)).

| Consumer | Memory | CPU | Notes |
| --- | --- | --- | --- |
| PostgreSQL | limit 4.5 GiB (`POSTGRES_MEMORY_LIMIT`) | ≤ 3 | `shared_buffers` 1 GB, `effective_cache_size` 3 GB, `work_mem` 8 MB, `maintenance_work_mem` 256 MB, `autovacuum_work_mem` 128 MB, `max_connections` 40, `temp_file_limit` 4 GB per process, `max_wal_size` 2 GB, one parallel worker per gather; fsync and synchronous commit unchanged; the cgroup limit also bounds its page cache |
| Collector | 640 MiB, V8 heap 384 MiB | ≤ 2 | pool of 4; in-flight bodies ≤ 64 × 512 KiB plus a 16 MiB accounted queue |
| Compactor | 384 MiB, heap 192 MiB | ≤ 1, low CPU shares | one worker, own small pool, duty-cycled, pauses under intake pressure |
| Caddy | recommend `mem_limit: 256m` in the root project | — | |
| Transient jobs | exporter 512 MiB, `pg_dump` client 512 MiB, migrate 256 MiB | low shares | not concurrently with peak traffic; heavy exports and replays belong on another machine |
| OS, Docker, page cache outside cgroups | the remaining ~1.3-2 GiB | — | |

CPU limits are ceilings, not reservations; CPU shares give the collector and
PostgreSQL priority over the compactor and tools.

Disk budget (decimal GB, measure every term):

```
recent live rows + retained compacted chunks + summaries/receipts/indexes
+ WAL (≤ max_wal_size, more during bursts) + temporary files
+ OS, images, container logs (5 × 10 MB per container)
+ backup staging (one compressed dump) + compaction/backfill headroom
+ 15 % reserve above the pause watermark (≈ 22 GB)
```

Large unused images count too (`docker system df`). Run `tools/storage-report.js`
for measured table, index, TOAST and WAL growth and days-remaining forecasts.

## Single-host limitations

- A host, disk, Docker daemon or kernel failure stops collection and loses
  everything since the last off-server backup (the RPO). Clients hold bounded
  queues and retry, but nothing is collected while the host is down.
- PostgreSQL restarts and upgrades, and Docker or OS updates, interrupt intake
  briefly; plan them, and expect clients to retry.
- The canary shares the host's CPU, memory, disk and database with the live
  collector; it tests the new code, not more capacity.
- Rate limits and admission bounds are per process; a second collector doubles
  them unless enforcement is shared.
- Another container on the same host is not redundancy. Strict uptime or zero
  loss of acknowledged events after host failure needs independent database
  durability (replication or a managed database) and a second host.
- Shared vCPU plans can be slowed by neighbours: watch CPU steal time and I/O
  latency, not just CPU percentage.
- Move heavy exports, replay extraction, builds and load generation off this
  host; benchmark from a separate machine ([benchmark.md](benchmark.md)).
