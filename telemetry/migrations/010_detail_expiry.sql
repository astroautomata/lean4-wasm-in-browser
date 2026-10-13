-- When an explicit retention policy removed an attempt's step detail (live rows
-- and chunks), the attempt summary stays and records it here. The writer then
-- rejects further steps for the attempt (late_event) instead of accepting a
-- retry of an expired step as if it were new, and readers report the detail as
-- expired rather than missing.
ALTER TABLE proof_attempts ADD COLUMN IF NOT EXISTS detail_expired_at timestamptz;
GRANT UPDATE (detail_expired_at) ON proof_attempts TO telemetry_retention;
