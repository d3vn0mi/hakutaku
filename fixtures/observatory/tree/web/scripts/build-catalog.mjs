// Builds the sky map's catalog, public/catalog.json, from a CSV of bright stars: name, right
// ascension and declination in degrees, and visual magnitude.
//
//   node scripts/build-catalog.mjs [input.csv] [output.json]
import { readFileSync, writeFileSync } from "node:fs";

function parseRow(line, lineNumber) {
  const [name, ...cells] = line.split(",").map((cell) => cell.trim());
  const [ra, dec, magnitude] = cells.map(Number);
  if (!name || [ra, dec, magnitude].some((n) => Number.isNaN(n))) {
    throw new Error(`line ${lineNumber}: not a star: ${line}`);
  }
  return { name, ra, dec, magnitude };
}

// The stars of a catalog CSV, brightest first.
export function buildCatalog(csv) {
  const [, ...rows] = csv.trim().split("\n");
  return rows
    .map((line, i) => parseRow(line, i + 2))
    .sort((a, b) => a.magnitude - b.magnitude);
}

const [input = "data/bright-stars.csv", output = "public/catalog.json"] =
  process.argv.slice(2);
const stars = buildCatalog(readFileSync(input, "utf8"));
writeFileSync(output, `${JSON.stringify(stars, null, 2)}\n`);
console.log(`wrote ${stars.length} stars to ${output}`);
