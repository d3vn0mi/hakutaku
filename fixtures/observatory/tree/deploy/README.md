# Deploying the sync

The sync fetches the latest orbital elements, rebuilds the ephemeris tables and checks them.
`observatory-sync.timer` starts `observatory-sync.service` every hour, and the service runs
`scripts/sync-sky.sh` from the checkout in `/opt/observatory`.

Install both units for the user that owns the checkout:

    cp deploy/observatory-sync.service deploy/observatory-sync.timer ~/.config/systemd/user/
    systemctl --user daemon-reload
    systemctl --user enable --now observatory-sync.timer

`journalctl --user -u observatory-sync.service` shows each run. The data lands in
`/var/lib/observatory`, or wherever `OBSERVATORY_DATA` points.
