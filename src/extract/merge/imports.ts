// The imports and externals tables. Every import fact of a code, test or test-support file
// becomes one row, or, for a Python from-import, one row per module it imports. A row's
// count, specifier, kind and line come from the fact alone, so a build whose engines differ
// differs only in the targets and producers. The best tier that covers the file resolves it:
// - TS and JS: dependency-cruiser's edge with the same file and specifier, when it ran and
//   listed the file; else, when it did not run, SCIP's module at the specifier, for a file
//   SCIP indexed; else hakutaku's resolver, which also takes an import the tier left
//   unresolved.
// - Python: grimp's import of the row's absolute module, or of that module's nearest
//   ancestor, on the same line, when grimp read the file; else hakutaku's resolver. A
//   dynamic import is never grimp's. Both look the module up in one module index, the longest
//   prefix first, else name an external by its top-level name; grimp's tier looks up the
//   absolute module, so a relative import of a missing module lands, as in grimp, on its
//   nearest existing parent, where the resolver leaves it unresolved.
// - Shell: the specifier as a path from the file's directory, then from the repo top.
// A dependency-cruiser edge that no fact names gets the line of the first string literal
// holding its specifier, else line 1 and a build warning. A computed import adds no row.
// Specifiers are stored redacted and cut to 240 characters; rows are sorted in the store's
// order, and a row equal to another in every column is kept once. Once the importers are
// known, each Python definition's exported flag is set: a name with no segment starting "_",
// in a file another repo file imports.
import { posix } from "node:path";
import { pythonModuleIndex } from "../../manifests/index.js";
import {
  comparePaths,
  type Ecosystem,
  type ImportKind,
  type Lang,
  type Producer,
} from "../../model/index.js";
import type { ExternalRow, FileRow, ImportRow } from "../../store/index.js";
import type { ImportFact } from "../facts.js";
import { comparePos } from "../outline.js";
import { resolvePythonImport } from "../resolve/python.js";
import {
  isRelative,
  isRepoPath,
  resolveTsImport,
  type TsResolveContext,
} from "../resolve/ts.js";
import { positionKey } from "../scip/facts.js";
import type { MergedDefinitions } from "./definitions.js";
import { isOnMap, regularPaths } from "./files.js";
import { decodeText, redactLine } from "./text.js";
import type { MergeInput } from "./types.js";

export interface MergedImports {
  imports: ImportRow[];
  externals: ExternalRow[];
  // each imported repo file, and the files that import it
  importersOf: Map<string, Set<string>>;
  // specifiers starting "./" or "../", or "." and ".." (TS, JS and shell), or "." (Python),
  // and those of them left unresolved
  relative: { total: number; unresolved: number };
  computedImports: number;
  // per language, the files its import engine covered, metadata-only files never among them
  indexed: Map<Lang, Set<string>>;
  // redactText's count over the stored specifiers
  redactions: number;
  warnings: string[];
}

type Target = { file: string } | { ecosystem: Ecosystem; name: string } | null;

// A row before its ids are known.
interface Draft {
  src: FileRow;
  line: number;
  specifier: string;
  kind: ImportKind;
  target: Target;
  producer: Producer;
}

type Edge = NonNullable<MergeInput["depcruise"]>["edges"][number];

const pairKey = (file: string, specifier: string): string =>
  JSON.stringify([file, specifier]);

