// The licences of the shipped tree: the package's production dependencies, read from
// package-lock.json, and every package bundled into the viewer, read from esbuild's record of
// the build. Each one must be under a licence on the allowlist below; the engines are installed,
// not shipped, so it does not gate them. Then NOTICE, the attribution of every project hakutaku
// uses, and the full licence texts in THIRD_PARTY_LICENSES/ of what the package bundles, which
// this module writes:
//
//   node scripts/release/licences.mjs --write    (after npm run build)
//
// It writes the text of each bundled package that ships a licence file, prints "write by hand:
// <file>" for each one that ships none, then "licences: <n> texts written", and exits 0. A usage
// error prints the usage on stderr and exits 2.
//
// It runs under plain node, so it never imports src/, and it sorts with JS < on strings, the
// UTF-16 order of hakutaku's comparePaths.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

// NOTICE's parts, as their "## " headings give them, in their order.
export const NOTICE_PARTS = Object.freeze([
  "Bundled in the package",
  "Installed with the package",
  "Run as separate programs",
  "Runtime, not redistributed",
  "Development tools",
]);

// The keys an entry may hold. Copyright alone may be given more than once.
const NOTICE_KEYS = new Set([
  "Package",
  "Version",
  "Licence",
  "Copyright",
  "Use",
  "Text",
]);

// NOTICE's parts and entries. Every line before the first "## <part>" heading is the header,
// which is not read. From there on, a line is a "## <part>" heading, a "### <name>" heading that
// opens an entry of that part, a "<Key>: <value>" line of the open entry, or blank, which closes
// the entry. A key outside NOTICE_KEYS throws "unknown key <Key>"; so do a key other than
// Copyright given twice, an empty value, an entry heading in the header, and any other line.
export function parseNotice(text) {
  const parts = [];
  const entries = [];
  let part;
  let entry;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      part = line.slice(3);
      parts.push(part);
      entry = undefined;
    } else if (part === undefined) {
      if (line.startsWith("### ")) {
        throw new Error(`an entry before the first part: ${line.slice(4)}`);
      }
    } else if (line.startsWith("### ")) {
      entry = { part, name: line.slice(4), fields: {} };
      entries.push(entry);
    } else if (line === "") {
      entry = undefined;
    } else {
      const colon = line.indexOf(": ");
      if (entry === undefined || colon < 0) {
        throw new Error(`not a line of an entry: ${line}`);
      }
      const key = line.slice(0, colon);
      const value = line.slice(colon + 2);
      if (!NOTICE_KEYS.has(key)) throw new Error(`unknown key ${key}`);
      if (value.trim() === "")
        throw new Error(`${entry.name}: ${key} is empty`);
      const values = entry.fields[key];
      if (values === undefined) entry.fields[key] = [value];
      else if (key === "Copyright") values.push(value);
      else throw new Error(`${entry.name}: ${key} given twice`);
    }
  }
  return { parts, entries };
}

// The name of a licence file: LICENSE, LICENCE, COPYING or OFL, in any case, alone or followed by
// a dot or a hyphen and anything, such as LICENSE.txt, LICENSE-MIT or OFL.txt.
export const LICENCE_FILE = /^(licen[cs]e|copying|ofl)([.-].*)?$/i;

// The licence files in a folder, by name, in path order: each regular file, or link to one, whose
// name LICENCE_FILE matches. A folder that does not exist throws.
export function licenceFiles(dir) {
  return readdirSync(dir)
    .filter(
      (name) => LICENCE_FILE.test(name) && statSync(join(dir, name)).isFile(),
    )
    .sort(byString);
}

