#!/usr/bin/env bash
# Restore drill: restores one backup set (ops/backup.sh) into a disposable
# PostgreSQL container and verifies it (docs/operations.md, "Restore drills").
#
#   ops/restore-test.sh [SET_DIR]     default: newest complete set in BACKUP_DIR
#
# Steps: verify SHA256SUMS; start a uniquely named throwaway container (never
# the production one); decrypt each file straight into it and compare the
# plaintext checksum with the manifest; apply the globals, then pg_restore
# --create --exit-on-error; run `node src/migrate.js --check`; give the runtime
# roles random one-time passwords and run tools/verify-permissions.js; compare
# row counts with the counts the backup recorded around its snapshot (including
# logical steps = live rows + steps held only in compacted chunks); run
# tools/verify-chunks.js when present, which decodes every chunk of the mixed
# live/compacted data; remove the container and its network.
#
# Environment:
#   RESTORE_DECRYPT_CMD     stdin->stdout filter, required for encrypted sets
#                           (e.g. 'age -d -i /path/to/key.txt'); keep the key off
#                           the production host and run drills elsewhere when possible
#   RESTORE_PG_IMAGE=postgres:17.10-alpine3.24
#   RESTORE_MEMORY=768m     memory limit of the disposable server
#   RESTORE_TOOLS=host      host: node + this checkout (needs node_modules);
#                           image: run the tools from RESTORE_TOOL_IMAGE (the
#                           collector release image) on a private network
#   RESTORE_ALLOW_UPGRADE=0 1: an older backup may be migrated forward after
#                           --check reports it incompatible (tests the upgrade path)
#   RESTORE_KEEP=0          1: keep the container for inspection (prints its name)
#   RESTORE_MAX_DISK_RATIO=0.80  refuse when the restore could fill the disk
#   BACKUP_DIR              where to look for the newest set when SET_DIR is omitted
#
# Exit status: 0 verified; 1 a check failed; 2 configuration; 3 disk space.
set -euo pipefail
umask 077

die() {
  local code=$1
  shift
  printf 'restore-test: %s\n' "$*" >&2
  exit "$code"
}
log() { printf 'restore-test: %s\n' "$*" >&2; }

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
telemetry_dir=$(dirname -- "$script_dir")
image=${RESTORE_PG_IMAGE:-postgres:17.10-alpine3.24}
memory=${RESTORE_MEMORY:-768m}
tools=${RESTORE_TOOLS:-host}
tool_image=${RESTORE_TOOL_IMAGE:-}
decrypt=${RESTORE_DECRYPT_CMD:-}
max_ratio=${RESTORE_MAX_DISK_RATIO:-0.80}
command -v docker >/dev/null || die 2 'docker is not available'

set_dir=${1:-}
if [[ -z $set_dir ]]; then
  [[ -n ${BACKUP_DIR:-} ]] || die 2 'pass a backup set directory or set BACKUP_DIR'
  set_dir=$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name 'telemetry-*' ! -name '*.partial' | sort | tail -n 1)
  [[ -n $set_dir ]] || die 2 "no complete backup set in $BACKUP_DIR"
fi
[[ -r $set_dir/manifest && -r $set_dir/SHA256SUMS ]] || die 2 "$set_dir is not a backup set (manifest or SHA256SUMS missing)"
manifest() { sed -n "s/^$1=//p" "$set_dir/manifest" | head -n 1; }
[[ $(manifest format) == telemetry-backup/1 ]] || die 2 'unsupported backup set format'
case $tools in
  host)
    command -v node >/dev/null || die 2 'node is required with RESTORE_TOOLS=host'
    [[ -d $telemetry_dir/node_modules/pg ]] || die 2 "run npm ci in $telemetry_dir first (RESTORE_TOOLS=host)"
    ;;
  image) [[ -n $tool_image ]] || die 2 'RESTORE_TOOL_IMAGE is required with RESTORE_TOOLS=image' ;;
  *) die 2 'RESTORE_TOOLS must be host or image' ;;
esac
# Restore into a cluster whose bootstrap superuser has the source's name:
# PostgreSQL 16+ records role grants "GRANTED BY" that superuser, and only the
# bootstrap superuser can replay them. A real recovery does the same
# (POSTGRES_USER unchanged).
superuser=$(manifest bootstrap_superuser)
superuser=${superuser:-postgres}
[[ $superuser =~ ^[a-z_][a-z0-9_]*$ ]] || die 2 'unexpected bootstrap superuser name in the manifest'
if [[ $(manifest encrypted) == yes && -z $decrypt ]]; then
  die 2 'this set is encrypted: set RESTORE_DECRYPT_CMD'
fi

log "verifying checksums of $(basename -- "$set_dir")"
(cd -- "$set_dir" && sha256sum --quiet --strict -c SHA256SUMS) || die 1 'checksum verification failed'

