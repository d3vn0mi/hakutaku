// Built paths (§5.7): a path to a built file, such as ./dist/index.js, maps back to its source.
import { posix } from "node:path";
import { parseJsonc } from "../profile/index.js";
import type { ManifestInput } from "./types.js";

export interface TsconfigDirs {
  dir: string;
  outDir?: string;
  rootDir?: string;
}

// The extensions a TypeScript build writes, and those of its sources, in the order tried.
const BUILT_EXT = [".d.ts", ".js", ".jsx", ".mjs", ".cjs"];
const SOURCE_EXT = [".ts", ".tsx", ".mts", ".cts"];
const BUILT_DIRS: ReadonlySet<string> = new Set(["dist", "build", "lib"]);

// `relative` joined to the directory `base` ("" or "." for the repo top) and normalized; null
// when it is empty, absolute, leaves the repo, names its top or ends in "/", none of which is a
// file of the repo.
export function repoPath(base: string, relative: string): string | null {
  if (relative === "" || relative.startsWith("/")) return null;
  const path = posix.normalize(posix.join(base, relative));
  if (
    path === "." ||
    path === ".." ||
    path.startsWith("../") ||
    path.endsWith("/")
  ) {
    return null;
  }
  return path;
}

// A directory the same way, with the repo top as "".
function repoDir(base: string, relative: string): string | null {
  if (relative.startsWith("/")) return null;
  const path = posix.normalize(posix.join(base, relative));
  if (path === ".") return "";
  if (path === ".." || path.startsWith("../") || path.startsWith("/"))
    return null;
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

// A candidate with its own extension, then, when it has a built one, with each source one.
function withExtensions(candidate: string): string[] {
  const ext = BUILT_EXT.find((e) => candidate.endsWith(e));
  if (ext === undefined) return [candidate];
  const stem = candidate.slice(0, -ext.length);
  return [candidate, ...SOURCE_EXT.map((e) => stem + e)];
}

// In order: the path as given; each tsconfig's outDir mapped to its rootDir (a tsconfig without
// both, or with either outside the repo, maps nothing); then the first and the last dist/,
// build/ or lib/ directory of the path as src/. Each candidate is tried with its own extension,
// then with .ts, .tsx, .mts and .cts in place of .js, .jsx, .mjs, .cjs or .d.ts. Only the first
// and the last such directory are tried: the first is a package's build directory (dist/lib/x.js),
// the last one below a package named lib (packages/lib/dist/x.js), and trying every one would
// cost a path of n segments n times its length. For the same reason, the tsconfigs are read
// once for each list (which must not change between calls) and looked up by the path's own
// directories, and one output directory maps from its first MAX_ROOTS different rootDirs only,
// so that a repo of many tsconfigs costs no path more than a few candidates.
export function sourceForBuilt(
  path: string,
  tsconfigs: ReadonlyArray<{ dir: string; outDir?: string; rootDir?: string }>,
  exists: (p: string) => boolean,
): string | null {
  if (exists(path)) return path;
  const { byOut, lengths } = mappingOf(tsconfigs);
  const found: Array<{ order: number; candidate: string }> = [];
  const add = (out: string, rest: string): void => {
    for (const { order, root } of byOut.get(out) ?? []) {
      found.push({ order, candidate: posix.join(root, rest) });
    }
  };
  add("", path);
  for (let i = path.indexOf("/"); i > 0; i = path.indexOf("/", i + 1)) {
    if (lengths.has(i)) add(path.slice(0, i), path.slice(i + 1));
  }
  found.sort((a, b) => a.order - b.order);
  const candidates = found.map((f) => f.candidate);
  const segments = path.split("/");
  const built: number[] = [];
  for (let i = 0; i < segments.length - 1; i++) {
    if (BUILT_DIRS.has(segments[i] ?? "")) built.push(i);
  }
  for (const i of new Set([built[0], built[built.length - 1]])) {
    if (i === undefined) continue;
    candidates.push(
      [...segments.slice(0, i), "src", ...segments.slice(i + 1)].join("/"),
    );
  }
  for (const candidate of candidates) {
    for (const c of withExtensions(candidate)) if (exists(c)) return c;
  }
  return null;
}

// The rootDirs one output directory maps from, at most: tsc builds of one outDir from more
// would overwrite each other's files.
const MAX_ROOTS = 8;

interface Mapping {
  // each output directory ("" for the repo top) -> its rootDirs, by the first tsconfig to map each
  byOut: Map<string, Array<{ order: number; root: string }>>;
  // the lengths of the output directories other than the repo top
  lengths: Set<number>;
}

const mappings = new WeakMap<object, Mapping>();

function mappingOf(
  tsconfigs: ReadonlyArray<{ dir: string; outDir?: string; rootDir?: string }>,
): Mapping {
  let mapping = mappings.get(tsconfigs);
  if (mapping !== undefined) return mapping;
  mapping = { byOut: new Map(), lengths: new Set() };
  tsconfigs.forEach((t, order) => {
    if (t.outDir === undefined || t.rootDir === undefined) return;
    const out = repoDir(t.dir, t.outDir);
    const root = repoDir(t.dir, t.rootDir);
    if (out === null || root === null) return;
    const roots = mapping.byOut.get(out) ?? [];
    if (roots.length >= MAX_ROOTS || roots.some((r) => r.root === root)) return;
    roots.push({ order, root });
    mapping.byOut.set(out, roots);
    if (out !== "") mapping.lengths.add(out.length);
  });
  mappings.set(tsconfigs, mapping);
  return mapping;
}

// outDir and rootDir of each of the profile's tsconfigs that is tracked and reads as JSONC,
// read as data. `extends` is not followed.
export function readTsconfigs(input: ManifestInput): TsconfigDirs[] {
  const out: TsconfigDirs[] = [];
  for (const path of input.profile.typescript.tsconfigs) {
    if (!input.paths.has(path)) continue;
    const text = input.read(path);
    if (text === null) continue;
    let config: unknown;
    try {
      config = parseJsonc(text);
    } catch {
      continue;
    }
    const options = isObject(config) ? config.compilerOptions : undefined;
    if (!isObject(options)) continue;
    const dirs: TsconfigDirs = { dir: posix.dirname(path) };
    if (typeof options.outDir === "string") dirs.outDir = options.outDir;
    if (typeof options.rootDir === "string") dirs.rootDir = options.rootDir;
    out.push(dirs);
  }
  return out;
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
