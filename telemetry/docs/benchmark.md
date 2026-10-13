# Benchmarking the collector

Plan phase 8. The goal is a published, measured operating envelope for this
server, not a user-count claim. Nothing in this repository has been
benchmarked yet: the tools below exist and are tested at harmless rates; the
measurements must be made as described here.

## Rules

- Generate load from a **separate machine**. The collector host must not be
  its own load generator.
- Target a **staging** stack: the same images, Compose file and Caddy
  configuration as production, on the same server family, with a staging
  database restored or generated to the expected retained size. Never load-test
  production users or replay real user data into a production collector.
  `bench/loadgen.js` refuses the production hostname and requires
  `--target-is-staging` for any non-local target.
- Go through Caddy (TLS, the client-IP header, request size limits) so the
  measured path is the real one. Expect every request to come from one source
  address: that is the NAT-cohort case, and per-IP budgets may need raising on
  staging for pure throughput steps (record it).
- Watch CPU steal time (`vmstat 1`, `mpstat -P ALL 1`) and I/O latency
  (`iostat -x 1`) as well as CPU percentage. Hetzner's shared-vCPU plans are
  burst-oriented; repeat runs at different times of day.
  <https://docs.hetzner.com/cloud/servers/faq/>
- Stop a step as soon as it is unsafe (sustained 5xx, growing latency, memory
  or disk pressure). Bounded memory and fast, explicit rejection matter more
  under overload than latency targets.

## Tools

```sh
# On the load machine (Node 22, a checkout of this directory):
node bench/loadgen.js --target https://telemetry-staging.example --origin https://leangame.autumnofautumn.com \
  --scenario bench/scenarios/ramp-client-batching.json --target-is-staging --out results/ramp-1
# With read-only access to the staging database:
READER_DATABASE_URL=postgresql://telemetry_reader:...@staging/lean_telemetry node bench/verify.js results/ramp-1
READER_DATABASE_URL=... node tools/storage-report.js --wal-sample-seconds 300 --disk-path /var/lib/docker
```

- `bench/loadgen.js` issues requests on a Poisson schedule regardless of
  responses (open loop) and records, per phase, achieved request/event rates,
  latency p50/p95/p99/max, status counts, `Retry-After` values, v2 outcomes,
  fault outcomes, and requests skipped at its own concurrency cap. Every
  acknowledged event goes to `acks.jsonl` with a content hash; sent but
  unacknowledged events to `unacked.jsonl`. It does not retry.
- `bench/verify.js` checks every acknowledged event is stored exactly once
  with identical content (live or compacted), and counts events stored
  although unacknowledged (expected after client timeouts) and incomplete
  replays. Run it after every scenario, not just the HTTP success rate.
- Payloads are synthetic, sized from `bench/profiles/*.json`: aggregate
  quantiles of command/script sizes, step counts and the visual/classic mix
  from a small October 2026 sample that is almost entirely visual. Derive a
  current profile from a recent export before a real run, and use
  `profile_overrides` for classic-heavy cases.
- Collector metrics (`/metrics` on port 9464), compactor metrics (9465) and
  the host's own metrics should be scraped throughout.

## Scenario matrix

| Scenario file | Covers |
| --- | --- |
| `ramp-client-batching.json` | 10, 100, 250, 500, 1000, 2000 events/s with realistic client batches |
| `ramp-single-event.json` | the same with one event per request |
| `burst.json` | a short 2-5x burst over nominal, then recovery time |
| `reconnect-storm.json` | thousands of clients flushing backlogs within seconds |
| `hot-user-and-nat.json` | one source address, one hot pseudonymous user |
| `faults.json` | duplicate resends, conflicting id reuse, overlarge, trickled and truncated bodies |
| `mixed-clients.json` | v1 and v2 clients together, classic-heavy mix |
| `soak.json` | nominal rate for hours through autovacuum, compaction, a backup and an export |
| `smoke.json` | harness check only |

Run these additionally, by hand, during load (each followed by `verify.js`):

- dependency outage: `docker compose stop postgres` for 60 s, then start;
  expect prompt 503s with `Retry-After`, no crash, recovery;
- database and collector restarts, and a deployment drain (`docker compose
  up -d collector` with a new image): acknowledged events must all be present;
- compaction in `replace` mode during load, with post-compaction retries
  (`faults.json` resends previously acknowledged batches), late and
  out-of-order actions, incomplete attempts and very long attempts;
- compactor killed (`docker kill`) at random points: `tools/verify-chunks.js`
  must pass afterwards and no action may be missing;
- a corrupted chunk on a disposable copy: readers and `verify-chunks.js` must
  report it;
- old-client compatibility (`mixed-clients.json`, and the previous client
  build against the new collector);
- a mixed live/compacted backup restore (`ops/restore-test.sh`) and a
  format-compatible rollback rehearsal (docs/operations.md).

## Storage comparison

On a representative dataset, compare compaction off with compaction in
`replace` mode: run `tools/storage-report.js --exact` before and after and
compare the **whole** retained footprint (all tables, indexes, TOAST,
receipts, attempt summaries, feedback), WAL generated, codec CPU
(`telemetry_compaction_cpu_seconds_total`), decode cost (export/replay time),
ingestion latency while compacting, sustained compaction throughput versus
incoming eligible rows, and peak transient disk use. Test at both the
recent-row and the expected compacted retention sizes, and run long enough to
see maintenance behaviour. Exercise source replacement and a simulated
retention/archive cycle on disposable staging data only.

## Success targets (validate, do not promise)

At the chosen nominal workload: p95 acknowledgement under 250 ms, p99 under
1 s, essentially no unexpected 500s, and zero known loss of acknowledged
events through tested process restarts. Under deliberate overload: bounded
memory and queues and fast, explicit 429/503 rejection take priority over the
latency targets.

Set the public capacity below the sustainable result with at least roughly
30 % resource headroom, then show that a short 2-5x burst produces controlled
rejection rather than a crash or a growing backlog, and measure the recovery
time and the client retries it causes. Adjust headroom to the measured
variability.

## Publishing the envelope

Publish a filled-in copy of this table with the date, images and machine:

| Item | Measured value |
| --- | --- |
| Machine family, vCPU type (shared/dedicated), RAM, disk | |
| Image revisions (collector, PostgreSQL), configuration changes from defaults | |
| Sustained event rate (events/s) and request rate (requests/s) | |
| Average and p99 event bytes; batch-size distribution | |
| p50/p95/p99 acknowledgement latency at that rate | |
| Burst tested (multiple, duration) and recovery time | |
| Rejection/drop policy observed (429/503 rates, client retries) | |
| Recent-row window, compressed-path retention, archive policy | |
| Measured total bytes per attempt and per action (live, compacted) | |
| Compaction throughput (actions/s) versus incoming eligible actions | |
| Retained size at the end of the soak; forecast days to 70/80/85 % disk | |
| Recovery objectives (RPO/RTO) and backup method | |

A statement such as "supports 20,000 users" without these conditions is not
a useful guarantee.
