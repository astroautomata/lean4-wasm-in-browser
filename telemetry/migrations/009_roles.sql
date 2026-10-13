-- Least-privilege roles (docs/operations.md). Created NOLOGIN here;
-- `node src/migrate.js --provision-roles` enables LOGIN and sets the password of
-- each role whose secret is supplied. Roles are cluster-wide; grants are per
-- database. The bootstrap/migration credential (the POSTGRES_USER superuser)
-- stays with the migration job only.
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['telemetry_writer', 'telemetry_compactor', 'telemetry_reader',
                                    'telemetry_retention', 'telemetry_backup'] LOOP
    BEGIN
      EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    EXECUTE format('ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', role_name);
  END LOOP;
END $$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public
  TO telemetry_writer, telemetry_compactor, telemetry_reader, telemetry_retention;
GRANT SELECT ON schema_migrations
  TO telemetry_writer, telemetry_compactor, telemetry_reader, telemetry_retention;

-- Runtime intake writer: insert and the specific updates it performs; no DELETE,
-- no DDL. Row locks (FOR UPDATE) need the column UPDATE grants below.
GRANT SELECT, INSERT ON anonymous_users, proof_attempts, proof_steps, feedback_reports TO telemetry_writer;
GRANT UPDATE (last_seen) ON anonymous_users TO telemetry_writer;
GRANT UPDATE (started_at, initial_script, source_attempt_id, last_received_at,
              start_event_id, start_sequence, start_client_ts, start_elapsed_ms,
              completed, completed_at, duration_ms, play_script, lean_script,
              completion_event_id, completion_sequence, completion_received_at,
              later_completion_sequences)
  ON proof_attempts TO telemetry_writer;
GRANT SELECT ON trajectory_chunks TO telemetry_writer;

-- Compactor: reads sources, writes chunks, removes exactly verified source rows.
GRANT SELECT ON proof_attempts, proof_steps TO telemetry_compactor;
GRANT UPDATE (compacted_through) ON proof_attempts TO telemetry_compactor;
GRANT DELETE ON proof_steps TO telemetry_compactor;
GRANT SELECT, INSERT, DELETE ON trajectory_chunks TO telemetry_compactor;
GRANT UPDATE (state, published_at, sources_removed_at) ON trajectory_chunks TO telemetry_compactor;

-- Exports and replay extraction: read-only.
GRANT SELECT ON anonymous_users, proof_attempts, proof_steps, trajectory_chunks, feedback_reports
  TO telemetry_reader;

-- Retention: deletes whole expired records and may expire receipts. Only runs
-- under an explicit, recorded policy (src/jobs/retention.js).
GRANT SELECT, DELETE ON anonymous_users, proof_attempts, proof_steps, trajectory_chunks, feedback_reports
  TO telemetry_retention;
GRANT UPDATE (receipt_event_ids) ON trajectory_chunks TO telemetry_retention;

-- Database-aware backups (pg_dump): read everything, change nothing.
GRANT pg_read_all_data TO telemetry_backup;

-- PostgreSQL-side deadlines; the collector also sets them per connection.
ALTER ROLE telemetry_writer SET statement_timeout = '3s';
ALTER ROLE telemetry_writer SET lock_timeout = '500ms';
ALTER ROLE telemetry_writer SET idle_in_transaction_session_timeout = '5s';
ALTER ROLE telemetry_compactor SET lock_timeout = '1s';
ALTER ROLE telemetry_compactor SET idle_in_transaction_session_timeout = '30s';
-- Exports must not compete unboundedly with intake (docs/exports.md).
ALTER ROLE telemetry_reader SET default_transaction_read_only = on;
ALTER ROLE telemetry_reader SET idle_in_transaction_session_timeout = '10min';
ALTER ROLE telemetry_reader SET statement_timeout = '60s';
ALTER ROLE telemetry_reader SET work_mem = '16MB';
ALTER ROLE telemetry_reader SET temp_file_limit = '1GB';
ALTER ROLE telemetry_retention SET statement_timeout = '30s';
ALTER ROLE telemetry_retention SET lock_timeout = '1s';
ALTER ROLE telemetry_backup SET default_transaction_read_only = on;
