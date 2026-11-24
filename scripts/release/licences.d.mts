// The types of licences.mjs: the licence allowlist, and the shipped tree it is checked against.

// The licences the shipped tree may use, as SPDX ids: MIT, ISC, 0BSD, BSD-2-Clause, BSD-3-Clause,
// Apache-2.0, OFL-1.1, Unlicense, CC0-1.0, Python-2.0 and BlueOak-1.0.0.
export const ALLOWED_LICENCES: ReadonlySet<string>;

// Whether an SPDX expression of ids, AND, OR and parentheses holds with allowlisted licences
// alone, AND binding tighter than OR. An id outside the allowlist, an id with a trailing "+", a
// WITH exception and anything malformed fail, as do UNLICENSED, "SEE LICENSE IN <file>" and the
// empty string.
export function licenceAllowed(expression: string): boolean;

// A manifest's licence as one expression: a string "license" is itself, "license": { type } is its
// type, and the legacy "licenses": [{ type }, ...] is its one type, or its types joined by OR in
// parentheses. Anything else, a blank string included, is null.
export function normaliseLicence(
  manifest: { license?: unknown; licenses?: unknown } | null,
): string | null;

// An entry of package-lock.json's "packages", which are keyed by location; "" is the project.
export interface LockEntry {
  name?: string;
  version?: string;
  license?: string;
  dev?: boolean;
}

export interface PackageLock {
  lockfileVersion: number;
  packages: Record<string, LockEntry>;
}

// The packages bundled into the viewer, as locations, unique and in path order: the package
// directory of each esbuild input after its last node_modules/ segment, a scoped name taking two
// segments, and node_modules/<name> for each devDependency whose name starts "@ibm/plex".
export function bundledLocations(
  metafile: { inputs: Record<string, unknown> },
  devDependencies: Record<string, string>,
): string[];

export interface ShippedPackage {
  name: string;
  version: string; // "UNKNOWN" where the lockfile names none
  licence: string | null; // null where neither the lockfile nor the manifest names one
  location: string;
  via: "dependency" | "bundled";
}

// Every package the package ships, once per location, in path order: each lockfile entry but ""
// that is not dev-only, as a dependency, and each bundled location, as bundled (a location that
// is both is bundled). The licence is the entry's, or else normaliseLicence of readManifest's
// manifest, by default the location's package.json read from the current directory. It throws
// for a bundled location that the lockfile lacks.
export function shippedPackages(
  lock: PackageLock,
  bundled: string[],
  readManifest?: (location: string) => object | null,
): ShippedPackage[];

// One line for each package whose licence is unknown or fails licenceAllowed, in the given order:
// "<name>@<version> (<location>, <via>): <licence, or UNKNOWN>".
export function licenceProblems(packages: ShippedPackage[]): string[];

// NOTICE's parts, as their "## " headings give them, in their order.
export const NOTICE_PARTS: readonly [
  "Bundled in the package",
  "Installed with the package",
  "Run as separate programs",
  "Runtime, not redistributed",
  "Development tools",
];

// An entry of NOTICE: its "### <name>" heading, the part it sits in, and its "<Key>: <value>"
// lines, each key's values in order (only Copyright may hold more than one).
export interface NoticeEntry {
  part: string;
  name: string;
  fields: Record<string, string[]>;
}

// NOTICE's parts and entries, after its header. It throws "unknown key <Key>" for a key other
// than Package, Version, Licence, Copyright, Use and Text, and throws as well for a key other
// than Copyright given twice, an empty value, an entry heading in the header, and any other line.
export function parseNotice(text: string): {
  parts: string[];
  entries: NoticeEntry[];
};

// The name of a licence file: /^(licen[cs]e|copying|ofl)([.-].*)?$/i.
export const LICENCE_FILE: RegExp;

// The names in a folder that LICENCE_FILE matches, regular files only, in path order.
export function licenceFiles(dir: string): string[];

// A copyright line, read from its start: "Copyright" (perhaps after "Portions", and before a
// "(c)" or "©") then a year or a capitalised word, or a "(c)" or "©" alone then a year or the
// word Copyright.
export const COPYRIGHT_LINE: RegExp;

// An entry's Copyright when no line of its licence text is a copyright line.
export const NOT_STATED: "not stated in the licence file";

// "THIRD_PARTY_LICENSES/" + name.replaceAll("/", "__") + ".txt"
export function textFileFor(name: string): string;

// The licence text of each bundled location under root, keyed by its textFileFor file, and the
// files of the packages that ship no licence file, to be written by hand.
export function generateTexts(
  root: string,
  bundled: string[],
): { texts: Map<string, string>; missing: string[] };
