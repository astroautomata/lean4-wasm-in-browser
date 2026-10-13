# lean-trajectory/1

A versioned, lossless encoding of a bounded, ordered set of one proof
attempt's steps. Reference implementations: `src/trajectory/codec.js`
(encoder and decoder) and `tools/trajectory_codec.py` (decoder, standard
library only; archives carry a copy).

## Stored form

A chunk is a gzip member (RFC 1952) whose uncompressed bytes are UTF-8 JSON:

```json
{"format":"lean-trajectory/1",
 "attempt_id":"505300ff-0847-48eb-994b-7e834f938c4e",
 "count":3,
 "columns":["sequence","elapsed_ms","step_type","command","from_line",
            "removed_lines","event_id","client_ts_us","received_at_us","attributes"],
 "base":{"sequence":1,"elapsed_ms":1234,"client_ts_us":1786017600123000,"received_at_us":1786017600456789},
 "rows":[[0,0,0,"rw [add_zero]",null,null,"d707e185136e4f54bca8e1aaffbbe396",0,0,0],
         [1,850,1,"undo",null,null,"0b8c7b5231a44c559d436b0f2b7f7c11",850000,null,0],
         [3,4000,2,"| zero => rfl",3,0,"9d1f7a567fd24f0a8f6c0b1d2e3f4a5b",4000123,544000,{"phantom":true}]]}
```

Rows are ordered by strictly increasing `sequence`; gaps are allowed and
meaningful (a missing action, or a sequence held by the start or a
completion). Each row is a tuple in `columns` order:

| # | Column | Encoding |
| --- | --- | --- |
| 0 | `sequence` | difference from the previous row's sequence (first row: from `base.sequence`, so 0); > 0 after the first row |
| 1 | `elapsed_ms` | difference from the previous row (may be negative) |
| 2 | `step_type` | 0 `command`, 1 `undo`, 2 `edit`, 3 `reset` |
| 3 | `command` | exact string as stored (may be empty) |
| 4, 5 | `from_line`, `removed_lines` | integer or null (null for non-edit steps) |
| 6 | `event_id` | 32 lowercase hex digits (the UUID without dashes) |
| 7 | `client_ts_us` | difference from the previous row, integer microseconds |
| 8 | `received_at_us` | null when the row's ingestion time is unknown (ingested before migration 005); otherwise the difference from the previous non-null value (initially `base.received_at_us`) |
| 9 | `attributes` | `0` for `{}`, otherwise the JSON object |

Timestamps are integer microseconds since the Unix epoch, PostgreSQL's own
`timestamptz` resolution: nothing is rounded. All integers stay within
JavaScript's safe range.

## Manifest

Stored beside the payload (`trajectory_chunks` columns; `chunk-<id>.json` in
archives):

| Field | Meaning |
| --- | --- |
| `format`, `codec` | `lean-trajectory/1`, `gzip` |
| `attempt_id` | the attempt; must equal the payload's |
| `event_count` | rows in the payload |
| `seq_first`, `seq_last` | first and last row's sequence |
| `uncompressed_bytes` | exact length of the JSON bytes |
| `checksum` / `checksum_sha256` | sha256 of the uncompressed bytes |
| `compressed_bytes`, `compressed_sha256` (archive) | payload length and hash |
| `kind` | `base` (first chunk of the attempt) or `delta` (late actions) |
| `receipt_event_ids` (database) | the payload's event ids, for duplicate detection; NULL only after an explicit receipt-expiry policy |

## Decoding rules

A decoder must reject (never repair) a chunk when the format or codec is
unknown; the compressed size, declared uncompressed size or event count exceed
its limits (defaults 4 MiB, 4 MiB, 2000); the payload would inflate beyond the
declared size (stop inflating at that size: decompression-bomb protection);
the length or sha256 differ; the JSON is not UTF-8 or not of the shape above;
any row is malformed or decodes to an invalid action (negative or non-int32
sequence/elapsed/edit coordinates, unknown step type); or the decoded sequence
range or count differs from the manifest.

## Versioning

The format string is the version. A change to the row layout, delta rules,
codec or limits semantics is a new format (`lean-trajectory/2`) with:

1. a decoder in both reference implementations, shipped and deployed before
   any writer produces it (readers first);
2. `format`-dispatching decoding, keeping `/1` readable for as long as any
   chunk or archive in that format exists;
3. round-trip tests against `/1` chunks and mixed `/1` + `/2` attempts;
4. an update of this document and of `FORMAT.md` in new archives.

Never rewrite stored chunks in place; re-encoding is a new chunk published
through the normal verify/publish lifecycle.
