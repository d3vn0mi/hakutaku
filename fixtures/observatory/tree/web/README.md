# The sky map

A Next.js app that draws the planets on their orbits over a field of bright stars.

    npm install
    npm run dev       # http://localhost:3000
    npm test          # the unit tests, in UTC
    npm run catalog   # rebuilds public/catalog.json from data/bright-stars.csv

`npm run build` also compiles `export-sky`, a command that prints the brightest stars:

    npx export-sky --limit 5
    npx export-sky --csv > stars.csv

The orbit solver is in `src/orbits/kepler.ts`. Imports may use the alias `@obs/web/` for `src/`.
