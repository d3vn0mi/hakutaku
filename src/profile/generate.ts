// The profile generator (§8.3): a layout profile read from a snapshot's files, as data. Nothing
// in the snapshot runs, and nothing outside it is read: the walk follows no symbolic link, and
// opens no file that is not regular, so a FIFO never blocks it.
//
// - Aliases come from each tsconfig*.json's compilerOptions.paths, and from each package.json
//   with a name: its exports, or, without exports, its main and its src/ directory. A key that
//   two sources map to different targets is a conflict, and stays out of the profile.
// - typescript.tsconfigs lists every tsconfig*.json. python.roots come from the __init__.py
//   files, and python.singleFileModules from pyproject.toml's [tool.setuptools] py-modules.
// - components is [] (hakutaku finds them), and every other field is DEFAULT_PROFILE's.
// - A package.json or tsconfig*.json under a node_modules directory gives no alias, tsconfig or
//   warning: Node finds such a package by itself, and two copies of one package would conflict.
//
// A file that cannot be read or does not parse gives nothing, and a file over the source cap is
// not read, as export keeps only its metadata. Every list is in path order, and the aliases are
// written in that order, so the profile's JSON does not depend on the order in which the file
// system lists the files.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  type Stats,
} from "node:fs";
import { join, posix } from "node:path";
import { classifyFile, computeComponents } from "../extract/classify.js";
import {
  isObject,
  repoPath,
  type TsconfigDirs,
} from "../manifests/built-paths.js";
import {
  type ManifestInput,
  pythonModuleIndex,
  readEntryPoints,
  sourceForBuilt,
} from "../manifests/index.js";
import {
  comparePaths,
  type FileKind,
  type GitMode,
  matchGlob,
} from "../model/index.js";
import { parseJsonc } from "./formats/jsonc.js";
import { parseTomlSubset } from "./formats/toml.js";
import { DEFAULT_PROFILE } from "./load.js";
import type { Profile } from "./types.js";

// interfaces §3.7's answer, plus warnings (an addition): each extends into node_modules.
export interface GenerateResult {
  profile: Profile;
  conflicts: string[];
  found: {
    aliases: number;
    pythonRoots: string[];
    components: string[];
    launchManifests: number;
  };
  warnings: string[];
}

// The source cap: export keeps only the metadata of a larger file.
const SOURCE_CAP = 1_048_576;
// What classifyFile reads of a file.
const HEAD_BYTES = 8000;
// The conditions an export's target is looked up under, in this order.
const CONDITIONS = ["types", "import", "node", "default", "require"] as const;
// A name Python can import, as str.isidentifier() reads one (src/manifests/python-modules.ts).
const IDENTIFIER = /^[\p{XID_Start}_]\p{XID_Continue}*$/u;
// The files that make their directory a package root (§5.1).
const PACKAGE_MANIFESTS: ReadonlySet<string> = new Set([
  "package.json",
  "pyproject.toml",
  "setup.cfg",
]);

const decoder = new TextDecoder();

