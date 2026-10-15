#!/usr/bin/env bash
# Serve the Lean runtime and module bundle of an extracted static site from
# Cloudflare R2, so GitHub Pages' bandwidth limit doesn't cap the number of
# players (README.md, "Asset hosting").
#
#   publish-r2-assets.sh <site-dir>
#
# Uploads <site-dir>/visual-lean/{runtime/lean.wasm,runtime/lean.js,
# modules/game-modules.tar.gz} once under the immutable, content-addressed
# prefix visual-lean/<version>/, verifies every file through the public URL
# the way a browser fetches it, and only then writes
# <site-dir>/visual-lean/asset-base.json, which points the client there. The
# site keeps its own copies as the client's fallback. Objects are never
# deleted or overwritten.
#
# Environment (all from repository secrets):
#   R2_PUBLIC_BASE         https://assets.example.com; empty turns this off
#   R2_BUCKET              bucket name
#   R2_ACCOUNT_ID          Cloudflare account ID (for the S3 endpoint)
#   AWS_ACCESS_KEY_ID      bucket-scoped R2 API token
#   AWS_SECRET_ACCESS_KEY
#
# The CORS origin checked is https://<the site's CNAME>.
set -euo pipefail

site="${1:?usage: publish-r2-assets.sh <site-dir>}"
lean="$site/visual-lean"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"

if [[ -z "${R2_PUBLIC_BASE:-}" ]]; then
  # A stale file would keep pointing players at R2 after a rollback.
  rm -f "$lean/asset-base.json"
  echo '::notice::R2_PUBLIC_BASE is not set, so the Lean runtime and modules are served from GitHub Pages only.'
  exit 0
fi

: "${R2_BUCKET:?R2_BUCKET must be set when R2_PUBLIC_BASE is}"
: "${R2_ACCOUNT_ID:?R2_ACCOUNT_ID must be set when R2_PUBLIC_BASE is}"
: "${AWS_ACCESS_KEY_ID:?the R2_ACCESS_KEY_ID secret must be set when R2_PUBLIC_BASE is}"
: "${AWS_SECRET_ACCESS_KEY:?the R2_SECRET_ACCESS_KEY secret must be set when R2_PUBLIC_BASE is}"

