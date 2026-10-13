# Exports and replay extraction

Plan phase 7. Three export formats from one streaming exporter
(`tools/export.js`), and replay extraction from the CSV
(`extract-replays.py`). Both read live rows and compressed trajectory chunks
through the shared reader, so compacted, live and mixed attempts export
identically.

## Running an export

```sh
# From the telemetry directory on a machine that can reach the database:
DATABASE_URL='postgresql://telemetry_reader:...@host/lean_telemetry' ./export-telemetry.sh out.csv
# On the server, through Compose (profile "tools", role telemetry_reader):
./export-telemetry.sh out.csv --since 2026-10-01 --until 2026-10-08
```

The output extension selects the format. Options pass through to
`tools/export.js`:

| Option | Meaning |
| --- | --- |
| `--format csv\|jsonl\|xlsx` | set by the extension when using the wrapper |
| `--since ISO`, `--until ISO` | attempts by trusted activity time (`last_received_at`, else `received_at`, else migration 005's `applied_at`); feedback by `received_at` |
| `--game GAME_ID` | one game |
| `--attempt UUID` (repeatable) | specific attempts (no feedback) |
| `--no-feedback` | attempts only |
| `--resume` | continue an interrupted csv/jsonl export (same options) |
| `--users-per-page N` | checkpoint granularity (default 200) |

The exporter writes `OUT.partial`, renames it to `OUT` when complete and
writes `OUT.manifest.json` (filters, counts, attempts with reader errors or
incomplete trajectories). After every page of users it syncs the file and
records `OUT.checkpoint.json`; `--resume` truncates the partial file to the
last checkpoint and continues, so an interrupted export has no duplicate or
missing rows. Incremental exports: use consecutive `--since`/`--until`
windows; an attempt with new activity appears again in the later window with
all of its steps.

## Formats

**CSV (machine export, lossless for its fields).** The same 29 columns and
field meanings as before: one `attempt` row per attempt (scripts and
attributes), one `step` row per accepted step, one `feedback` row per report;
every row carries its user's first/last seen and the attempt's
game/level/mode/timing columns. PostgreSQL text conventions are kept exactly:
NULL is an empty field and an empty string is `""`, booleans are `t`/`f`,
timestamps are UTC (`2026-08-04 12:00:00.123+00`), JSON is PostgreSQL's jsonb
text. The integration tests compare every record with the previous
`psql COPY` export.

Row order changed: users in user-id order (not first-seen order); each
user's attempts by start time, each followed by its steps in sequence order;
then the user's feedback by receipt time; feedback without a user last. This
uses indexes instead of sorting every retained proof on the intake database.
Every row is self-describing, and `extract-replays.py` accepts both orders.

**Do not open the CSV in a spreadsheet application.** Proof text can begin
with `=`, `+`, `-` or `@` and would be treated as a formula. The machine
export never alters stored text to prevent that.

**JSONL (machine export, every field).** One object per attempt
(`"type":"attempt"`, with its steps, start/completion identities, later
completion sequences, trusted ingestion times, `detail_expired_at`, reader
completeness and errors) or feedback report (`"type":"feedback"`, with the
proof state as JSON). Use it when replay completeness or identities matter.

**XLSX (human export).** The CSV's rows in a workbook where every cell is an
inline string with the Text number format: formula-like values stay text and
are never evaluated, and nothing stored is modified. Spreadsheet limits are
explicit: a cell over 32,767 characters is cut and ends with a marker pointing
to the machine export (the manifest counts such cells); more than 1,048,575
rows continue on additional sheets; a workbook over about 4 GiB is refused —
narrow the export with filters. Characters XML cannot carry are written as
`_xHHHH_` escapes, which spreadsheet applications decode.

## Load and privacy

The exporter runs as `telemetry_reader`: read-only transactions,
`statement_timeout` 60 s, `work_mem` 16 MB, `temp_file_limit` 1 GB, one
connection, low CPU priority. Memory is bounded per attempt (the reader's
limits) and does not grow with the database (tested with a 32 MB heap).
Even so, a full export competes with intake: prefer filtered exports, quiet
hours, or a restored backup on another machine for full extracts.

Exports contain pseudonymous user ids, proof scripts and free-text feedback.
Keep them private and delete them when no longer needed; pseudonymous is not
anonymous. Users who refused telemetry have no rows (feedback without consent
has no user id).

## Replay extraction

```sh
python3 extract-replays.py out.csv replays/ [--resume] [--proof-after full|checkpoints|none]
  [--checkpoint-every N] [--max-steps N] [--max-replay-bytes N] [--oversize skip|checkpoints]
```

The replay format (`lean-game-replay/1`), validation rules, phantom-step
handling, attempt numbering and feedback linkage are unchanged; the tests
check byte-identical replays against the previous version. What changed:

- The CSV is streamed one user at a time (both export orders group a user's
  rows); input that is not grouped by user is refused rather than misread.
- Per-attempt bounds: attempts with more than `--max-steps` steps, or whose
  reconstructed proofs exceed `--max-replay-bytes`, are skipped with a reason
  — or, with `--oversize checkpoints`, written with `proof_after` only every
  `--checkpoint-every` steps and marked `"oversize": true`.
- `--proof-after checkpoints|none` writes `proof_after` only at checkpoints
  or not at all, marked by `proof_after_mode`; the default (`full`) keeps
  today's output.
- Malformed historic rows are reported per attempt in `index.json`, not fatal.
- Replay files are written atomically; `manifest.jsonl` is written as the run
  progresses and `index.json` (same format, lists in input order) at the end.
  `--resume` leaves replays whose content is unchanged untouched.

Run extraction on a workstation, not on the collector host.