export async function generateProfile(
  snapshotDir: string,
): Promise<GenerateResult> {
  const files = listFiles(snapshotDir);
  const sorted = files.map((file) => file.path);
  const paths: ReadonlySet<string> = new Set(sorted);
  // A file's text, or null when it cannot be read or is over the source cap.
  const read = (path: string): string | null => {
    if (!paths.has(path)) return null;
    const bytes = readBytes(join(snapshotDir, path), SOURCE_CAP, true);
    return bytes === null ? null : decoder.decode(bytes);
  };
  // A file's JSONC value, or undefined when it cannot be read or does not parse.
  const readJsonc = (path: string): unknown => {
    const text = read(path);
    if (text === null) return undefined;
    try {
      return parseJsonc(text);
    } catch {
      return undefined;
    }
  };

  const warnings: string[] = [];
  const aliases = new Map<string, string[][]>(); // key -> each different target list
  const add = (key: string, targets: ReadonlyArray<string | null>): void => {
    // TypeScript allows one "*" in a key and in each of its targets
    if (stars(key) > 1) return;
    const list = [
      ...new Set(
        targets.filter((t): t is string => t !== null && stars(t) <= 1),
      ),
    ];
    if (list.length === 0) return;
    const lists = aliases.get(key);
    if (lists === undefined) aliases.set(key, [list]);
    else if (!lists.some((l) => compareLists(l, list) === 0)) lists.push(list);
  };

  const tsconfigs = sorted.filter(
    (path) => !vendored(path) && matchGlob("tsconfig*.json", path),
  );
  const tsconfigDirs: TsconfigDirs[] = [];
  for (const path of tsconfigs) {
    const config = readJsonc(path);
    if (!isObject(config)) continue;
    for (const spec of specsOf(config.extends)) {
      if (intoNodeModules(spec)) {
        warnings.push(`${path}: extends ${spec} was not resolved`);
      }
    }
    const options = config.compilerOptions;
    if (!isObject(options)) continue;
    const dir = posix.dirname(path);
    const dirs: TsconfigDirs = { dir };
    if (typeof options.outDir === "string") dirs.outDir = options.outDir;
    if (typeof options.rootDir === "string") dirs.rootDir = options.rootDir;
    tsconfigDirs.push(dirs);
    if (!isObject(options.paths)) continue;
    // each target relative to baseUrl, itself relative to the tsconfig's directory, else to
    // that directory; an absolute one, or one leaving the repo, is left out
    const { baseUrl } = options;
    const base =
      typeof baseUrl !== "string"
        ? dir
        : baseUrl.startsWith("/")
          ? null
          : posix.join(dir, baseUrl);
    if (base === null) continue;
    for (const [key, targets] of Object.entries(options.paths)) {
      if (!Array.isArray(targets)) continue;
      add(
        key,
        targets.map((t: unknown) =>
          typeof t === "string" ? repoPath(base, t) : null,
        ),
      );
    }
  }

  for (const path of sorted) {
    if (posix.basename(path) !== "package.json" || vendored(path)) continue;
    const manifest = readJsonc(path);
    if (!isObject(manifest)) continue;
    const { name } = manifest;
    if (typeof name !== "string" || name === "") continue;
    const dir = posix.dirname(path);
    // a path relative to the package, mapped to its source; in a pattern, "*" stands for one
    // or more characters of a tracked path, and the found target drops an extension
    // TypeScript adds itself
    const source = (target: string, pattern: boolean): string | null => {
      const built = repoPath(dir, target);
      if (built === null) return null;
      if (!pattern || stars(built) !== 1) {
        return sourceForBuilt(built, tsconfigDirs, (p) => paths.has(p));
      }
      const found = sourceForBuilt(built, tsconfigDirs, (p) =>
        matches(sorted, p),
      );
      return found === null ? null : withoutImpliedExtension(found);
    };
    if (manifest.exports !== undefined && manifest.exports !== null) {
      for (const [key, value] of subpathsOf(manifest.exports)) {
        if (key !== "." && !key.startsWith("./")) continue;
        const target = firstString(value);
        if (target === null || !isExportTarget(target)) continue;
        add(name + key.slice(1), [source(target, stars(key) === 1)]);
      }
      continue;
    }
    if (typeof manifest.main === "string") {
      add(name, [source(manifest.main, false)]);
    }
    const src = posix.join(dir, "src");
    if (!under(sorted, `${src}/`).next().done) add(`${name}/*`, [`${src}/*`]);
  }

  const entries: Array<[string, string[]]> = [];
  const conflicts: string[] = [];
  for (const key of [...aliases.keys()].sort(comparePaths)) {
    const [first, ...others] = (aliases.get(key) ?? []).sort(compareLists);
    if (first === undefined) continue;
    if (others.length === 0) entries.push([key, first]);
    for (const other of others) {
      conflicts.push(
        `two packages export ${JSON.stringify(key)}: ${shown(first)} and ${shown(other)}; name one in the profile`,
      );
    }
  }

  // The roots: from each directory holding an __init__.py ("" for the repo top), up while its
  // parent holds one too; the root is the topmost one's parent, and the repo top, ".", at most.
  const packages = new Set<string>();
  for (const path of sorted) {
    if (posix.basename(path) === "__init__.py") packages.add(parentOf(path));
  }
  const roots = new Set<string>();
  for (const dir of packages) {
    let top = dir;
    while (top !== "" && packages.has(parentOf(top))) top = parentOf(top);
    const root = parentOf(top); // "" for a package at, or directly under, the repo top
    roots.add(root === "" ? "." : root);
  }

  const modules = new Set<string>();
  for (const path of sorted) {
    if (posix.basename(path) !== "pyproject.toml") continue;
    const text = read(path);
    if (text === null) continue;
    const { tool } = parseTomlSubset(text);
    const setuptools = isObject(tool) ? tool.setuptools : undefined;
    const names = isObject(setuptools) ? setuptools["py-modules"] : undefined;
    if (!Array.isArray(names)) continue;
    const dir = posix.dirname(path);
    for (const name of names) {
      if (typeof name !== "string" || !IDENTIFIER.test(name)) continue;
      const file = [
        posix.join(dir, `${name}.py`),
        posix.join(dir, "src", `${name}.py`),
      ].find((p) => paths.has(p));
      if (file !== undefined) modules.add(file);
    }
  }

  const profile = structuredClone(DEFAULT_PROFILE);
  profile.typescript = { aliases: Object.fromEntries(entries), tsconfigs };
  profile.python = {
    roots: [...roots].sort(comparePaths),
    singleFileModules: [...modules].sort(comparePaths),
  };

  const kinds = new Map<string, FileKind>();
  for (const path of sorted) {
    const head =
      readBytes(join(snapshotDir, path), HEAD_BYTES, false) ??
      new Uint8Array(0);
    kinds.set(path, classifyFile(path, head, profile).kind);
  }
  const packageRoots = new Set<string>();
  for (const path of sorted) {
    const dir = posix.dirname(path);
    if (PACKAGE_MANIFESTS.has(posix.basename(path)) && dir !== ".") {
      packageRoots.add(`${dir}/`);
    }
  }
  // computeComponents reads no line count; with no import graph here, no file is test-support.
  const { components } = computeComponents(
    sorted.map((path) => ({
      path,
      kind: kinds.get(path) ?? "other",
      lines: 0,
    })),
    packageRoots,
    profile.python.roots,
    profile.components,
  );
  const input: ManifestInput = {
    paths,
    modes: new Map(files.map((file) => [file.path, file.mode])),
    read,
    profile,
    isTest: (path) => kinds.get(path) === "test",
    pythonModules: pythonModuleIndex(
      paths,
      profile.python.roots,
      profile.python.singleFileModules,
    ),
  };
  const manifests = new Set(readEntryPoints(input).map((f) => f.manifest));

  return {
    profile,
    conflicts,
    found: {
      aliases: entries.length,
      pythonRoots: [...profile.python.roots],
      components: components.map((c) => c.path),
      launchManifests: manifests.size,
    },
    warnings,
  };
}