export function mergeImports(
  input: MergeInput,
  files: readonly FileRow[],
  defs: MergedDefinitions,
): MergedImports {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const onMap = new Map(
    files.filter((f) => isOnMap(f.kind)).map((f) => [f.path, f]),
  );
  const paths = new Set(regularPaths(input.manifest));
  const metadataOnly = new Set(input.manifest.metadataOnly.map((m) => m.path));
  const ts = tsTier(input, paths);
  const py = pythonTier(input, paths);
  const warnings: string[] = [];

  const facts = (input.astGrep?.imports ?? [])
    .filter((f) => onMap.has(f.file) && f.specifier !== null)
    .sort(compareFacts);
  const drafts: Draft[] = [];
  for (const fact of facts) {
    const src = onMap.get(fact.file) as FileRow;
    const specifier = fact.specifier as string;
    const base = { src, line: fact.at.line, kind: fact.kind };
    if (src.lang === "typescript" || src.lang === "javascript") {
      drafts.push({ ...base, specifier, ...ts.resolve(fact, specifier) });
    } else if (src.lang === "python") {
      for (const row of py.resolve(fact, specifier)) {
        drafts.push({ ...base, ...row });
      }
    } else if (src.lang === "shell") {
      drafts.push({
        ...base,
        specifier,
        target: shellTarget(fact.file, specifier, paths),
        producer: "ast-grep",
      });
    }
  }

  // dependency-cruiser's edges that no import fact names
  const named = new Set(
    facts.map((f) => pairKey(f.file, f.specifier as string)),
  );
  const texts = new Map<string, string[]>();
  const linesOf = (path: string): string[] => {
    let lines = texts.get(path);
    if (lines === undefined) {
      lines = decodeText(input.readSnapshot(path)).split("\n");
      texts.set(path, lines);
    }
    return lines;
  };
  for (const edge of input.depcruise?.edges ?? []) {
    const src = onMap.get(edge.from);
    if (src === undefined || named.has(pairKey(edge.from, edge.specifier))) {
      continue;
    }
    let line = stringLine(linesOf(edge.from), edge.specifier);
    if (line === null) {
      line = 1;
      warnings.push(
        `${edge.from}: dependency-cruiser found an import of ${JSON.stringify(redactLine(edge.specifier).text)} that no string literal holds; stored at line 1`,
      );
    }
    drafts.push({
      src,
      line,
      specifier: edge.specifier,
      kind: edge.typeOnly ? "type-only" : "static",
      ...ts.edge(edge),
    });
  }

  // the externals, in (ecosystem, name) order, before any row names one
  const externalKey = (t: { ecosystem: string; name: string }): string =>
    JSON.stringify([t.ecosystem, t.name]);
  const found = new Map<string, { ecosystem: Ecosystem; name: string }>();
  for (const d of drafts) {
    if (d.target !== null && !("file" in d.target)) {
      found.set(externalKey(d.target), d.target);
    }
  }
  const externals: ExternalRow[] = [...found.values()]
    .sort(
      (a, b) =>
        comparePaths(a.ecosystem, b.ecosystem) || comparePaths(a.name, b.name),
    )
    .map((e, i) => ({
      id: i + 1,
      ecosystem: e.ecosystem,
      name: e.name,
      files: 0,
    }));
  const externalId = new Map(externals.map((e) => [externalKey(e), e.id]));

  const rows: Array<{ row: ImportRow; redactions: number }> = drafts.map(
    (d) => {
      const stored = redactLine(d.specifier);
      const dst =
        d.target !== null && "file" in d.target
          ? (byPath.get(d.target.file)?.id ?? null)
          : null;
      const ext =
        d.target !== null && !("file" in d.target)
          ? (externalId.get(externalKey(d.target)) ?? null)
          : null;
      return {
        row: {
          id: 0,
          src_file_id: d.src.id,
          dst_file_id: dst,
          dst_external_id: ext,
          kind: d.kind,
          line: d.line,
          specifier: stored.text,
          resolved: dst !== null || ext !== null ? 1 : 0,
          producer: d.producer,
        },
        redactions: stored.count,
      };
    },
  );
  rows.sort((a, b) => compareRows(a.row, b.row));
  const imports: ImportRow[] = [];
  let redactions = 0;
  for (const { row, redactions: count } of rows) {
    const last = imports.at(-1);
    if (last !== undefined && compareRows(last, row) === 0) continue;
    row.id = imports.length + 1;
    imports.push(row);
    redactions += count;
  }

  const fileOf = (id: number): FileRow => files[id - 1] as FileRow;
  const importersOf = new Map<string, Set<string>>();
  const importing = new Map<number, Set<number>>(); // external id to its importing files
  let total = 0;
  let unresolved = 0;
  for (const row of imports) {
    const src = fileOf(row.src_file_id);
    if (row.dst_file_id !== null) {
      const dst = fileOf(row.dst_file_id).path;
      const set = importersOf.get(dst) ?? new Set<string>();
      set.add(src.path);
      importersOf.set(dst, set);
    }
    if (row.dst_external_id !== null) {
      const set = importing.get(row.dst_external_id) ?? new Set<number>();
      set.add(row.src_file_id);
      importing.set(row.dst_external_id, set);
    }
    const relative =
      src.lang === "python"
        ? row.specifier.startsWith(".")
        : isRelative(row.specifier);
    if (relative) {
      total++;
      if (row.resolved === 0) unresolved++;
    }
  }
  for (const e of externals) e.files = importing.get(e.id)?.size ?? 0;

  // Python exports a name with no segment starting "_" once another file imports its module
  for (const [path, list] of defs.byFile) {
    if (onMap.get(path)?.lang !== "python") continue;
    const imported = [...(importersOf.get(path) ?? [])].some((p) => p !== path);
    for (const row of list) {
      if (row.kind === "module") continue;
      row.exported =
        imported && row.qualname.split(".").every((s) => !s.startsWith("_"))
          ? 1
          : 0;
    }
  }

  const indexed = new Map<Lang, Set<string>>();
  for (const file of onMap.values()) {
    if (metadataOnly.has(file.path) || file.lang === null) continue;
    const covered = ts.indexes(file) ?? py.indexes(file) ?? shellIndexes(file);
    if (covered === null) continue;
    const set = indexed.get(file.lang) ?? new Set<string>();
    if (covered) set.add(file.path);
    indexed.set(file.lang, set);
  }

  return {
    imports,
    externals,
    importersOf,
    relative: { total, unresolved },
    computedImports: (input.astGrep?.computed ?? []).filter((c) =>
      onMap.has(c.file),
    ).length,
    indexed,
    redactions,
    warnings,
  };
}

