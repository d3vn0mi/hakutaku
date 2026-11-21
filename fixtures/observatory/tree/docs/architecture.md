# Architecture

The observatory has two halves that meet over HTTP.

## The sky map (`web/`)

- `src/orbits/` solves Kepler's equation. `kepler.ts` holds `solveKepler` and the `Orbit`
  class; `units.ts` and `constants.ts` hold conversions and constants.
- `src/sky/` draws. A frame clears the canvas, draws each layer (the star field, then plugin
  layers), then each body at its place. A body is anything with a `name` and a place at time
  `t`: the interface `Body` in `body.ts`. `Orbit` fits it without naming it.
- `src/api/` talks to the ephemeris service, with a cache and retries.
- `src/plugins/` loads plugins from the path their manifest gives.
- `app/` is the Next.js front end: the page, and the `/api/stars` route.

## The ephemeris service (`sim/`)

`observatory.ephemeris` builds a table of each planet's places around the requested day, and
interpolates between its rows. `observatory.catalog` reads the bright-star catalog, and
`observatory.sky` turns places into what an observer sees.

## Boundaries

One dependency rule holds across the sky map: `src/sky/` never imports `src/api/`, since drawing
should not know where the data came from. The legend breaks it today, to show the source's
host name.
