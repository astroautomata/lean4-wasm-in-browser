#!/bin/sh
# Export the entire telemetry database to a single CSV spreadsheet.
#
# Usage:
#   ./export-telemetry.sh [OUTPUT_CSV]
#
# Default output: ./telemetry-export-<UTC timestamp>.csv
#
# Connection (first match wins):
#   DATABASE_URL set      -> local `psql "$DATABASE_URL"`
#   otherwise             -> `docker exec` into the running PostgreSQL container
#                            PG_CONTAINER (default: the one running container whose
#                                          Compose service is PG_SERVICE, any project)
#                            PG_SERVICE   (default: postgres)
#                            PGUSER / PGDATABASE (default: lean_telemetry)
#
# Example: PG_CONTAINER=root-postgres-1 ./export-telemetry.sh out.csv
#
# The CSV is "long" format: one row per record, tagged by `record_type`:
#   attempt   one row per proof_attempts row (carries initial/play/lean scripts)
#   step      one row per proof_steps row, ordered by sequence within its attempt
#   feedback  one row per feedback_reports row (not linked to an attempt)
# Every row also carries its user's first/last seen and, for attempt and step
# rows, the attempt's game/level/mode/timing columns, so the file can be filtered
# without joins. Rows are grouped by user, then attempt, in chronological order.
# All timestamps are ISO 8601 UTC. Every anonymous_users row is reachable from
# an attempt or feedback row, so no table data is omitted.

set -eu

OUT="${1:-./telemetry-export-$(date -u +%Y%m%dT%H%M%SZ).csv}"
PGUSER="${PGUSER:-lean_telemetry}"
PGDATABASE="${PGDATABASE:-lean_telemetry}"

query() {
  cat <<'SQL'
SET TIME ZONE 'UTC';
COPY (
  WITH records AS (
    SELECT 'attempt'::text AS record_type, 0 AS kind_order,
           a.attempt_id AS record_id, a.started_at AS record_ts,
           a.user_id, a.attempt_id,
           a.game_id, a.world_id, a.level_id, a.mode::text AS mode,
           NULL::integer AS step_sequence, NULL::integer AS step_elapsed_ms,
           NULL::text AS step_type, NULL::text AS step_command,
           NULL::integer AS step_from_line, NULL::integer AS step_removed_lines,
           a.initial_script, a.play_script, a.lean_script,
           NULL::text AS feedback_message, NULL::jsonb AS feedback_proof_state,
           NULL::timestamptz AS feedback_received_at,
           a.attributes
    FROM proof_attempts a
    UNION ALL
    SELECT 'step', 1, s.event_id, s.client_ts,
           a.user_id, a.attempt_id,
           a.game_id, a.world_id, a.level_id, a.mode::text,
           s.sequence, s.elapsed_ms, s.step_type::text, s.command,
           s.from_line, s.removed_lines,
           NULL, NULL, NULL,
           NULL, NULL, NULL,
           s.attributes
    FROM proof_steps s
    JOIN proof_attempts a ON a.attempt_id = s.attempt_id
    UNION ALL
    SELECT 'feedback', 2, f.report_id, f.client_ts,
           f.user_id, NULL,
           f.game_id, f.world_id, f.level_id, f.mode::text,
           NULL, NULL, NULL, NULL, NULL, NULL,
           NULL, NULL, NULL,
           f.message, f.proof_state, f.received_at,
           f.attributes
    FROM feedback_reports f
  )
  SELECT r.record_type,
         r.record_id,
         r.record_ts,
         r.user_id,
         u.first_seen        AS user_first_seen,
         u.last_seen         AS user_last_seen,
         r.attempt_id,
         a.source_attempt_id,
         r.game_id,
         r.world_id,
         r.level_id,
         r.mode,
         a.started_at        AS attempt_started_at,
         a.completed_at      AS attempt_completed_at,
         a.duration_ms       AS attempt_duration_ms,
         a.completed         AS attempt_completed,
         r.step_sequence,
         r.step_elapsed_ms,
         r.step_type,
         r.step_command,
         r.step_from_line,
         r.step_removed_lines,
         r.initial_script,
         r.play_script,
         r.lean_script,
         r.feedback_message,
         r.feedback_proof_state,
         r.feedback_received_at,
         r.attributes
  FROM records r
  LEFT JOIN anonymous_users u ON u.user_id = r.user_id
  LEFT JOIN proof_attempts a ON a.attempt_id = r.attempt_id
  ORDER BY u.first_seen NULLS LAST, r.user_id NULLS LAST,
           COALESCE(a.started_at, r.record_ts), r.attempt_id NULLS LAST,
           r.kind_order, r.step_sequence, r.record_ts
) TO STDOUT WITH (FORMAT csv, HEADER true);
SQL
}

if [ -z "${DATABASE_URL:-}" ] && [ -z "${PG_CONTAINER:-}" ]; then
  PG_CONTAINER="$(docker ps \
    --filter "label=com.docker.compose.service=${PG_SERVICE:-postgres}" \
    --format '{{.Names}}')"
  case "${PG_CONTAINER}" in
    "")
      echo "Error: no running container for Compose service '${PG_SERVICE:-postgres}'." >&2
      echo "Running containers:" >&2
      docker ps --format '  {{.Names}}  ({{.Image}})' >&2
      echo "Set PG_CONTAINER=<name> to choose one." >&2
      exit 1 ;;
    *"
"*)
      echo "Error: several running containers match; set PG_CONTAINER to one of:" >&2
      echo "${PG_CONTAINER}" | sed 's/^/  /' >&2
      exit 1 ;;
  esac
fi

run_psql() {
  if [ -n "${DATABASE_URL:-}" ]; then
    psql -X -q -v ON_ERROR_STOP=1 "${DATABASE_URL}"
  else
    docker exec -i "${PG_CONTAINER}" \
      psql -U "${PGUSER}" -d "${PGDATABASE}" -X -q -v ON_ERROR_STOP=1
  fi
}

TMP="${OUT}.partial"
trap 'rm -f "${TMP}"' EXIT

# psql is the last command in the pipeline, so its exit status fails `set -e`.
query | run_psql > "${TMP}"
mv "${TMP}" "${OUT}"
trap - EXIT
echo "Wrote ${OUT}"