const compareFacts = (a: ImportFact, b: ImportFact): number =>
  comparePaths(a.file, b.file) ||
  comparePos(a.at, b.at) ||
  comparePaths(a.specifier ?? "", b.specifier ?? "") ||
  comparePaths(a.kind, b.kind) ||
  comparePaths(a.names.join("\n"), b.names.join("\n"));

// NULL first, then numbers, as SQLite orders them.
const compareNullable = (a: number | null, b: number | null): number =>
  a === b ? 0 : a === null ? -1 : b === null ? 1 : a - b;

// The store's order: source, line, specifier, kind, then the other columns.
const compareRows = (a: ImportRow, b: ImportRow): number =>
  a.src_file_id - b.src_file_id ||
  a.line - b.line ||
  comparePaths(a.specifier, b.specifier) ||
  comparePaths(a.kind, b.kind) ||
  compareNullable(a.dst_file_id, b.dst_file_id) ||
  compareNullable(a.dst_external_id, b.dst_external_id) ||
  a.resolved - b.resolved ||
  comparePaths(a.producer, b.producer);

// The TS and JS tiers.
function tsTier(input: MergeInput, paths: ReadonlySet<string>) {
  const cruised = input.depcruise;
  const scip = input.scip;
  const ctx: TsResolveContext = {
    paths,
    aliases: input.profile.typescript.aliases,
    // The profile's aliases already hold every package name the profile generator finds,
    // and dependency-cruiser resolves a package's own name only through them (no dependency
    // tree is installed), so the resolver takes no other workspace names.
    workspaces: new Map(),
  };
  const edges = new Map<string, Edge[]>();
  for (const edge of cruised?.edges ?? []) {
    const key = pairKey(edge.from, edge.specifier);
    const list = edges.get(key);
    if (list === undefined) edges.set(key, [edge]);
    else list.push(edge);
  }
  const resolver = (from: string, specifier: string) => ({
    target: resolveTsImport(from, specifier, ctx),
    producer: "hakutaku-resolver" as const,
  });
  const ofEdge = (edge: Edge): Target =>
    edge.to !== null && paths.has(edge.to) ? { file: edge.to } : edge.external;
  return {
    resolve(
      fact: ImportFact,
      specifier: string,
    ): Pick<Draft, "target" | "producer"> {
      if (cruised !== null) {
        if (cruised.modules.has(fact.file)) {
          // a value import and an import type of one module are two edges, which share
          // their target: dependency-cruiser resolves a specifier once per module
          const edge = edges.get(pairKey(fact.file, specifier))?.[0];
          const target = edge === undefined ? null : ofEdge(edge);
          if (target !== null)
            return { target, producer: "dependency-cruiser" };
        }
      } else if (scip?.documents.has(fact.file)) {
        const module = scip.moduleAt.get(positionKey(fact.file, fact.at));
        if (module !== undefined && paths.has(module)) {
          return { target: { file: module }, producer: "scip-typescript" };
        }
      }
      return resolver(fact.file, specifier);
    },
    edge(edge: Edge): Pick<Draft, "target" | "producer"> {
      const target = ofEdge(edge);
      return target !== null
        ? { target, producer: "dependency-cruiser" }
        : resolver(edge.from, edge.specifier);
    },
    // whether the file's import engine covered it, or null when it is no TS or JS file
    indexes(file: FileRow): boolean | null {
      if (file.lang !== "typescript" && file.lang !== "javascript") return null;
      return cruised === null || cruised.modules.has(file.path);
    },
  };
}

