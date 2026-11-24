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
