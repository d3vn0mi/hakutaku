# The ephemeris service

The Python package `observatory`, under `src/`: tables of where the planets are, the
bright-star catalog, and an HTTP server that answers from them.

    python -m pip install -e .
    ephemeris table Mars --days 7
    ephemeris serve --port 8080
    python -m pytest

Settings come from the environment; `.env` holds the local ones (see `docs/operations.md`).
The image built from `Dockerfile` runs `ephemeris serve` on port 8080.