// The Python tiers, over the module index grimp's driver read: the tree's regular files under
// the profile's roots, and its single-file modules.
function pythonTier(input: MergeInput, paths: ReadonlySet<string>) {
  const index = pythonModuleIndex(
    paths,
    input.profile.python.roots,
    input.profile.python.singleFileModules,
  );
  // each file's dotted name, the one a relative import is read from
  const nameOf = new Map<string, string>();
  for (const [name, path] of index) {
    const held = nameOf.get(path);
    if (held === undefined || parts(name) > parts(held)) nameOf.set(path, name);
  }
  // the files grimp read, and the modules it imports from each, by line
  const grimp = input.grimp;
  const read = new Set<string>();
  const importedAt = new Map<string, Set<string>>();
  if (grimp !== null) {
    for (const [name, path] of index) {
      if (grimp.modules.has(name)) read.add(path);
    }
    for (const g of grimp.imports) {
      const path = index.get(g.importer);
      if (path === undefined || !read.has(path)) continue;
      const key = lineKey(path, g.line);
      const set = importedAt.get(key) ?? new Set<string>();
      set.add(g.imported);
      importedAt.set(key, set);
    }
  }

  const resolver = (from: string, module: string): Target =>
    resolvePythonImport(from, module, index);

  // The specifiers a fact imports: the module as written, or for a from-import each name
  // that is a submodule (the module and the name joined), and the module itself for any
  // other name or *.
  const written = (fact: ImportFact, module: string): string[] => {
    if (fact.names.length === 0) return [module];
    const out = new Set<string>();
    let plain = false;
    for (const name of fact.names) {
      const joined = name === "*" ? null : joinModule(module, name);
      if (joined !== null && isModule(fact.file, joined)) out.add(joined);
      else plain = true;
    }
    return plain ? [module, ...out] : [...out];
  };
  const isModule = (from: string, module: string): boolean =>
    module.startsWith(".")
      ? resolvePythonImport(from, module, index) !== null
      : index.has(module);

  // A module's absolute name, read from the importing file's package; null when it climbs
  // past the top package, or the file has no dotted name.
  const absolute = (from: string, module: string): string | null => {
    const rest = module.replace(/^\.+/, "");
    const dots = module.length - rest.length;
    const tail = rest === "" ? [] : rest.split(".");
    if (tail.includes("")) return null;
    if (dots === 0) return module;
    const own = nameOf.get(from);
    if (own === undefined) return null;
    const pkg = own.split(".");
    if (posix.basename(from) !== "__init__.py") pkg.pop();
    const kept = pkg.length - (dots - 1);
    return kept < 1 ? null : [...pkg.slice(0, kept), ...tail].join(".");
  };

  return {
    resolve(
      fact: ImportFact,
      module: string,
    ): Array<Pick<Draft, "specifier" | "target" | "producer">> {
      const imported =
        fact.kind === "dynamic" || !read.has(fact.file)
          ? undefined
          : importedAt.get(lineKey(fact.file, fact.at.line));
      return written(fact, module).map((specifier) => {
        const abs =
          imported === undefined ? null : absolute(fact.file, specifier);
        if (abs !== null && imported !== undefined && reaches(imported, abs)) {
          return {
            specifier,
            target: resolver(fact.file, abs),
            producer: "grimp",
          };
        }
        return {
          specifier,
          target: resolver(fact.file, specifier),
          producer: "hakutaku-resolver",
        };
      });
    },
    // whether grimp read the file, or every Python file when hakutaku's resolver ran alone
    indexes(file: FileRow): boolean | null {
      if (file.lang !== "python") return null;
      return grimp === null || read.has(file.path);
    },
  };
}

const parts = (name: string): number => name.split(".").length;

const lineKey = (path: string, line: number): string =>
  JSON.stringify([path, line]);

// A from-import's module and a name it takes: "observatory" and "ephemeris" give
// "observatory.ephemeris"; a module of dots only takes the name with no dot, as Python reads
// "from . import cli" as ".cli".
const joinModule = (module: string, name: string): string =>
  module.endsWith(".") ? module + name : `${module}.${name}`;

// Whether grimp imported the module, or one of its ancestors: grimp lands an import of a
// missing submodule on its nearest existing parent, and names an external by its top-level
// name.
function reaches(imported: ReadonlySet<string>, module: string): boolean {
  for (let m = module; ; m = m.slice(0, m.lastIndexOf("."))) {
    if (imported.has(m)) return true;
    if (!m.includes(".")) return false;
  }
}

// A shell import's file: the specifier as a path from the importing file's directory, then
// from the repo top. An absolute path names no repo file.
function shellTarget(
  from: string,
  specifier: string,
  paths: ReadonlySet<string>,
): Target {
  if (specifier.startsWith("/")) return null;
  for (const base of [posix.dirname(from), "."]) {
    const path = posix.normalize(posix.join(base, specifier));
    if (isRepoPath(path) && paths.has(path)) return { file: path };
  }
  return null;
}

// A shell file is covered by ast-grep, which reads every one; null for other languages,
// which have no import engine.
const shellIndexes = (file: FileRow): boolean | null =>
  file.lang === "shell" ? true : null;

// The first of a file's lines holding the specifier as a string literal, in double, single or
// back quotes, or null.
function stringLine(
  lines: readonly string[],
  specifier: string,
): number | null {
  const quoted = ['"', "'", "`"].map((q) => `${q}${specifier}${q}`);
  const at = lines.findIndex((line) => quoted.some((q) => line.includes(q)));
  return at < 0 ? null : at + 1;
}
