# Scripts

Run each from the repository's top directory.

- `sync-sky.sh`: fetches the orbital elements, rebuilds the tables, then checks them. The
  systemd timer in `deploy/` runs it every hour.
- `check-sky.sh [dir]`: checks that the sky data parses and is fresh. CI runs it on the sample
  data in `sim/tests/data/`.
- `backup-catalog.sh`: copies the sky data to a dated backup and keeps the last seven.
- `lib/common.sh`: logging and checks the others source.