// A copyright line of a licence text, read from its start: "Copyright" or "COPYRIGHT", perhaps
// after "Portions" and before a "(c)" or "©", then a year or a capitalised word; or a "(c)" or
// "©" alone, then a year or the word Copyright. Licence prose that names copyright does not match,
// nor does the Apache License's clause "(c) You must retain ...", which states no copyright.
export const COPYRIGHT_LINE =
  /^\s*(?:Portions\s+)?(?:(?:[Cc]opyright|COPYRIGHT)\s*(?:\([Cc]\)|©)?\s*(?:\d{4}|[A-Z][a-z])|(?:\([Cc]\)|©)\s*(?:\d{4}|[Cc]opyright|COPYRIGHT))/;

// An entry's Copyright when no line of its licence text is a copyright line.
export const NOT_STATED = "not stated in the licence file";

// Where the licence text of a bundled package is kept: its name, with each "/" written "__".
export function textFileFor(name) {
  return `THIRD_PARTY_LICENSES/${name.replaceAll("/", "__")}.txt`;
}

// A licence file's text with its lines ended by line feeds alone, as the repository stores every
// text file (.gitattributes), and a line feed at its end: so that each section header below
// starts a line, and a text written here equals the one a checkout holds.
function asStored(text) {
  const lf = text.replaceAll("\r\n", "\n");
  return lf === "" || lf.endsWith("\n") ? lf : `${lf}\n`;
}

// The licence text of each bundled package, read from its folder under root, keyed by its
// textFileFor file:
//
//   <name> <version>
//   Licence: <expression>
//
//   ---- <licence file name> ----
//   <that file's text>
//
// with one "---- <file> ----" section per licence file, in path order, a blank line between two
// sections; each text is the file's word for word, but for its line endings (asStored). The name
// and version are the package.json's, and the licence is what normaliseLicence reads there, or
// UNKNOWN. A package that ships no licence file has no text: its file is listed in missing, in
// the order given, to be written by hand. Two bundled packages of one name throw, since NOTICE
// credits a package once.
export function generateTexts(root, bundled) {
  const texts = new Map();
  const missing = [];
  for (const location of bundled) {
    const dir = join(root, location);
    const manifest = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8"),
    );
    const name = named(manifest.name) ?? installedName(location);
    const file = textFileFor(name);
    if (texts.has(file) || missing.includes(file)) {
      throw new Error(`two bundled packages are named ${name}`);
    }
    const files = licenceFiles(dir);
    if (files.length === 0) {
      missing.push(file);
      continue;
    }
    const sections = files.map(
      (f) => `---- ${f} ----\n${asStored(readFileSync(join(dir, f), "utf8"))}`,
    );
    texts.set(
      file,
      [
        `${name} ${named(manifest.version) ?? "UNKNOWN"}`,
        `Licence: ${normaliseLicence(manifest) ?? "UNKNOWN"}`,
        "",
        sections.join("\n"),
      ].join("\n"),
    );
  }
  return { texts, missing };
}

const USAGE = "usage: node scripts/release/licences.mjs --write";

// The repository: two folders above this module.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

// The CLI: the texts of the packages the last build bundled, from .cache/viewer-meta.json and
// package.json's devDependencies, written into THIRD_PARTY_LICENSES/. It returns the exit code.
function main(args) {
  if (args.length !== 1 || args[0] !== "--write") {
    console.error(USAGE);
    return 2;
  }
  const meta = join(ROOT, ".cache", "viewer-meta.json");
  if (!existsSync(meta)) {
    console.error(
      "licences: no .cache/viewer-meta.json: run npm run build first",
    );
    return 1;
  }
  const { devDependencies = {} } = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  );
  const { texts, missing } = generateTexts(
    ROOT,
    bundledLocations(JSON.parse(readFileSync(meta, "utf8")), devDependencies),
  );
  mkdirSync(join(ROOT, "THIRD_PARTY_LICENSES"), { recursive: true });
  for (const [file, text] of texts) writeFileSync(join(ROOT, file), text);
  for (const file of missing) console.log(`write by hand: ${file}`);
  console.log(`licences: ${texts.size} texts written`);
  return 0;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main(process.argv.slice(2));
}
