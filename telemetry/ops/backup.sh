#!/usr/bin/env bash
# Database-aware backup of the telemetry PostgreSQL database
# (docs/operations.md, "Backups").
#
# One run writes one backup set directory under BACKUP_DIR:
#
#   telemetry-<UTC timestamp>/
#     database.dump<suffix>  pg_dump --format=custom: one consistent snapshot of
#                            the database (live rows, attempt summaries,
#                            trajectory chunks, ledger, grants)
#     globals.sql<suffix>    pg_dumpall --globals-only --no-role-passwords:
#                            roles, role settings, memberships (restored first)
#     manifest               key=value: versions, sizes, plaintext checksums and
#                            row counts taken just before and after the dump
#     SHA256SUMS             checksums of the stored files
#     UPLOADED               local marker: BACKUP_UPLOAD_CMD succeeded
#
# Data files are encrypted by BACKUP_ENCRYPT_CMD before they touch the disk;
# the script refuses to write plaintext unless BACKUP_ALLOW_PLAINTEXT=1 (local
# tests only). Proof scripts and feedback can contain sensitive text;
# compression is not anonymization.
#
# Disk safety: before starting, the dump size is estimated (previous set's
# measured ratio, else the database size) and the run is refused when it would
# push the staging filesystem past BACKUP_MAX_DISK_RATIO. While writing, the
# stored bytes are hard-capped so usage can never pass BACKUP_ABORT_DISK_RATIO;
# hitting the cap aborts the run and removes its partial files.
#
# Required:
#   BACKUP_DIR                 local staging directory (created 0700)
#   BACKUP_PGPASSWORD_FILE     password of BACKUP_PGUSER (Compose secret file)
#   BACKUP_ENCRYPT_CMD         stdin->stdout filter, e.g. 'age -r age1...' or
#                              'gpg --batch --encrypt --recipient KEYID'
#                              (or BACKUP_ALLOW_PLAINTEXT=1 for local tests)
#   BACKUP_DOCKER_NETWORK      Compose db network (client mode docker), e.g. telemetry_db
# Optional (defaults):
#   BACKUP_PGHOST=postgres BACKUP_PGPORT=5432 BACKUP_PGDATABASE=lean_telemetry
#   BACKUP_PGUSER=telemetry_backup
#   BACKUP_PG_CLIENT=docker    docker: run pg_dump from BACKUP_PG_IMAGE on the
#                              db network; local: pg_dump/psql on PATH
#   BACKUP_PG_IMAGE=postgres:17.10-alpine3.24  (client major >= server major)
#   BACKUP_ENCRYPTED_SUFFIX=.enc
#   BACKUP_UPLOAD_CMD          run as: sh -c "$BACKUP_UPLOAD_CMD" upload <set dir>;
#                              must exit 0 only once the whole set is stored off-server
#   BACKUP_KEEP_LOCAL=1        complete sets kept locally; older sets are removed
#                              once uploaded (never an un-uploaded set while an
#                              upload command is configured)
#   BACKUP_MAX_DISK_RATIO=0.80 BACKUP_ABORT_DISK_RATIO=0.84 BACKUP_ESTIMATE_RATIO=1.0
#   BACKUP_MAX_BYTES           optional hard cap on one set's stored bytes
#   BACKUP_COMPRESS=6          pg_dump --compress
#   BACKUP_LOCK_WAIT_TIMEOUT=60s BACKUP_DOCKER_MEMORY=512m BACKUP_NICE=10
#   BACKUP_ROW_COUNTS=1        0 skips the before/after count(*) scans
#   BACKUP_METRICS_FILE        node_exporter textfile (e.g. /var/lib/node_exporter/
#                              textfile/telemetry_backup.prom) written after each
#                              stored set, so a missing backup can be alerted on
#
# Exit status: 0 done; 1 failed; 2 configuration; 3 refused for disk space;
# 4 backup stored locally but the upload failed.
set -euo pipefail
umask 077

die() {
  local code=$1
  shift
  printf 'backup: %s\n' "$*" >&2
  exit "$code"
}
log() { printf 'backup: %s\n' "$*" >&2; }

ratio_ok() { awk -v value="$1" 'BEGIN { exit !(value ~ /^(0(\.[0-9]+)?|1(\.0+)?)$/) }'; }
integer_ok() { [[ $1 =~ ^[0-9]+$ ]]; }