// Every regular file under `root`, by its repo path, in path order, with its git mode: git's
// rule makes a file 100755 when its owner may execute it. Each entry that is not a directory is
// lstat'ed, so links, FIFOs, sockets and devices are skipped, and no link is followed.
function listFiles(root: string): Array<{ path: string; mode: GitMode }> {
  const files: Array<{ path: string; mode: GitMode }> = [];
  const pending = [""];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      let stats: Stats;
      try {
        stats = lstatSync(join(root, path));
      } catch {
        continue;
      }
      if (!stats.isFile()) continue;
      files.push({
        path,
        mode: (stats.mode & 0o100) === 0 ? "100644" : "100755",
      });
    }
  }
  return files.sort((a, b) => comparePaths(a.path, b.path));
}

// At most `limit` bytes of a regular file, opened without following a link or waiting on a
// FIFO; null when it cannot be read, or when `whole` asks for all of a file over `limit`.
function readBytes(
  file: string,
  limit: number,
  whole: boolean,
): Uint8Array | null {
  let fd: number;
  try {
    fd = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return null;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || (whole && stats.size > limit)) return null;
    const bytes = new Uint8Array(Math.min(stats.size, limit));
    let length = 0;
    while (length < bytes.length) {
      const n = readSync(fd, bytes, length, bytes.length - length, length);
      if (n === 0) break;
      length += n;
    }
    return bytes.subarray(0, length);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

// The sorted paths that start with `prefix`, which path order keeps together.
function* under(sorted: readonly string[], prefix: string): Generator<string> {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] ?? "") < prefix) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < sorted.length; i++) {
    const path = sorted[i] ?? "";
    if (!path.startsWith(prefix)) return;
    yield path;
  }
}

