-- migrate:no-transaction
-- Built concurrently so a large proof_attempts table stays writable. The
-- migration runner rejects the run if any index is left invalid.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS proof_attempts_start_event_idx
  ON proof_attempts (start_event_id) WHERE start_event_id IS NOT NULL;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS proof_attempts_completion_event_idx
  ON proof_attempts (completion_event_id) WHERE completion_event_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS proof_attempts_last_received_idx
  ON proof_attempts (last_received_at);
