# Copies the sky data into a dated backup directory, and keeps the seven newest.
#
#   bash scripts/backup-catalog.sh
set -euo pipefail

. scripts/lib/common.sh

src="$(data_dir)"
backups="${OBSERVATORY_BACKUPS:-/var/backups/observatory}"
stamp="$(date -u +%Y%m%d)"

prune() {
  find "$backups" -mindepth 1 -maxdepth 1 -type d | sort | head -n -7 | xargs -r rm -rf
}

mkdir -p "$backups/$stamp"
cp -a "$src"/. "$backups/$stamp"/
prune
log "backed up $src to $backups/$stamp"
