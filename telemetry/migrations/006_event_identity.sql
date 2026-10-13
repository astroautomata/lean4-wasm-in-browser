-- Stable identities for level_start and level_complete events, so retries are
-- recognised as exact duplicates and reuse with different content as conflicts
-- (docs/protocol.md). Steps already have proof_steps.event_id.
--
-- Completion is immutable after the first accepted level_complete. Later
-- completions of the same attempt are rejected; their sequence numbers are kept
-- so replay readers can tell them from lost steps.
ALTER TABLE proof_attempts
  ADD COLUMN IF NOT EXISTS start_event_id uuid,
  ADD COLUMN IF NOT EXISTS start_sequence integer,
  ADD COLUMN IF NOT EXISTS start_client_ts timestamptz,
  ADD COLUMN IF NOT EXISTS start_elapsed_ms integer,
  ADD COLUMN IF NOT EXISTS completion_event_id uuid,
  ADD COLUMN IF NOT EXISTS completion_sequence integer,
  ADD COLUMN IF NOT EXISTS completion_received_at timestamptz,
  ADD COLUMN IF NOT EXISTS later_completion_sequences integer[] NOT NULL DEFAULT '{}';