# The restore needs room for the plaintext dump inside the container plus the
# restored database; refuse rather than squeeze the host.
need=$(($(manifest dump_plain_bytes) + $(manifest db_size_bytes) * 12 / 10))
read -r total available < <(df -PB1 -- "$(docker info --format '{{.DockerRootDir}}')" | awk 'NR == 2 { print $2, $4 }')
projected=$(awk -v t="$total" -v a="$available" -v n="$need" 'BEGIN { printf "%.4f", 1 - (a - n) / t }')
if awk -v p="$projected" -v m="$max_ratio" 'BEGIN { exit !(p > m) }'; then
  die 3 "refusing: restoring needs about $need bytes and would raise disk usage to $projected (RESTORE_MAX_DISK_RATIO $max_ratio); run the drill on another machine"
fi

name="tlm-restore-test-$(date -u +%Y%m%d%H%M%S)-$(od -An -N4 -tx4 /dev/urandom | tr -d ' ')"
network=''
cleanup() {
  local status=$?
  if [[ ${RESTORE_KEEP:-0} == 1 ]]; then
    log "keeping container $name for inspection (docker rm -f -v $name${network:+; docker network rm $network})"
  else
    docker rm -f -v "$name" >/dev/null 2>&1 || true
    [[ -z $network ]] || docker network rm "$network" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' INT TERM HUP

POSTGRES_PASSWORD=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
export POSTGRES_PASSWORD
run_args=(--detach --name "$name" --label tlm.restore-test=1 --memory "$memory" --shm-size 256m
  --pids-limit 256 --cpu-shares 256 --log-opt max-size=10m --log-opt max-file=2 -e POSTGRES_PASSWORD
  -e POSTGRES_USER="$superuser" -e POSTGRES_DB=postgres)
if [[ $tools == image ]]; then
  network="$name-net"
  docker network create --internal "$network" >/dev/null
  run_args+=(--network "$network")
else
  run_args+=(--publish 127.0.0.1::5432)
fi
log "starting disposable server $name"
docker run "${run_args[@]}" "$image" >/dev/null

# The entrypoint's temporary init server only listens on the socket, so a TCP
# connection means the real server is up.
for attempt in $(seq 1 90); do
  docker exec -u postgres "$name" psql -X -q -h 127.0.0.1 -U "$superuser" -d postgres -c 'SELECT 1' >/dev/null 2>&1 && break
  ((attempt < 90)) || die 1 'the disposable server did not become ready'
  sleep 1
done

psql_in() { docker exec -i -u postgres "$name" psql -X -q -v ON_ERROR_STOP=1 -U "$superuser" "$@"; }

# Decrypt one stored file into the container and check its plaintext checksum.
load() {
  local file=$1 target=$2 expected=$3
  if [[ -n $decrypt ]]; then
    sh -c "$decrypt" <"$set_dir/$file"
  else
    cat -- "$set_dir/$file"
  fi | docker exec -i -u postgres "$name" sh -c "cat > $target" || die 1 "could not decrypt or copy $file"
  local actual
  actual=$(docker exec -u postgres "$name" sha256sum "$target" | cut -d ' ' -f 1)
  [[ $actual == "$expected" ]] || die 1 "$file: plaintext checksum mismatch after decryption"
}
load "$(manifest globals_file)" /tmp/globals.sql "$(manifest globals_plain_sha256)"
load "$(manifest dump_file)" /tmp/database.dump "$(manifest dump_plain_sha256)"

# Roles first: the dump's grants and owners refer to them. Roles that already
# exist in the fresh cluster (its superuser) report "already exists"; anything
# else is a failure.
globals_log=$(docker exec -u postgres "$name" psql -X -q -U "$superuser" -d postgres -f /tmp/globals.sql 2>&1 || true)
unexpected=$(grep 'ERROR' <<<"$globals_log" | grep -v 'already exists' || true)
[[ -z $unexpected ]] || die 1 "applying globals failed: $unexpected"

database=$(manifest database)
log "restoring database $database"
docker exec -u postgres "$name" pg_restore -U "$superuser" -d postgres --create --exit-on-error --no-password /tmp/database.dump ||
  die 1 'pg_restore failed'
docker exec -u postgres "$name" rm -f /tmp/database.dump /tmp/globals.sql

# Tools connect as the disposable superuser (migrate) and as each runtime role
# with random one-time passwords; nothing here is ever reused.
declare -A role_passwords
for role in writer compactor reader retention backup; do
  role_passwords[$role]=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
done
if [[ $tools == host ]]; then
  db_host=127.0.0.1
  db_port=$(docker port "$name" 5432/tcp | head -n 1 | sed 's/.*://')
else
  db_host=$name
  db_port=5432
fi
url() { printf 'postgresql://%s:%s@%s:%s/%s' "$1" "$2" "$db_host" "$db_port" "$database"; }
tool_env=(
  "MIGRATION_DATABASE_URL=$(url "$superuser" "$POSTGRES_PASSWORD")"
  "DATABASE_URL=$(url telemetry_writer "${role_passwords[writer]}")"
  "WRITER_DATABASE_URL=$(url telemetry_writer "${role_passwords[writer]}")"
  "COMPACTOR_DATABASE_URL=$(url telemetry_compactor "${role_passwords[compactor]}")"
  "READER_DATABASE_URL=$(url telemetry_reader "${role_passwords[reader]}")"
  "RETENTION_DATABASE_URL=$(url telemetry_retention "${role_passwords[retention]}")"
  "BACKUP_DATABASE_URL=$(url telemetry_backup "${role_passwords[backup]}")"
)
# Credentials reach the tools through the environment of a subshell, never
# through a command line.
tool() {
  (
    for pair in "${tool_env[@]}"; do export "${pair?}"; done
    if [[ $tools == host ]]; then
      cd -- "$telemetry_dir"
      nice -n 10 node "$@"
    else
      env_args=()
      for pair in "${tool_env[@]}"; do env_args+=(-e "${pair%%=*}"); done
      docker run --rm --network "$network" --read-only --cap-drop ALL \
        --security-opt no-new-privileges --memory 384m --pids-limit 64 --log-driver none \
        "${env_args[@]}" --entrypoint node "$tool_image" "$@"
    fi
  )
}
tool_exists() {
  if [[ $tools == host ]]; then
    [[ -f $telemetry_dir/$1 ]]
  else
    docker run --rm --entrypoint test "$tool_image" -f "$1"
  fi
}

failures=0
fail() {
  log "FAIL: $*"
  failures=$((failures + 1))
}

log 'checking schema compatibility (node src/migrate.js --check)'
if ! check=$(tool src/migrate.js --check); then
  if [[ ${RESTORE_ALLOW_UPGRADE:-0} == 1 ]]; then
    log "schema not current ($check); migrating the restored copy forward"
    tool src/migrate.js >&2 || fail 'migrating the restored copy failed'
    tool src/migrate.js --check >/dev/null || fail 'schema still incompatible after migrating'
  else
    fail "schema incompatible with this release: $check"
  fi
fi

# Passwords go to psql on stdin (hex, so no quoting), never on a command line.
log 'enabling the runtime roles with one-time passwords'
roles_ready=1
for role in writer compactor reader retention backup; do
  printf "ALTER ROLE telemetry_%s WITH LOGIN PASSWORD '%s';\n" "$role" "${role_passwords[$role]}"
done | psql_in -d postgres >/dev/null 2>&1 || {
  roles_ready=0
  fail 'the runtime roles are missing from the restored cluster (globals not restored, or a pre-009 backup)'
}

if ((roles_ready)); then
  log 'verifying role privileges (tools/verify-permissions.js)'
  tool tools/verify-permissions.js >&2 || fail 'role privileges differ from the expected matrix'
fi

# Row counts. Tables that only grow under ingestion and compaction must lie
# between the counts taken before and after the dump's snapshot; the rest are
# reported. A table that shrank meanwhile (retention) is reported, not judged.
log 'comparing row counts with the manifest'
restored=$(psql_in -d "$database" -A -t -c "
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
    false, true, '')))[1]::text")
