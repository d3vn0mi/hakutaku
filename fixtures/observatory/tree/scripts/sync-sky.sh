#!/usr/bin/env bash
# Fetches the latest orbital elements, rebuilds the ephemeris tables and checks the result.
# Run it from the repository's top directory, as deploy/observatory-sync.service does hourly.
#
#   scripts/sync-sky.sh [--quiet]
set -euo pipefail

. scripts/lib/common.sh

quiet=0
if [ "${1:-}" = "--quiet" ]; then
  quiet=1
fi

say() {
  [ "$quiet" -eq 1 ] || log "$@"
}

fetch_elements() {
  curl --fail --silent --show-error \
    --output "$1/elements.source.json" \
    "https://ephemeris.example.org/v1/elements"
}

require curl
require python3

dest="$(data_dir)"
mkdir -p "$dest"

say "fetching orbital elements"
fetch_elements "$dest"
say "rebuilding the ephemeris tables"
PYTHONPATH=sim/src python3 -m observatory.tools.rebuild --out "$dest"
bash scripts/check-sky.sh "$dest"
log "sky data synced to $dest"