BACKUP_DIR=${BACKUP_DIR:-}
[[ -n $BACKUP_DIR ]] || die 2 'BACKUP_DIR is required'
pg_host=${BACKUP_PGHOST:-postgres}
pg_port=${BACKUP_PGPORT:-5432}
pg_database=${BACKUP_PGDATABASE:-lean_telemetry}
pg_user=${BACKUP_PGUSER:-telemetry_backup}
password_file=${BACKUP_PGPASSWORD_FILE:-}
[[ -n $password_file && -r $password_file ]] || die 2 'BACKUP_PGPASSWORD_FILE must name a readable file'
client=${BACKUP_PG_CLIENT:-docker}
image=${BACKUP_PG_IMAGE:-postgres:17.10-alpine3.24}
network=${BACKUP_DOCKER_NETWORK:-}
memory=${BACKUP_DOCKER_MEMORY:-512m}
encrypt=${BACKUP_ENCRYPT_CMD:-}
upload=${BACKUP_UPLOAD_CMD:-}
keep_local=${BACKUP_KEEP_LOCAL:-1}
max_ratio=${BACKUP_MAX_DISK_RATIO:-0.80}
abort_ratio=${BACKUP_ABORT_DISK_RATIO:-0.84}
estimate_ratio=${BACKUP_ESTIMATE_RATIO:-1.0}
compress=${BACKUP_COMPRESS:-6}
lock_wait=${BACKUP_LOCK_WAIT_TIMEOUT:-60s}
nice_level=${BACKUP_NICE:-10}
row_counts=${BACKUP_ROW_COUNTS:-1}
max_bytes=${BACKUP_MAX_BYTES:-}
metrics_file=${BACKUP_METRICS_FILE:-}

case $client in
  docker)
    [[ -n $network ]] || die 2 'BACKUP_DOCKER_NETWORK is required with BACKUP_PG_CLIENT=docker (the Compose db network)'
    command -v docker >/dev/null || die 2 'docker is not available'
    ;;
  local)
    for program in pg_dump pg_dumpall psql; do
      command -v "$program" >/dev/null || die 2 'pg_dump, pg_dumpall and psql must be on PATH with BACKUP_PG_CLIENT=local'
    done
    ;;
  *) die 2 'BACKUP_PG_CLIENT must be docker or local' ;;
esac
if [[ -n $encrypt ]]; then
  suffix=${BACKUP_ENCRYPTED_SUFFIX:-.enc}
  [[ $suffix =~ ^\.[A-Za-z0-9.]+$ ]] || die 2 'BACKUP_ENCRYPTED_SUFFIX must look like .enc'
elif [[ ${BACKUP_ALLOW_PLAINTEXT:-0} == 1 ]]; then
  suffix=''
  log 'WARNING: writing an UNENCRYPTED backup (BACKUP_ALLOW_PLAINTEXT=1); use only for local tests'
else
  die 2 'refusing to write an unencrypted backup: set BACKUP_ENCRYPT_CMD (for example "age -r age1...") or, for local tests only, BACKUP_ALLOW_PLAINTEXT=1'
fi
for value in "$max_ratio" "$abort_ratio"; do ratio_ok "$value" || die 2 "disk ratios must be numbers between 0 and 1 (got $value)"; done
awk -v max="$max_ratio" -v abort="$abort_ratio" 'BEGIN { exit !(max <= abort) }' ||
  die 2 'BACKUP_MAX_DISK_RATIO must not exceed BACKUP_ABORT_DISK_RATIO'
awk -v value="$estimate_ratio" 'BEGIN { exit !(value ~ /^[0-9]+(\.[0-9]+)?$/ && value > 0) }' ||
  die 2 'BACKUP_ESTIMATE_RATIO must be a positive number'
if ! integer_ok "$keep_local" || ((keep_local < 1)); then die 2 'BACKUP_KEEP_LOCAL must be an integer >= 1'; fi
integer_ok "$nice_level" || die 2 'BACKUP_NICE must be a non-negative integer'
[[ -z $max_bytes ]] || integer_ok "$max_bytes" || die 2 'BACKUP_MAX_BYTES must be a byte count'
renice -n "$nice_level" -p $$ >/dev/null 2>&1 || true

mkdir -p -- "$BACKUP_DIR"
chmod 0700 -- "$BACKUP_DIR"
exec 9>"$BACKUP_DIR/.backup.lock"
flock -n 9 || die 1 'another backup is running in this BACKUP_DIR'

