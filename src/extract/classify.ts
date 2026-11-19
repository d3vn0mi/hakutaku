// File classification (§5.1): each tracked file's kind and language, the test-support
// fixpoint, and the components that group the files on the map.
//
// Extensions and names compare in their exact case, as the engines read them: on a
// case-sensitive file system TypeScript refuses "a.TS" as an unsupported extension (TS6054),
// and Python imports only ".py".
import { posix } from "node:path";
import {
  comparePaths,
  type FileKind,
  LANG_BY_EXT,
  type Lang,
  matchGlob,
} from "../model/index.js";
import type { Profile } from "../profile/index.js";

// §5.1's default test patterns, as globs over repo paths (src/model/glob.ts), the form of a
// profile's tests.extraPatterns. A directory pattern matches that directory at any depth.
export const TEST_PATTERNS: readonly string[] = Object.freeze([
  "*.test.*",
  "*.spec.*",
  "test_*.py",
  "*_test.py",
  "conftest.py",
  "__tests__/**",
  "tests/**",
  "test/**",
  "fixtures/**",
]);

export const CONFIG_EXT: readonly string[] = Object.freeze([
  ".json",
  ".jsonc",
  ".json5",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".properties",
  ".xml",
  ".service",
  ".timer",
  ".path",
  ".socket",
  ".mount",
  ".target",
]);

// File names, each a glob over the file's name alone. Dockerfile.* is config too.
export const CONFIG_NAMES: readonly string[] = Object.freeze([
  "Dockerfile",
  "Procfile",
  "Makefile",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".nvmrc",
  ".node-version",
  ".python-version",
  "requirements*.txt",
]);

export const DOC_EXT: readonly string[] = Object.freeze([
  ".md",
  ".mdx",
  ".rst",
  ".txt",
  ".adoc",
]);

// A file is a doc when its name is one of these, alone or followed by one extension.
export const DOC_NAMES: readonly string[] = Object.freeze([
  "README",
  "LICENSE",
  "LICENCE",
  "NOTICE",
  "COPYING",
  "CHANGELOG",
  "AUTHORS",
]);

// How much of a file the binary check reads, as git does.
const HEAD_BYTES = 8000;
const configExt: ReadonlySet<string> = new Set(CONFIG_EXT);
const docExt: ReadonlySet<string> = new Set(DOC_EXT);
const docNames: ReadonlySet<string> = new Set(DOC_NAMES);
const ON_MAP: ReadonlySet<FileKind> = new Set(["code", "test", "test-support"]);

// A file's extension: from the last "." of its name, unless that "." starts the name, so a
// dotfile such as .gitignore has none.
const extensionOf = (path: string): string => posix.extname(path);

// In this order: a NUL byte in the first 8,000 bytes makes the file other; an extension in
// LANG_BY_EXT makes it code, or test when a default or profile test pattern matches it; then
// config; then doc; then other.
export function classifyFile(
  path: string,
  head: Uint8Array /* first 8,000 bytes */,
  profile: Profile,
): { kind: "code" | "test" | "config" | "doc" | "other"; lang: Lang | null } {
  if (head.subarray(0, HEAD_BYTES).includes(0))
    return { kind: "other", lang: null };
  const name = path.slice(path.lastIndexOf("/") + 1);
  const ext = extensionOf(name);
  const lang: Lang | undefined = LANG_BY_EXT[ext];
  if (lang !== undefined) {
    const test =
      TEST_PATTERNS.some((glob) => matchGlob(glob, path)) ||
      profile.tests.extraPatterns.some((glob) => matchGlob(glob, path));
    return { kind: test ? "test" : "code", lang };
  }
  if (
    configExt.has(ext) ||
    CONFIG_NAMES.some((glob) => matchGlob(glob, name)) ||
    matchGlob("Dockerfile.*", name)
  )
    return { kind: "config", lang: null };
  if (docExt.has(ext) || docNames.has(name.slice(0, name.length - ext.length)))
    return { kind: "doc", lang: null };
  return { kind: "other", lang: null };
}

// §5.1's fixpoint: a code file with at least one importer, all of whose importers are test or
// test-support, becomes test-support, until nothing changes; an entry never changes. It starts
// from the kinds it is given and never assumes a file is support, so files that import each
// other stay code even when only tests reach them, and an importer with no kind counts as
// production. Each file counts the importers that still hold it back, so the fixpoint takes
// time linear in the number of imports, whatever order the maps list.
export function markTestSupport(
  kinds: Map<string, FileKind>,
  importers: ReadonlyMap<string, ReadonlySet<string>>,
  entries: ReadonlySet<string>,
): void {
  const testSide = (path: string): boolean => {
    const kind = kinds.get(path);
    return kind === "test" || kind === "test-support";
  };
  const waiting = new Map<string, number>(); // file -> importers not on the test side
  const holds = new Map<string, string[]>(); // importer -> the files it holds back
  const ready: string[] = [];
  for (const [path, by] of importers) {
    if (kinds.get(path) !== "code" || entries.has(path) || by.size === 0)
      continue;
    let count = 0;
    for (const importer of by) {
      if (testSide(importer)) continue;
      count++;
      const held = holds.get(importer);
      if (held === undefined) holds.set(importer, [path]);
      else held.push(path);
    }
    waiting.set(path, count);
    if (count === 0) ready.push(path);
  }
  for (let path = ready.pop(); path !== undefined; path = ready.pop()) {
    kinds.set(path, "test-support");
    for (const held of holds.get(path) ?? []) {
      const count = (waiting.get(held) ?? 0) - 1;
      waiting.set(held, count);
      if (count === 0) ready.push(held);
    }
  }
}

