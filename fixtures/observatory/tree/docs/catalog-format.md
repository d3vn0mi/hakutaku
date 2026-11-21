# The catalog format

Both halves read the bright-star catalog as CSV with a header row:

    name,ra_deg,dec_deg,magnitude
    Sirius,101.287,-16.716,-1.46

- `ra_deg`: right ascension, in degrees from 0 to 360.
- `dec_deg`: declination, in degrees from -90 to 90.
- `magnitude`: visual magnitude; smaller is brighter, and the brightest stars are negative.

`web/scripts/build-catalog.mjs` turns the CSV into the JSON the sky map loads, sorted
brightest first. The service reads its own copy in `sim/src/observatory/catalog/`.
