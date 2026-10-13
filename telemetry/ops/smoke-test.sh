#!/usr/bin/env bash
# Smoke test of a running collector (release gate and post-deploy check).
#
#   ops/smoke-test.sh BASE_URL [--write] [--origin ORIGIN] [--metrics METRICS_URL]
#
# Default checks are read-only and safe against production: liveness,
# readiness, CORS preflight for an allowed and a foreign origin, and 404 for an
# unknown route. --write additionally submits SYNTHETIC events and feedback
# (v1, v2 with duplicate and rejection outcomes, feedback with a conflicting
# reuse) and is meant for CI and staging only: never run it against the
# production collector, it would store synthetic attempts there.
# --metrics checks the private metrics endpoint (reachable only from inside
# the deployment, e.g. http://127.0.0.1:9464/metrics in CI).
#
# Needs curl and grep. Exit status 0 when every check passed.
set -euo pipefail

usage() {
  echo 'usage: smoke-test.sh BASE_URL [--write] [--origin ORIGIN] [--metrics METRICS_URL]' >&2
  exit 2
}
[[ $# -ge 1 ]] || usage
base=${1%/}
shift
write=0
origin=https://leangame.autumnofautumn.com
metrics=''
while [[ $# -gt 0 ]]; do
  case $1 in
    --write) write=1 ;;
    --origin) origin=${2:?}; shift ;;
    --metrics) metrics=${2:?}; shift ;;
    *) usage ;;
  esac
  shift
done

failures=0
pass() { printf 'ok    %s\n' "$*"; }
fail() {
  printf 'FAIL  %s\n' "$*"
  failures=$((failures + 1))
}

headers=$(mktemp)
trap 'rm -f -- "$headers"' EXIT