# Remove what a crashed or aborted run left behind.
for stale in "$BACKUP_DIR"/telemetry-*.partial; do
  [[ -e $stale ]] || continue
  log "removing incomplete set $(basename -- "$stale")"
  rm -rf -- "$stale"
done

pg_options='-c statement_timeout=0 -c idle_in_transaction_session_timeout=0'

# Runs a PostgreSQL client program as the backup role. In docker mode the
# password travels on stdin into a throwaway, unprivileged, read-only client
# container: never on a command line, in a container's configuration or in a
# file inside it.
pg_client() {
  if [[ $client == docker ]]; then
    docker run --rm -i --network "$network" --read-only --cap-drop ALL \
      --security-opt no-new-privileges --user 70:70 --memory "$memory" --pids-limit 64 \
      --cpu-shares 256 --log-driver none --tmpfs /tmp:size=16m \
      -e PGHOST="$pg_host" -e PGPORT="$pg_port" -e PGDATABASE="$pg_database" -e PGUSER="$pg_user" \
      -e PGAPPNAME=telemetry-backup -e PGCONNECT_TIMEOUT=15 -e PGOPTIONS="$pg_options" \
      "$image" sh -c 'IFS= read -r PGPASSWORD || [ -n "$PGPASSWORD" ]
        PGPASSWORD=${PGPASSWORD%"$(printf "\r")"}
        export PGPASSWORD
        exec "$@"' client "$@" <"$password_file"
  else
    local password
    password=$(<"$password_file")
    PGPASSWORD=${password%$'\r'} PGHOST=$pg_host PGPORT=$pg_port PGDATABASE=$pg_database PGUSER=$pg_user \
      PGAPPNAME=telemetry-backup PGCONNECT_TIMEOUT=15 PGOPTIONS=$pg_options "$@" </dev/null
  fi
}

sql() { pg_client psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$1"; }

# Row counts as key=value lines. Tables are looked up first so the same script
# also backs up a database that predates migrations 005-009 (the first backup of
# the existing deployment runs before the migration, as the old superuser).
# logical_steps counts every accepted step once, live or compacted, so it only
# grows under ingestion and compaction.
counts() {
  sql "
    SELECT 'count.' || t || '=' || (xpath('/row/c/text()',
      query_to_xml(format('SELECT count(*) AS c FROM %I', t), false, true, '')))[1]::text
    FROM unnest(ARRAY['anonymous_users', 'proof_attempts', 'proof_steps', 'feedback_reports',
                      'trajectory_chunks', 'schema_migrations']) AS t
    WHERE to_regclass(format('public.%I', t)) IS NOT NULL
    UNION ALL
    SELECT 'logical_steps=' || (xpath('/row/c/text()', query_to_xml(
      CASE WHEN to_regclass('public.trajectory_chunks') IS NULL
        THEN 'SELECT count(*) AS c FROM proof_steps'
        ELSE 'SELECT (SELECT count(*) FROM proof_steps) + (SELECT coalesce(sum(event_count), 0) FROM trajectory_chunks
                WHERE state = ''published'' AND sources_removed_at IS NOT NULL) AS c' END,
      false, true, '')))[1]::text"
}

disk() { df -PB1 -- "$BACKUP_DIR" | awk 'NR == 2 { print $2, $4 }'; }

info=$(sql "
  SELECT 'db_size_bytes=' || pg_database_size(current_database())
  UNION ALL SELECT 'server_version=' || current_setting('server_version')
  UNION ALL SELECT 'database=' || current_database()
  UNION ALL SELECT 'role=' || current_user
  UNION ALL SELECT 'bootstrap_superuser=' || rolname FROM pg_roles WHERE oid = 10
  UNION ALL SELECT 'schema_version=' || coalesce((xpath('/row/v/text()', query_to_xml(
    CASE WHEN to_regclass('public.schema_migrations') IS NULL THEN 'SELECT ''none'' AS v'
      ELSE 'SELECT coalesce(max(version), ''none'') AS v FROM schema_migrations' END, false, true, '')))[1]::text, 'none')") ||
  die 1 'cannot query the database as the backup role'
db_size=$(sed -n 's/^db_size_bytes=//p' <<<"$info")
integer_ok "$db_size" || die 1 'could not read the database size'

# Estimate the stored size from the previous complete set's measured ratio.
previous=$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name 'telemetry-*' ! -name '*.partial' | sort | tail -n 1)
estimate=''
if [[ -n $previous && -r $previous/manifest ]]; then
  previous_db=$(sed -n 's/^db_size_bytes=//p' "$previous/manifest")
  previous_stored=$(sed -n 's/^stored_bytes=//p' "$previous/manifest")
  if integer_ok "${previous_db:-x}" && integer_ok "${previous_stored:-x}" && ((previous_db > 0)); then
    estimate=$(awk -v db="$db_size" -v a="$previous_stored" -v b="$previous_db" 'BEGIN { printf "%.0f", db * a / b * 1.25 }')
  fi
