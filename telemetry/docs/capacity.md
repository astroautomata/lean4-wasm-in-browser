# Capacity and storage outlook

For the current server: 4 vCPUs, 8 GB RAM, 160 GB local disk, 20 TB
outbound traffic. Server family, CPU sharing and other workloads are not
established. Everything below is planning arithmetic to be replaced by
measurements (`tools/storage-report.js`, `docs/benchmark.md`); none of it is
a capacity certification.

## Workload

```
events/second = concurrent visitors × consenting fraction × active fraction × events per active player per second
```

20,000 concurrently active players at one event per ten seconds give 200
events/s at 10 % participation, 1,000 at 50 % and 2,000 at 100 %.
Participation means telemetry is enabled and the player is producing events
at that rate; classic typing may produce a different rate. Express capacity in
events/s, requests/s, bytes/s, retained bytes/day and tested burst duration —
not in users.

## Storage

**Uncompacted baseline** (planning assumption: 500 bytes per stored step
including its share of indexes; 1,000 bytes doubles every figure; decimal GB;
WAL, backups, logs and the OS are extra):

| Sustained events/s | Step rows/day | Step storage/day | Seven days |
| ---: | ---: | ---: | ---: |
| 10 | 864,000 | 0.43 GB | 3.0 GB |
| 100 | 8.64 million | 4.32 GB | 30.2 GB |
| 500 | 43.2 million | 21.6 GB | 151.2 GB |
| 2,000 | 172.8 million | 86.4 GB | 604.8 GB |

A one-hour burst at 2,000 events/s creates 7.2 million rows (3.6-7.2 GB).
The recent-row window and a stalled compactor can fill the host even when
sealed histories are small.

**Compressed actions.** The local sample (docs/compaction.md) measured 63.6
compressed bytes per action as stored in this format (68.8 with ingestion
times), before receipts, chunk rows and attempt summaries. At an illustrative
70 bytes per action:

| Sustained actions/s | Compressed payload/day | Seven days | Thirty days |
| ---: | ---: | ---: | ---: |
| 10 | 0.06 GB | 0.42 GB | 1.8 GB |
| 100 | 0.60 GB | 4.2 GB | 18.1 GB |
| 500 | 3.0 GB | 21.2 GB | 90.7 GB |
| 2,000 | 12.1 GB | 84.7 GB | 362.9 GB |

Compression improves the outlook substantially; it does not make indefinite
retention fit on 160 GB at high sustained rates. Add attempt context and
scripts, chunk rows and receipts (`receipt_event_ids` and its GIN index),
summaries, feedback, the recent uncompressed window, WAL, backups/logs and
temporary old/new copies during compaction.

## Disk budget

```
recent-row footprint + retained compacted paths + summaries/receipts/indexes
  + WAL + OS/images/logs + backup staging + peak compaction/backfill headroom
```

Fill it from `tools/storage-report.js --exact --wal-sample-seconds 300
--disk-path <docker data root>` on representative data: it reports every
relation's heap/index/TOAST bytes, bytes per live step and per compacted
action, last-day growth from trusted ingestion times, the WAL rate, free space
and the days to the 70/80/85 % watermarks at the current and a peak rate.
Include the backlog that builds while compaction is paused, and a bounded
catch-up time. Choose recent-row, compressed-path and archive windows only
after this total and a representative mixed classic/visual workload have been
measured (docs/compaction.md "Retention").

Memory: about 2 GB for the OS, cache, Caddy and headroom; 4-5 GB for
PostgreSQL (`shared_buffers` around 1 GB, modest `work_mem`, bounded
connections and temporary files, autovacuum on); 0.5-0.75 GB for the
collector; a small budget for the compactor. These are the Compose defaults;
adjust from measured RSS and cache behaviour.

## Practical outlook

- **Tens to low hundreds of events/s**: a credible initial target after the
  hardening and bulk writes, subject to the benchmark.
- **Several hundred events/s**: plausible processing territory to test,
  with ingestion, compaction and maintenance together. Move older complete
  trajectories off-server or enlarge storage before the forecast crosses the
  disk reserve.
- **Thousands of events/s**: do not promise this on this server.
- **Strict uptime or no loss of acknowledged events after host failure**: one
  machine cannot provide it at any throughput; add independent database
  durability/failover and test recovery.

## Scaling by bottleneck

- CPU or steal time limits throughput → dedicated vCPUs or a larger machine.
- Storage growth dominates → off-server archives and an explicit detail
  window, not more collectors.
- Database I/O or maintenance dominates → PostgreSQL on an appropriately
  provisioned host; a larger collector pool does not help.
- Bursts exceed processing and the events must be kept → a bounded,
  independent durable queue with an explicit storage and catch-up budget. A
  queue does not make sustained production faster than consumption.
- A second collector process only when the first is demonstrably CPU-bound
  while the database and host have headroom; its limits and pools add up
  unless coordinated (rate limits are per process).
