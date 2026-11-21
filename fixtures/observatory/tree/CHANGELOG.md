# Changelog

## 0.4.0

- The sky map draws a star field behind the planets, and legends name the data source.
- `export-sky` prints the brightest stars as a table or as CSV.
- The ephemeris service answers `GET /where`, and `ephemeris table` prints a body's places.
- The orbit solver moved from `orbit.ts` to `kepler.ts`.

## 0.3.0

- Plugins can add layers to the sky map; `aurora` is the first.
- The sync runs hourly from a systemd timer.

## 0.2.0

- The ephemeris service builds interpolated tables for each planet.

## 0.1.0

- The orbit solver and the first sky map.
