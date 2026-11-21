# Helpers shared by the observatory's scripts. Source this file from the repository's top
# directory; it does nothing when run on its own.

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

die() {
  log "error: $*"
  exit 1
}

require() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is not installed"
}

data_dir() {
  printf '%s\n' "${OBSERVATORY_DATA:-/var/lib/observatory}"
}