type ComponentKind =
  | "package"
  | "python-package"
  | "folder"
  | "profile"
  | "split";

// A file's directories below the repo top, deepest first, each with its trailing "/".
function* ancestors(path: string): Generator<string> {
  for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1))
    yield path.slice(0, i + 1);
}

// Each code, test and test-support file's component (§5.1), in this order:
// - the deepest of its directories that a profile root (a glob over directories) matches;
// - else its nearest directory below the repo top that is a package root (packageRoots holds
//   directory paths ending in "/") or a top-level Python package (a directory directly under
//   a Python root, "." being the repo top, that holds a .py or .pyi file on the map); a
//   directory that is both is a package;
// - else its top-level folder, or ./ for a file at the top.
// Then each component holding more than 40% of the production (code) files splits once, by
// the counts before any split: every file below its directory moves to a split component for
// the subdirectory one level down that holds it, and the parent keeps the files directly
// inside it, and stays even when none is left. Components are listed by path, and `of` maps
// each file to its component's path, in path order.
export function computeComponents(
  files: ReadonlyArray<{ path: string; kind: FileKind; lines: number }>,
  packageRoots: ReadonlySet<string>,
  pythonRoots: readonly string[],
  profileRoots: readonly string[],
): {
  components: Array<{
    path: string;
    kind: "package" | "python-package" | "folder" | "profile" | "split";
    parent: string | null;
  }>;
  of: Map<string, string>;
} {
  const mapped = files
    .filter((file) => ON_MAP.has(file.kind))
    .sort((a, b) => comparePaths(a.path, b.path));

  const pythonPackages = new Set<string>();
  for (const { path } of mapped) {
    if (LANG_BY_EXT[extensionOf(path)] !== "python") continue;
    for (const root of pythonRoots) {
      const prefix = root === "." ? "" : `${root}/`;
      if (!path.startsWith(prefix)) continue;
      const slash = path.indexOf("/", prefix.length);
      if (slash > prefix.length) pythonPackages.add(path.slice(0, slash + 1));
    }
  }

  const place = (path: string): [string, ComponentKind] => {
    if (profileRoots.length > 0)
      for (const dir of ancestors(path)) {
        const bare = dir.slice(0, -1);
        if (profileRoots.some((glob) => matchGlob(glob, bare)))
          return [dir, "profile"];
      }
    for (const dir of ancestors(path)) {
      if (packageRoots.has(dir)) return [dir, "package"];
      if (pythonPackages.has(dir)) return [dir, "python-package"];
    }
    const slash = path.indexOf("/");
    return [slash < 0 ? "./" : path.slice(0, slash + 1), "folder"];
  };

  const found = new Map<
    string,
    { kind: ComponentKind; parent: string | null }
  >();
  const placed = mapped.map(({ path, kind }) => {
    const [dir, componentKind] = place(path);
    if (!found.has(dir)) found.set(dir, { kind: componentKind, parent: null });
    return { path, kind, dir };
  });

  let production = 0;
  const productionIn = new Map<string, number>();
  for (const { kind, dir } of placed)
    if (kind === "code") {
      production++;
      productionIn.set(dir, (productionIn.get(dir) ?? 0) + 1);
    }
  // More than 40%, in integers: n / production > 2 / 5.
  const splitting = new Set<string>();
  for (const [dir, n] of productionIn)
    if (n * 5 > production * 2) splitting.add(dir);
  for (const file of placed) {
    if (!splitting.has(file.dir)) continue;
    // ./ holds only files at the top, so nothing below it moves.
    const prefix = file.dir === "./" ? "" : file.dir;
    const slash = file.path.indexOf("/", prefix.length);
    if (slash < 0) continue;
    const child = file.path.slice(0, slash + 1);
    if (!found.has(child))
      found.set(child, { kind: "split", parent: file.dir });
    file.dir = child;
  }

  const components = [...found]
    .map(([path, { kind, parent }]) => ({ path, kind, parent }))
    .sort((a, b) => comparePaths(a.path, b.path));
  return {
    components,
    of: new Map(placed.map(({ path, dir }) => [path, dir])),
  };
}
