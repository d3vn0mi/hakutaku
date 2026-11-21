# Checks the sky data: each file exists, holds JSON, and is recent enough.
#
#   bash scripts/check-sky.sh [data-dir]
#
# MAX_AGE_HOURS, 6 by default, is how old a file may be; 0 skips the age check.
set -euo pipefail

. scripts/lib/common.sh

dir="${1:-$(data_dir)}"
max_age_hours="${MAX_AGE_HOURS:-6}"

check_json() {
  local file="$dir/$1"
  [ -s "$file" ] || die "$file is missing or empty"
  python3 -c 'import json, sys; json.load(open(sys.argv[1]))' "$file" ||
    die "$file is not valid JSON"
}

check_age() {
  local file="$dir/$1"
  local age=$(($(date +%s) - $(stat -c %Y "$file")))
  [ "$age" -le $((max_age_hours * 3600)) ] ||
    die "$file is older than $max_age_hours hours"
}

for name in elements.json catalog.json; do
  check_json "$name"
  if [ "$max_age_hours" -gt 0 ]; then
    check_age "$name"
  fi
done
log "the sky data in $dir is valid"
