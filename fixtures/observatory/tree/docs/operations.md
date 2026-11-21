# Operations

## The hourly sync

`deploy/observatory-sync.timer` runs `scripts/sync-sky.sh` every hour. A failed run leaves the
previous data in place; `scripts/check-sky.sh` fails the run if a file is missing, does not
parse, or is more than six hours old.

## Settings

The service reads its settings from the environment, and `sim/.env` holds the local ones:

- `EPHEMERIS_PORT`: the HTTP port, 8080 by default.
- `EPHEMERIS_CACHE_DIR`: where tables are cached.
- `EPHEMERIS_UPSTREAM_URL`: the service the elements come from.

## Backups

`scripts/backup-catalog.sh` copies the data directory to `/var/backups/observatory/<date>` and
keeps the seven newest copies. Restore one by copying it back over the data directory.
