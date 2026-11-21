# observatory

A small observatory: a sky map for the browser, written in TypeScript, and an ephemeris
service, written in Python, that tells it where the planets are.

This repository is a synthetic sample. It was written to exercise code-intelligence tools, and
every name, address and number in it is made up or taken from public astronomy tables.

## Layout

- `web/`: the sky map, a Next.js app. The orbit solver lives in `web/src/orbits/`, the drawing
  in `web/src/sky/`, and the client for the ephemeris service in `web/src/api/`.
- `sim/`: the ephemeris service, the Python package `observatory` under `sim/src/`.
- `scripts/`: shell scripts that sync the sky data, check it and back it up.
- `deploy/`: the systemd unit and timer that run the sync every hour.
- `plugins/`: optional layers for the sky map, such as `aurora`.
- `docs/`: how it fits together, and how to run it.

## Running it

    cd web && npm install && npm run dev
    cd sim && python -m pip install -e . && ephemeris serve

`npm test` runs the sky map's tests, and `python -m pytest` in `sim/` the service's.

## Licence

MIT, as `LICENSE` says.