fi
[[ -n $estimate ]] || estimate=$(awk -v db="$db_size" -v r="$estimate_ratio" 'BEGIN { printf "%.0f", db * r }')
((estimate >= 1048576)) || estimate=1048576

read -r total available < <(disk)
projected=$(awk -v t="$total" -v a="$available" -v e="$estimate" 'BEGIN { printf "%.4f", 1 - (a - e) / t }')
if awk -v p="$projected" -v m="$max_ratio" 'BEGIN { exit !(p > m) }'; then
  die 3 "refusing to start: an estimated $estimate-byte backup would raise disk usage to $projected (BACKUP_MAX_DISK_RATIO $max_ratio); free space, move BACKUP_DIR or measure BACKUP_ESTIMATE_RATIO"
fi
# Hard cap on what this run may write, whatever the estimate said.
cap=$(awk -v t="$total" -v a="$available" -v r="$abort_ratio" 'BEGIN { printf "%.0f", a - (1 - r) * t }')
if [[ -n $max_bytes ]] && ((max_bytes < cap)); then cap=$max_bytes; fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
name="telemetry-$stamp"
index=1
while [[ -e $BACKUP_DIR/$name || -e $BACKUP_DIR/$name.partial ]]; do
  index=$((index + 1))
  name="telemetry-$stamp-$index"