# request METHOD PATH [BODY] [extra curl args...] -> sets $status, $body and
# $retry_after (the Retry-After header, if any)
request() {
  local method=$1 path=$2 data=${3:-}
  shift 3 || shift $#
  local output
  local args=(--silent --show-error --max-time 20 --dump-header "$headers" --output - --write-out '\n%{http_code}' -X "$method")
  [[ -z $data ]] || args+=(--header 'Content-Type: application/json' --data-binary "$data")
  retry_after=''
  output=$(curl "${args[@]}" "$@" "$base$path") || {
    status=000
    body=''
    return 0
  }
  status=${output##*$'\n'}
  body=${output%$'\n'*}
  retry_after=$(tr -d '\r' <"$headers" | sed -n 's/^[Rr]etry-[Aa]fter: *\([0-9]*\)$/\1/p' | head -n 1)
}

# Like request, but a 429 is retried once after its Retry-After (at most 15 s):
# the feedback budgets are deliberately small, and a 429 must say when to retry.
request_patiently() {
  request "$@"
  [[ $status == 429 ]] || return 0
  if [[ -z $retry_after ]] || ((retry_after > 15)); then
    fail "429 without a usable Retry-After (${retry_after:-missing})"
    return 0
  fi
  sleep "$retry_after"
  request "$@"
}

expect_status() {
  local name=$1 want=$2
  if [[ $status == "$want" ]]; then pass "$name ($status)"; else fail "$name: expected $want, got $status"; fi
}

count() { grep -o "$1" <<<"$body" | wc -l | tr -d ' '; }
uuid() { cat /proc/sys/kernel/random/uuid; }

request GET /healthz
expect_status 'GET /healthz' 200
[[ $body == *'"status":"ok"'* ]] || fail 'healthz body'
request GET /readyz
expect_status 'GET /readyz' 200
[[ $body == *'"status":"ready"'* ]] || fail "readyz not ready: $body"
request OPTIONS /v2/events '' -H "Origin: $origin" -H 'Access-Control-Request-Method: POST' --include
expect_status 'OPTIONS /v2/events (allowed origin)' 204
grep -qi "^access-control-allow-origin: $origin" <<<"$body" || fail 'preflight lacks Access-Control-Allow-Origin'
request OPTIONS /v1/events '' -H 'Origin: https://example.invalid' -H 'Access-Control-Request-Method: POST'
expect_status 'OPTIONS /v1/events (foreign origin)' 403
request GET /no-such-route
expect_status 'GET unknown route' 404

if ((write)); then
  user=$(uuid)
  attempt=$(uuid)
  start=$(uuid)
  step=$(uuid)
  now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  context="\"user_uuid\":\"$user\",\"attempt_uuid\":\"$attempt\",\"game_id\":\"g/local/SmokeTest\",\"world_id\":\"Smoke\",\"level_id\":1,\"mode\":\"visual\",\"ts\":\"$now\""
  batch="{\"events\":[{\"event_id\":\"$start\",\"event_type\":\"level_start\",$context,\"sequence\":0,\"elapsed_ms\":0,\"initial_script\":null,\"platform\":{\"browser\":\"chrome\",\"device\":\"desktop\"}},{\"event_id\":\"$step\",\"event_type\":\"proof_step\",$context,\"sequence\":1,\"elapsed_ms\":1200,\"step_type\":\"command\",\"command\":\"rfl -- smoke ünïcødé\"}],\"client\":{\"health\":{\"sent\":2}}}"
  json=(-H "Origin: $origin")

  request POST /v2/events "$batch" "${json[@]}"
  expect_status 'POST /v2/events' 200
  [[ $(count '"status":"accepted"') == 2 ]] || fail "v2 first delivery not accepted twice: $body"
  request POST /v2/events "$batch" "${json[@]}"
  expect_status 'POST /v2/events (retry)' 200
  [[ $(count '"status":"duplicate"') == 2 ]] || fail "v2 retry not reported as duplicates: $body"
  request POST /v2/events '{"events":[{"event_id":"not-a-uuid"}]}' "${json[@]}"
  expect_status 'POST /v2/events (invalid event)' 200
  [[ $(count '"status":"rejected"') == 1 ]] || fail "invalid v2 event not rejected: $body"

  v1="{\"events\":[{\"event_id\":\"$(uuid)\",\"event_type\":\"proof_step\",$context,\"sequence\":2,\"elapsed_ms\":2400,\"step_type\":\"undo\",\"command\":\"\"}]}"
  request POST /v1/events "$v1" "${json[@]}"
  expect_status 'POST /v1/events' 204
  request POST /v1/events "$v1" -H 'Origin: https://example.invalid'
  expect_status 'POST /v1/events (foreign origin)' 403

  report=$(uuid)
  feedback="{\"report_id\":\"$report\",\"user_uuid\":\"$user\",\"mode\":\"visual\",\"game_id\":\"g/local/SmokeTest\",\"world_id\":\"Smoke\",\"level_id\":1,\"ts\":\"$now\",\"message\":\"smoke test\",\"proof_state\":{\"steps\":[\"rfl\"]},\"platform\":{\"browser\":\"firefox\",\"device\":\"mobile\"}}"
  request POST /v1/feedback "$feedback" "${json[@]}"
  expect_status 'POST /v1/feedback' 204
  request_patiently POST /v1/feedback "$feedback" "${json[@]}"
  expect_status 'POST /v1/feedback (retry)' 204
  request_patiently POST /v1/feedback "${feedback/smoke test/different text}" "${json[@]}"
  expect_status 'POST /v1/feedback (conflicting reuse)' 409
fi

if [[ -n $metrics ]]; then
  output=$(curl --silent --show-error --max-time 10 "$metrics") || output=''
  for metric in telemetry_http_requests_total telemetry_events_total telemetry_ready; do
    if grep -q "^$metric" <<<"$output"; then pass "metrics expose $metric"; else fail "metrics lack $metric"; fi
  done
  if ((write)) && ! grep -q '^telemetry_events_total{outcome="accepted"} [1-9]' <<<"$output"; then
    fail 'metrics do not count the accepted events'
  fi
fi

if ((failures > 0)); then
  echo "smoke test: $failures check(s) failed"
  exit 1
fi
echo 'smoke test: all checks passed'
