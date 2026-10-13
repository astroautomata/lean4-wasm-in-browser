-- Trusted ingestion times, set by PostgreSQL's clock. Rows that existed before
-- this migration keep NULL: their ingestion time is unknown. It is bounded above
-- by this migration's applied_at in schema_migrations, which is what retention
-- and compaction use for them; a client timestamp is never a substitute.
--
-- Adding each column without a default and then setting the default is
-- metadata-only (no table rewrite, brief lock) and leaves existing rows NULL.
-- A collector that predates this migration keeps working: its inserts take the
-- defaults.
ALTER TABLE proof_steps ADD COLUMN IF NOT EXISTS received_at timestamptz;
ALTER TABLE proof_steps ALTER COLUMN received_at SET DEFAULT now();

ALTER TABLE proof_attempts ADD COLUMN IF NOT EXISTS received_at timestamptz;
ALTER TABLE proof_attempts ALTER COLUMN received_at SET DEFAULT now();
-- Last time an event for this attempt was accepted, coarsened by the writer
-- (see docs/design.md). Drives compaction inactivity and detail retention.
ALTER TABLE proof_attempts ADD COLUMN IF NOT EXISTS last_received_at timestamptz;
ALTER TABLE proof_attempts ALTER COLUMN last_received_at SET DEFAULT now();