done
work="$BACKUP_DIR/$name.partial"
mkdir -m 0700 -- "$work"
# shellcheck disable=SC2317 # invoked by the EXIT trap
cleanup() {
  local status=$?
  if [[ -n ${work:-} && -d $work ]]; then
    rm -rf -- "$work"
    log 'partial set removed'
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' INT TERM HUP

stream_out() {
  if [[ -n $encrypt ]]; then sh -c "$encrypt"; else cat; fi
}

# Streams "$@" (a PostgreSQL client command) into $work/$1 through the
# encryption filter, recording the plaintext sha256 and length on the way and
# never storing more than the remaining byte budget.
capture() {
  local file=$1
  shift
  local sum_fifo="$work/.sum.fifo" count_fifo="$work/.count.fifo"
  mkfifo -- "$sum_fifo" "$count_fifo"
  sha256sum <"$sum_fifo" | cut -d ' ' -f 1 >"$work/.plain.sha256" &
  local sum_pid=$!
  wc -c <"$count_fifo" | tr -d ' ' >"$work/.plain.bytes" &
  local count_pid=$!
  local status=0
  pg_client "$@" | tee -- "$sum_fifo" "$count_fifo" | stream_out | head -c "$remaining" >"$work/$file" ||
    status=$?
  wait "$sum_pid" || status=1
  wait "$count_pid" || status=1
  rm -f -- "$sum_fifo" "$count_fifo"
  local stored
  stored=$(stat -c %s -- "$work/$file")
  if ((stored >= remaining)); then
    die 1 "aborted: $file reached the byte budget of this run ($remaining bytes left; BACKUP_ABORT_DISK_RATIO $abort_ratio, BACKUP_MAX_BYTES ${max_bytes:-unset})"
  fi
  ((status == 0)) || die 1 "$file: the dump pipeline failed (status $status)"
  if [[ -n $encrypt && $(head -c 5 -- "$work/$file") == PGDMP ]]; then
    die 1 'BACKUP_ENCRYPT_CMD did not encrypt its input; refusing to keep a plaintext dump'
  fi
  remaining=$((remaining - stored))
  sync -- "$work/$file"
}

started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
before=''
[[ $row_counts == 0 ]] || before=$(counts) || die 1 'cannot count rows'
remaining=$cap
log "dumping $(sed -n 's/^database=//p' <<<"$info") (estimate $estimate bytes, budget $cap bytes)"
capture "globals.sql$suffix" pg_dumpall --globals-only --no-role-passwords -l "$pg_database"
globals_sha=$(<"$work/.plain.sha256")
capture "database.dump$suffix" pg_dump --format=custom --compress="$compress" \
  --lock-wait-timeout="$lock_wait" --no-password
dump_sha=$(<"$work/.plain.sha256")
dump_bytes=$(<"$work/.plain.bytes")
rm -f -- "$work/.plain.sha256" "$work/.plain.bytes"
after=''
[[ $row_counts == 0 ]] || after=$(counts) || die 1 'cannot count rows'
pg_dump_version=$(pg_client pg_dump --version) || die 1 'cannot read the pg_dump version'

globals_stored=$(stat -c %s -- "$work/globals.sql$suffix")
dump_stored=$(stat -c %s -- "$work/database.dump$suffix")
{
  echo 'format=telemetry-backup/1'
  echo "name=$name"
  echo "started_at=$started"
  echo "completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s\n' "$info"
  echo "pg_dump_version=$pg_dump_version"
  echo "client=$client"
  echo "encrypted=$([[ -n $encrypt ]] && echo yes || echo no)"
  echo "suffix=$suffix"
  echo "dump_file=database.dump$suffix"
  echo "dump_plain_bytes=$dump_bytes"
  echo "dump_plain_sha256=$dump_sha"
  echo "globals_file=globals.sql$suffix"
  echo "globals_plain_sha256=$globals_sha"
  echo "stored_bytes=$((dump_stored + globals_stored))"
  [[ -z $before ]] || printf 'before.%s\n' "${before//$'\n'/$'\nbefore.'}"
  [[ -z $after ]] || printf 'after.%s\n' "${after//$'\n'/$'\nafter.'}"
} >"$work/manifest"
(cd -- "$work" && sha256sum -- "database.dump$suffix" "globals.sql$suffix" manifest >SHA256SUMS)
sync -- "$work/manifest" "$work/SHA256SUMS"
mv -- "$work" "$BACKUP_DIR/$name"
work=''
set_dir="$BACKUP_DIR/$name"
log "stored $name ($((dump_stored + globals_stored)) bytes, encrypted: $([[ -n $encrypt ]] && echo yes || echo no))"

status=0
if [[ -n $upload ]]; then
  if sh -c "$upload" upload "$set_dir"; then
    : >"$set_dir/UPLOADED"
    log "uploaded $name"
  else
    log "UPLOAD FAILED for $name; the set stays in $BACKUP_DIR and there is no new off-server copy"
    status=4
  fi
else
  log 'WARNING: BACKUP_UPLOAD_CMD is not set; this backup exists only on this host'
fi

write_metrics() {
  {
    echo '# HELP telemetry_backup_last_stored_timestamp_seconds When the newest complete backup set was stored.'
    echo '# TYPE telemetry_backup_last_stored_timestamp_seconds gauge'
    echo "telemetry_backup_last_stored_timestamp_seconds $(date +%s)"
    echo '# HELP telemetry_backup_last_stored_bytes Stored size of the newest backup set.'
    echo '# TYPE telemetry_backup_last_stored_bytes gauge'
    echo "telemetry_backup_last_stored_bytes $((dump_stored + globals_stored))"
    echo '# HELP telemetry_backup_last_uploaded Whether the newest backup set reached off-server storage.'
    echo '# TYPE telemetry_backup_last_uploaded gauge'
    echo "telemetry_backup_last_uploaded $([[ -e $set_dir/UPLOADED ]] && echo 1 || echo 0)"
  } >"$metrics_file.tmp.$$"
  chmod 0644 -- "$metrics_file.tmp.$$"
  mv -- "$metrics_file.tmp.$$" "$metrics_file"
}
if [[ -n $metrics_file ]] && ! (write_metrics); then
  log 'could not write BACKUP_METRICS_FILE'
fi

# Keep the newest BACKUP_KEEP_LOCAL complete sets. With an upload command
# configured, a set that never reached off-server storage is not deleted.
mapfile -t sets < <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name 'telemetry-*' ! -name '*.partial' | sort)
for ((i = 0; i < ${#sets[@]} - keep_local; i++)); do
  old=${sets[i]}
  if [[ -n $upload && ! -e $old/UPLOADED ]]; then
    log "keeping $(basename -- "$old"): it was never uploaded"
    continue
  fi
  rm -rf -- "$old"
  log "removed local set $(basename -- "$old")"
done
exit "$status"
