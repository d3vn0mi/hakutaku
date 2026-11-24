// The licences of the shipped tree: the package's production dependencies, read from
// package-lock.json, and every package bundled into the viewer, read from esbuild's record of
// the build. Each one must be under a licence on the allowlist below; the engines are installed,
// not shipped, so it does not gate them.
//
// It runs under plain node, so it never imports src/, and it sorts with JS < on strings, the
// UTF-16 order of hakutaku's comparePaths.
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The licences the shipped tree may use, as SPDX ids. A package under any other licence is
// reported, never let through: widening this list changes the project's licence policy.
export const ALLOWED_LICENCES = new Set([
  "MIT",
  "ISC",
  "0BSD",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "OFL-1.1",
  "Unlicense",
  "CC0-1.0",
  "Python-2.0",
  "BlueOak-1.0.0",
]);

const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The words of an SPDX expression: each parenthesis, and each run of other characters between
// spaces.
const WORDS = /[()]|[^\s()]+/g;
const OPERATORS = new Set(["AND", "OR", "WITH"]);

// A word that can stand for a licence: not an operator and not a parenthesis.
const isId = (word) =>
  word !== undefined && !OPERATORS.has(word) && word !== "(" && word !== ")";

// Whether an SPDX expression holds with allowlisted licences alone. It reads ids, AND, OR and
// parentheses, AND binding tighter than OR: OR holds when either side does, AND when both do.
// An id holds when the allowlist names it as it is spelt, so an id with a trailing "+" (that
// version or any later one) does not; a term with a WITH exception does not hold either. Anything
// that is not such an expression, such as UNLICENSED, "SEE LICENSE IN <file>" or the empty
// string, is false, never an error.
export function licenceAllowed(expression) {
  if (typeof expression !== "string") return false;
  const words = expression.match(WORDS) ?? [];
  let at = 0;
  const malformed = () => {
    throw new SyntaxError(`not an SPDX expression: ${expression}`);
  };
  // each side is read whole before the two are joined, so that a malformed right side is found
  const anyOf = () => {
    let holds = allOf();
    while (words[at] === "OR") {
      at++;
      holds = allOf() || holds;
    }
    return holds;
  };
  const allOf = () => {
    let holds = term();
    while (words[at] === "AND") {
      at++;
      holds = term() && holds;
    }
    return holds;
  };
  const term = () => {
    const word = words[at++];
    if (word === "(") {
      const holds = anyOf();
      if (words[at++] !== ")") malformed();
      return holds;
    }
    if (!isId(word)) malformed();
    if (words[at] === "WITH") {
      at++;
      if (!isId(words[at++])) malformed();
      return false;
    }
    return ALLOWED_LICENCES.has(word);
  };
  try {
    const holds = anyOf();
    return at === words.length && holds;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

// A string that names something: not empty, and not only spaces.
const named = (value) =>
  typeof value === "string" && value.trim() !== "" ? value : null;

// A manifest's licence as one SPDX expression: a string "license" is itself, "license": { type }
// is its type, and the legacy "licenses": [{ type }, ...] is its one type, or its types joined by
// OR in parentheses. Anything else, a blank string included, is null.
export function normaliseLicence(manifest) {
  if (manifest === null || typeof manifest !== "object") return null;
  const { license, licenses } = manifest;
  const single =
    named(license) ??
    (license !== null && typeof license === "object"
      ? named(license.type)
      : null);
  if (single !== null) return single;
  if (!Array.isArray(licenses) || licenses.length === 0) return null;
  const types = licenses.map((entry) =>
    entry !== null && typeof entry === "object" ? named(entry.type) : null,
  );
  if (types.includes(null)) return null;
  return types.length === 1 ? types[0] : `(${types.join(" OR ")})`;
}

// Each node_modules/ that is a whole segment of a path: at its start, or after a slash.
const NODE_MODULES = /(?<![^/])node_modules\//g;

// Where the package holding a path is installed, after the path's last node_modules/ segment,
// a scoped name taking two segments: "node_modules/a/node_modules/@b/c/x.js" is
// "node_modules/a/node_modules/@b/c". Null for a path outside node_modules/.
function packageLocation(path) {
  const last = [...path.matchAll(NODE_MODULES)].at(-1);
  if (last === undefined) return null;
  const start = last.index + last[0].length;
  const parts = path.slice(start).split("/");
  const name = parts[0].startsWith("@")
    ? parts.slice(0, 2).join("/")
    : parts[0];
  return path.slice(0, start) + name;
}

// The packages bundled into the viewer, as locations, unique and in path order: the package of
// each esbuild input under node_modules/, and node_modules/<name> for each devDependency whose
// name starts "@ibm/plex", since the build copies the fonts rather than importing them.
export function bundledLocations(metafile, devDependencies) {
  const locations = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const location = packageLocation(input);
    if (location !== null) locations.add(location);
  }
  for (const name of Object.keys(devDependencies)) {
    if (name.startsWith("@ibm/plex")) locations.add(`node_modules/${name}`);
  }
  return [...locations].sort(byString);
}

// A location's package.json, read from the current directory, or null where there is none.
function readManifestFile(location) {
  try {
    return JSON.parse(readFileSync(join(location, "package.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// The name a package is installed under: its location after the last node_modules/ segment.
function installedName(location) {
  const last = [...location.matchAll(NODE_MODULES)].at(-1);
  return last === undefined
    ? location
    : location.slice(last.index + last[0].length);
}

// Every package the package ships, once per location, in path order: each lockfile entry but the
// project's own ("") that is not dev-only, as a dependency, and each bundled location, as bundled.
// A location that is both is listed once, as bundled. A package's name is its entry's name, or
// else the name it is installed under; its licence is its entry's licence, or else what
// normaliseLicence reads from its manifest, which readManifest gives (by default, the
// location's package.json, from the current directory). A bundled location the lockfile lacks is
// an error.
export function shippedPackages(
  lock,
  bundled,
  readManifest = readManifestFile,
) {
  const via = new Map();
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (location !== "" && entry?.dev !== true) via.set(location, "dependency");
  }
  for (const location of bundled) {
    if (!Object.hasOwn(lock.packages, location)) {
      throw new Error(
        `${location} is bundled, but package-lock.json has no entry for it`,
      );
    }
    via.set(location, "bundled");
  }
  return [...via.keys()].sort(byString).map((location) => {
    const entry = lock.packages[location] ?? {};
    return {
      name: named(entry.name) ?? installedName(location),
      version: named(entry.version) ?? "UNKNOWN",
      licence:
        named(entry.license) ??
        normaliseLicence(readManifest(location) ?? null),
      location,
      via: via.get(location),
    };
  });
}

// One line for each package whose licence is unknown, or does not hold with allowlisted licences
// alone: "<name>@<version> (<location>, <via>): <licence, or UNKNOWN>".
export function licenceProblems(packages) {
  return packages
    .filter((p) => p.licence === null || !licenceAllowed(p.licence))
    .map(
      (p) =>
        `${p.name}@${p.version} (${p.location}, ${p.via}): ${p.licence ?? "UNKNOWN"}`,
    );
}
