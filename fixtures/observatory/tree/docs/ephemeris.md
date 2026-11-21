# The ephemeris service

`ephemeris serve` answers one question over HTTP:

    GET /where?body=Mars&at=2026-09-01T12:00:00Z

with the body's heliocentric `x`, `y` and `z` in astronomical units. Without `at`, it answers
for now.

## Tables

For each body, the service builds a table of places one day apart, covering sixty days around
the day asked for. A later question inside the table is answered by a cubic through the four
nearest rows; one outside it builds a new table. Times are converted from UTC to terrestrial
time first, since the elements are given in TT.

## The command line

- `ephemeris table Mars --days 7` prints a week of places.
- `ephemeris serve --port 8080` starts the HTTP server.
- `python -m observatory.tools.rebuild --out DIR` writes every planet's table as JSON.