// Whether a sorted path matches `pattern`, whose one "*" stands for one or more characters, "/"
// included, as in an exports pattern.
function matches(sorted: readonly string[], pattern: string): boolean {
  const star = pattern.indexOf("*");
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  for (const path of under(sorted, prefix)) {
    if (path.length > prefix.length + suffix.length && path.endsWith(suffix)) {
      return true;
    }
  }
  return false;
}

const stars = (s: string): number => s.split("*").length - 1;

// The extensions TypeScript tries by itself for a path without one: its own, then .js and
// .jsx, which the generated tsconfig's allowJs lets it try.
const IMPLIED_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".d.ts",
  ".js",
  ".jsx",
]);

// A pattern target without the extension that is all that follows its "*", when TypeScript
// adds that extension back by itself: lib/core/src/*.ts is written lib/core/src/*, the form
// of <dir>/src/*, so that it agrees with a tsconfig alias for the same files. .mts, .cts,
// .mjs, .cjs, .json and */index.ts stay as they are.
function withoutImpliedExtension(target: string): string {
  const suffix = target.slice(target.indexOf("*") + 1);
  return IMPLIED_EXTENSIONS.has(suffix)
    ? target.slice(0, target.length - suffix.length)
    : target;
}

// Whether a path lies under a node_modules directory.
const vendored = (path: string): boolean =>
  `/${path}`.includes("/node_modules/");

// A path's directory, "" for the repo top.
const parentOf = (path: string): string =>
  path.slice(0, Math.max(0, path.lastIndexOf("/")));

// extends: one spec, or a list of them.
const specsOf = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string")
      : [];

// Whether TypeScript looks an extends up in node_modules: a spec that is not a path ("./",
// "../" or "/", reading "\" as "/" as TypeScript does), or a path through node_modules.
function intoNodeModules(spec: string): boolean {
  const s = spec.replaceAll("\\", "/");
  const isPath = s.startsWith("./") || s.startsWith("../") || s.startsWith("/");
  return !isPath || s.split("/").includes("node_modules");
}

// A package's exports as Node reads them: a string, an array, or an object of conditions is
// the entry for "."; an object whose keys all start with "." maps subpaths; an object mixing
// the two is refused, as Node refuses it.
function subpathsOf(exports: unknown): Array<[string, unknown]> {
  if (typeof exports === "string" || Array.isArray(exports)) {
    return [[".", exports]];
  }
  if (!isObject(exports)) return [];
  const keys = Object.keys(exports);
  const subpaths = keys.filter((key) => key.startsWith("."));
  if (subpaths.length === 0) return [[".", exports]];
  return subpaths.length === keys.length ? Object.entries(exports) : [];
}

// The first string found depth first: a string itself, an array's elements in order, and an
// object's CONDITIONS in their order.
function firstString(value: unknown): string | null {
  if (typeof value === "string") return value;
  const next = Array.isArray(value)
    ? value
    : isObject(value)
      ? CONDITIONS.filter((c) => Object.hasOwn(value, c)).map((c) => value[c])
      : [];
  for (const v of next) {
    const found = firstString(v);
    if (found !== null) return found;
  }
  return null;
}

// Node's rule for an export's target: "./", then no "", ".", ".." or node_modules segment.
const isExportTarget = (target: string): boolean =>
  target.startsWith("./") &&
  target
    .slice(2)
    .split(/[/\\]/)
    .every(
      (s) =>
        s !== "" &&
        s !== "." &&
        s !== ".." &&
        s.toLowerCase() !== "node_modules",
    );

// Target lists in path order, element by element, a list before a longer one it begins.
function compareLists(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = comparePaths(a[i] ?? "", b[i] ?? "");
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

// A conflict's target: the path, or a JSON list of several.
const shown = (list: readonly string[]): string =>
  list.length === 1 ? (list[0] ?? "") : JSON.stringify(list);
