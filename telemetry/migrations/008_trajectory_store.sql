-- Versioned, lossless, compressed per-attempt trajectory chunks
-- (docs/trajectory-format.md). Each chunk holds a bounded, ordered set of one
-- attempt's proof steps. Chunks are immutable once published; late steps become
-- new 'delta' chunks. Readers merge published chunks with live proof_steps rows.
--
-- state 'shadow'    built and verified; the source rows remain authoritative.
-- state 'published' authoritative; source rows may then be removed (exactly the
--                   verified set, recorded by sources_removed_at).
CREATE TABLE IF NOT EXISTS trajectory_chunks (
  chunk_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES proof_attempts(attempt_id) ON DELETE CASCADE,
  format text NOT NULL,
  codec text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('base', 'delta')),
  state text NOT NULL DEFAULT 'shadow' CHECK (state IN ('shadow', 'published')),
  seq_first integer NOT NULL,
  seq_last integer NOT NULL,
  event_count integer NOT NULL,
  uncompressed_bytes integer NOT NULL CHECK (uncompressed_bytes > 0),
  compressed_bytes integer NOT NULL CHECK (compressed_bytes > 0),
  checksum bytea NOT NULL CHECK (octet_length(checksum) = 32),
  payload bytea NOT NULL,
  -- Deduplication receipts: the event_ids inside the payload, indexed so a
  -- retried step is recognised after its live row is gone. NULL only after an
  -- explicit receipt-expiry policy ran; the payload still holds the ids.
  receipt_event_ids uuid[],
  min_source_received_at timestamptz,
  max_source_received_at timestamptz,
  -- Some source rows predate migration 005 (unknown ingestion time).
  historic_sources boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  sources_removed_at timestamptz,
  CHECK (seq_first <= seq_last),
  CHECK (event_count > 0 AND event_count <= seq_last - seq_first + 1),
  CHECK ((state = 'published') = (published_at IS NOT NULL)),
  CHECK (sources_removed_at IS NULL OR state = 'published'),
  CHECK (compressed_bytes = octet_length(payload))
);
-- The payload is already compressed; store it out of line without pglz.
ALTER TABLE trajectory_chunks ALTER COLUMN payload SET STORAGE EXTERNAL;

CREATE INDEX IF NOT EXISTS trajectory_chunks_attempt_idx
  ON trajectory_chunks (attempt_id, seq_first);
CREATE INDEX IF NOT EXISTS trajectory_chunks_receipts_idx
  ON trajectory_chunks USING gin (receipt_event_ids);
-- Crash recovery: unpublished chunks and published chunks whose sources remain.
CREATE INDEX IF NOT EXISTS trajectory_chunks_pending_idx
  ON trajectory_chunks (created_at) WHERE sources_removed_at IS NULL;

-- Highest sequence covered by a published chunk of this attempt (NULL: none).
-- The writer reads it under its attempt lock to decide whether a retried step
-- must be checked against chunks instead of inserted.
ALTER TABLE proof_attempts ADD COLUMN IF NOT EXISTS compacted_through integer;