public_base="${R2_PUBLIC_BASE%/}"
# The client ignores any other base, which would silently disable R2.
if [[ ! "$public_base" =~ ^https://[^/?#]+(/[^?#]*)?$ ]]; then
  echo "::error::R2_PUBLIC_BASE must be an https:// URL with no query or fragment, not '$R2_PUBLIC_BASE'."
  exit 1
fi

cname="$(head -n 1 "$site/CNAME" 2>/dev/null | tr -d '[:space:]' || true)"
if [[ -z "$cname" ]]; then
  echo "::error::$site/CNAME is missing, so the site origin to check CORS against is unknown."
  exit 1
fi
origin="https://$cname"

files=(runtime/lean.wasm runtime/lean.js modules/game-modules.tar.gz)
for file in "${files[@]}"; do
  if [[ ! -s "$lean/$file" ]]; then
    echo "::error::$lean/$file is missing or empty."
    exit 1
  fi
done

# The runtime and module bundle must stay paired, so one version names all
# three files.
sums="$(cd "$lean" && sha256sum "${files[@]}" | LC_ALL=C sort)"
version="$(printf '%s\n' "$sums" | sha256sum | cut -c1-16)"
prefix="visual-lean/$version"
base="$public_base/$prefix"

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
bytes_of() { stat -c %s "$1"; }

export AWS_DEFAULT_REGION=auto
# R2 rejects some of the newer default S3 integrity checksums.
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
endpoint="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
s3api() { aws s3api --endpoint-url "$endpoint" "$@"; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cache_control='public, max-age=31536000, immutable'

# put <source file> <key> <content type> [<content encoding>]
put() {
  local args=(--bucket "$R2_BUCKET" --key "$2" --body "$1" --content-type "$3" --cache-control "$cache_control")
  if [[ -n "${4:-}" ]]; then args+=(--content-encoding "$4"); fi
  echo "Uploading $2 ($(bytes_of "$1") bytes)"
  s3api put-object "${args[@]}" >/dev/null
}

# manifest.json is uploaded last, so its presence means the prefix is complete.
if head_error="$(s3api head-object --bucket "$R2_BUCKET" --key "$prefix/manifest.json" 2>&1 >/dev/null)"; then
  action='already uploaded by an earlier run; reused'
  echo "$prefix is complete in $R2_BUCKET; skipping the upload."
elif [[ "$head_error" == *'(404)'* ]]; then
  action='uploaded by this run'
  gzip -9 -n -c "$lean/runtime/lean.wasm" > "$work/lean.wasm.gz"
  gzip -9 -n -c "$lean/runtime/lean.js" > "$work/lean.js.gz"
  put "$work/lean.wasm.gz" "$prefix/runtime/lean.wasm" application/wasm gzip
  put "$work/lean.js.gz" "$prefix/runtime/lean.js" text/javascript gzip
  # Already gzip. The worker decompresses it itself, so it must not get a
  # Content-Encoding.
  put "$lean/modules/game-modules.tar.gz" "$prefix/modules/game-modules.tar.gz" application/gzip

  jq -n \
    --arg version "$version" \
    --arg uploaded "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg run "${GITHUB_SERVER_URL:-}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}" \
    --arg wasm_sha "$(sha256_of "$lean/runtime/lean.wasm")" --argjson wasm_bytes "$(bytes_of "$lean/runtime/lean.wasm")" \
    --argjson wasm_stored "$(bytes_of "$work/lean.wasm.gz")" \
    --arg js_sha "$(sha256_of "$lean/runtime/lean.js")" --argjson js_bytes "$(bytes_of "$lean/runtime/lean.js")" \
    --argjson js_stored "$(bytes_of "$work/lean.js.gz")" \
    --arg modules_sha "$(sha256_of "$lean/modules/game-modules.tar.gz")" \
    --argjson modules_bytes "$(bytes_of "$lean/modules/game-modules.tar.gz")" \
    '{
      version: $version,
      uploaded: $uploaded,
      run: $run,
      files: [
        { path: "runtime/lean.wasm", bytes: $wasm_bytes, sha256: $wasm_sha,
          contentType: "application/wasm", contentEncoding: "gzip", storedBytes: $wasm_stored },
        { path: "runtime/lean.js", bytes: $js_bytes, sha256: $js_sha,
          contentType: "text/javascript", contentEncoding: "gzip", storedBytes: $js_stored },
        { path: "modules/game-modules.tar.gz", bytes: $modules_bytes, sha256: $modules_sha,
          contentType: "application/gzip", storedBytes: $modules_bytes }
      ]
    }' > "$work/manifest.json"
  put "$work/manifest.json" "$prefix/manifest.json" application/json
else
  echo "::error::Could not check s3://$R2_BUCKET/$prefix/manifest.json:"
  echo "$head_error"
  exit 1
fi

# Read a response header (last occurrence, case-insensitive) from a curl -D dump.
header() {
  tr -d '\r' < "$2" | awk -v name="$1" '
    index(tolower($0), tolower(name) ":") == 1 { value = substr($0, length(name) + 2); sub(/^[ \t]+/, "", value); sub(/[ \t]+$/, "", value) }
    END { print value }'
}

failures=0
report=()

# verify <path> <content type> <content encoding or empty>
# Fetch through the public URL with the site's Origin and the browser's
# Accept-Encoding, and check what the client depends on.
verify() {
  local path="$1" want_type="$2" want_encoding="$3"
  local url="$base/$path" headers="$work/verify.headers" body="$work/verify.body"
  local status problems=()
  status="$(curl --silent --show-error --compressed --retry 3 --retry-delay 2 \
    -H "Origin: $origin" -D "$headers" -o "$body" -w '%{http_code}' "$url")" || status="curl failed"

  if [[ "$status" != 200 ]]; then
    problems+=("status $status")
  else
    local allow_origin expose type encoding
    allow_origin="$(header access-control-allow-origin "$headers")"
    expose="$(header access-control-expose-headers "$headers")"
    type="$(header content-type "$headers")"
    type="${type%%;*}"
    encoding="$(header content-encoding "$headers")"

    [[ "$allow_origin" == "$origin" || "$allow_origin" == '*' ]] \
      || problems+=("access-control-allow-origin '$allow_origin', expected '$origin' (bucket CORS policy)")
    # The worker reads Content-Encoding to decide whether to gunzip the module
    # bundle itself; browsers hide it cross-origin unless it is exposed.
    [[ "$expose" == '*' || ",${expose,,}," =~ ,[[:space:]]*content-encoding[[:space:]]*, ]] \
      || problems+=("access-control-expose-headers '$expose' lacks Content-Encoding (bucket CORS policy)")
    [[ "${type,,}" == "$want_type" ]] || problems+=("content-type '$type', expected '$want_type'")
    [[ "${encoding,,}" == "$want_encoding" ]] \
      || problems+=("content-encoding '$encoding', expected '${want_encoding:-none}'")
    local got_sha want_sha
    got_sha="$(sha256_of "$body")"
    want_sha="$(sha256_of "$lean/$path")"
    [[ "$got_sha" == "$want_sha" ]] || problems+=("decoded body sha256 $got_sha, expected $want_sha")
  fi

  if (( ${#problems[@]} )); then
    failures=$((failures + 1))
    local problem
    for problem in "${problems[@]}"; do echo "::error::$url: $problem"; done
    report+=("| \`$path\` | failed: $(IFS=';'; echo "${problems[*]}") |")
  else
    echo "Verified $url"
    report+=("| \`$path\` | ok ($(bytes_of "$lean/$path") bytes, ${want_encoding:-no} encoding) |")
  fi
}

verify runtime/lean.wasm application/wasm gzip
verify runtime/lean.js text/javascript gzip
verify modules/game-modules.tar.gz application/gzip ''

{
  echo '### Lean assets on R2'
  echo
  echo "Version \`$version\`, $action."
  echo
  echo "Base: $base"
  echo
  echo '| File | Public URL check |'
  echo '| --- | --- |'
  printf '%s\n' "${report[@]}"
  echo
} >> "$summary"

if (( failures )); then
  echo "::error::$failures Lean asset(s) failed verification through $public_base; not pointing the site at R2."
  echo 'The site was not deployed. See the errors above.' >> "$summary"
  exit 1
fi

jq -n --arg base "$base" '{ base: $base }' > "$lean/asset-base.json"
echo "Wrote $lean/asset-base.json -> $base"
echo "The site loads the Lean runtime and modules from \`$base\` (fallback: GitHub Pages)." >> "$summary"
