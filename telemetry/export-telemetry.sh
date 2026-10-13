#!/bin/sh
# Export telemetry with tools/export.js (docs/exports.md).
#
# Usage:
#   ./export-telemetry.sh [OUTPUT] [export options...]
#
#   OUTPUT defaults to ./telemetry-export-<UTC timestamp>.csv; its extension
#   picks the format (.csv machine export, .jsonl full machine export, .xlsx
#   human export with every cell typed as text). Options are passed through,
#   e.g. --since 2026-10-01 --until 2026-10-08 --game g/local/NNG4 --resume.
#
# Connection (first match wins):
#   DATABASE_URL set  -> run node locally with it as the read-only exporter
#                        connection (use the telemetry_reader role's URL)
#   otherwise         -> `docker compose run --rm exporter` from this
#                        directory's compose.yml (profile "tools", role
#                        telemetry_reader); the file is written to EXPORT_DIR
#                        (default ./exports) and then moved to OUTPUT
#
# The machine CSV keeps the columns and field meanings of earlier exports.
# Rows are now grouped by pseudonymous user in user-id order rather than by
# first-seen time; see docs/exports.md. Do not open the CSV in a spreadsheet
# application: cells beginning with =, +, - or @ may be treated as formulas.
# Use the .xlsx export for viewing. Heavy exports compete with live intake:
# prefer filters, quiet hours, or a restored backup on another machine.

set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT="${1:-./telemetry-export-$(date -u +%Y%m%dT%H%M%SZ).csv}"
[ "$#" -gt 0 ] && shift

case "$OUT" in
  *.jsonl) format=jsonl ;;
  *.xlsx) format=xlsx ;;
  *) format=csv ;;
esac

if [ -n "${DATABASE_URL:-}" ]; then
  # The URL reaches node through the environment, never the command line.
  READER_DATABASE_URL="$DATABASE_URL" exec nice -n 10 node "$here/tools/export.js" \
    --format "$format" --output "$OUT" "$@"
fi

export_dir="${EXPORT_DIR:-$here/exports}"
mkdir -p "$export_dir"
name=$(basename -- "$OUT")
EXPORT_DIR="$export_dir" docker compose -f "$here/compose.yml" --profile tools run --rm -T exporter \
  --format "$format" --output "/exports/$name" "$@"
if [ "$(cd -- "$(dirname -- "$OUT")" && pwd)/$name" != "$export_dir/$name" ]; then
  mv -- "$export_dir/$name" "$OUT"
  mv -- "$export_dir/$name.manifest.json" "$OUT.manifest.json"
fi
echo "Wrote $OUT"