printf '%-34s %12s %12s %12s\n' key before restored after >&2
for key in count.anonymous_users count.proof_attempts count.feedback_reports count.schema_migrations \
  logical_steps count.proof_steps count.trajectory_chunks; do
  value=$(sed -n "s/^$key=//p" <<<"$restored")
  low=$(manifest "before.$key")
  high=$(manifest "after.$key")
  printf '%-34s %12s %12s %12s\n' "$key" "${low:--}" "${value:--}" "${high:--}" >&2
  case $key in count.proof_steps | count.trajectory_chunks) continue ;; esac
  [[ -n $low && -n $high ]] || continue
  if [[ -z $value ]]; then
    fail "$key missing after restore"
  elif ((high < low)); then
    log "note: $key shrank during the backup; bound not checked"
  elif ((value < low || value > high)); then
    fail "$key restored $value, expected between $low and $high"
  fi
done
psql_in -d "$database" -A -t -F ' ' -c "
  SELECT 'chunks: published=' || count(*) FILTER (WHERE state = 'published') ||
    ' shadow=' || count(*) FILTER (WHERE state = 'shadow') ||
    ' sources_removed=' || count(*) FILTER (WHERE sources_removed_at IS NOT NULL)
  FROM trajectory_chunks" >&2 2>/dev/null || true

if ((!roles_ready)); then
  log 'chunk decoding not verified: the runtime roles are unavailable'
elif tool_exists tools/verify-chunks.js; then
  log 'decoding every trajectory chunk (tools/verify-chunks.js)'
  tool tools/verify-chunks.js >&2 || fail 'trajectory chunk verification failed'
else
  log 'tools/verify-chunks.js is not part of this release; chunk decoding not verified'
fi

if ((failures > 0)); then
  die 1 "$failures check(s) failed for $(basename -- "$set_dir")"
fi
log "PASS: $(basename -- "$set_dir") restored and verified"
