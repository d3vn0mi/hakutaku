// The gates a new store must pass before it is swapped in, each with a fixed wording:
// - files-indexed: each TypeScript and JavaScript file the engines are given was indexed, and
//   each Python module an import statement can name has a name under the profile's roots;
// - unresolved-imports: the share of relative imports left unresolved is within the profile's
//   limit, and their number has not grown from the current store's;
// - scip-duplicates: no symbol is defined by two SCIP documents;
// - denylist: no denylisted path is a file of the store;
// - redaction: a second scan of every stored text finds no secret.
// runGates is pure: it reads only its input. storedTexts lists the texts the redaction gate
// scans again.
import { posix } from "node:path";
import { pythonModuleIndex } from "../manifests/index.js";
import { comparePaths, type FileKind, type Lang } from "../model/index.js";
import { findSecrets, isDenied } from "../redact/index.js";
import type { FileRow, GateResult } from "../store/index.js";
import type { MergedContent } from "./merge/index.js";
import { listedByInclude } from "./resolve/ts.js";

// A text the store holds, with the file and the line it starts at.
export interface StoredText {
  path: string;
  line: number;
  text: string;
}

export interface GateInput {
  // the store's files rows
  files: ReadonlyArray<Pick<FileRow, "path" | "kind" | "lang">>;
  // the tree's regular files: where the packages are, and what the module index names
  regularPaths: readonly string[];
  // the files kept out of every engine's input
  metadataOnly: readonly string[];
  python: { roots: readonly string[]; singleFileModules: readonly string[] };
  // per language, the files its import engine covered
  indexed: ReadonlyMap<Lang, ReadonlySet<string>>;
  // what scip-typescript indexed, and the symbols two or more of its documents define; null
  // when it did not run
  scip: {
    documents: ReadonlySet<string>;
    duplicates: readonly string[];
  } | null;
  // the relative specifiers, and those of them left unresolved
  relative: { total: number; unresolved: number };
  maxUnresolvedRelativeImports: number;
  // the current store's count of unresolved relative imports; null without a current store
  currentUnresolved: number | null;
  denylistExtra: readonly string[];
  // how many spans redaction replaced
  redactions: number;
  // every stored text, as storedTexts lists them
  texts: Iterable<StoredText>;
}

// Every text the store holds, with the file and line it starts at: sources, signatures,
// receiver texts, specifiers, each external's name where an import first names it, entry
// names, the text index, and each link's target at its link.
export function* storedTexts(c: MergedContent): Generator<StoredText> {
  // a row's id is its place in its table
  const pathOf = (id: number): string => c.files[id - 1]?.path ?? "";
  for (const s of c.sources) {
    yield { path: pathOf(s.file_id), line: 1, text: s.text };
  }
  for (const d of c.definitions) {
    if (d.signature !== null) {
      yield { path: pathOf(d.file_id), line: d.start_line, text: d.signature };
    }
  }
  for (const s of c.call_sites) {
    if (s.receiver_text !== null) {
      yield { path: pathOf(s.file_id), line: s.line, text: s.receiver_text };
    }
  }
  const named = new Set<number>();
  for (const i of c.imports) {
    yield { path: pathOf(i.src_file_id), line: i.line, text: i.specifier };
    const id = i.dst_external_id;
    if (id === null || named.has(id)) continue;
    named.add(id);
    const external = c.externals[id - 1];
    if (external !== undefined) {
      yield { path: pathOf(i.src_file_id), line: i.line, text: external.name };
    }
  }
  for (const e of c.entry_points) {
    yield {
      path: pathOf(e.manifest_file_id),
      line: e.manifest_line,
      text: e.name,
    };
  }
  for (const t of c.text_index) {
    yield { path: pathOf(t.file_id), line: t.line, text: t.text };
  }
  for (const f of c.files) {
    if (f.link_target !== null) {
      yield { path: f.path, line: 1, text: f.link_target };
    }
  }
}

// At most this many paths or findings are named in a detail.
const NAMED = 5;

const ON_MAP: ReadonlySet<FileKind> = new Set(["code", "test", "test-support"]);
const SCRIPT_LANGS: ReadonlySet<Lang> = new Set(["typescript", "javascript"]);

// A name part Python can import: an identifier, as the module index reads one.
const IDENTIFIER = /^[\p{XID_Start}_]\p{XID_Continue}*$/u;

// Always five results, in this order.
export function runGates(input: GateInput): GateResult[] {
  return [
    filesIndexed(input),
    unresolvedImports(input),
    scipDuplicates(input),
    denylist(input),
    redaction(input),
  ];
}

// The expected files of a language, and those of them that were not indexed.
interface Tally {
  expected: number;
  missing: string[];
}

function filesIndexed(input: GateInput): GateResult {
  const metadataOnly = new Set(input.metadataOnly);
  const regular = new Set(input.regularPaths);
  const declared = new Set(input.python.singleFileModules);
  const named = new Set(
    pythonModuleIndex(
      input.regularPaths,
      input.python.roots,
      input.python.singleFileModules,
    ).values(),
  );
  const tallies = new Map<Lang, Tally>();
  for (const { path, kind, lang } of input.files) {
    if (lang === null || !ON_MAP.has(kind) || metadataOnly.has(path)) continue;
    let indexed: boolean;
    if (SCRIPT_LANGS.has(lang)) {
      // TypeScript's include never lists the others, and dependency-cruiser never follows a
      // node_modules directory
      if (!listedByInclude(path)) continue;
      indexed =
        (input.indexed.get(lang)?.has(path) ?? false) &&
        (input.scip === null || input.scip.documents.has(path));
    } else if (lang === "python") {
      if (!(inImportablePackage(path, regular) || declared.has(path))) continue;
      indexed = named.has(path);
    } else {
      continue;
    }
    const tally = tallies.get(lang) ?? { expected: 0, missing: [] };
    tally.expected++;
    if (!indexed) tally.missing.push(path);
    tallies.set(lang, tally);
  }
  const langs = [...tallies.keys()].sort(comparePaths);
  const count = (lang: Lang): string => {
    const { expected, missing } = tallies.get(lang) as Tally;
    return `${lang} ${expected - missing.length}/${expected}`;
  };
  const failing = langs.filter(
    (lang) => (tallies.get(lang) as Tally).missing.length > 0,
  );
  if (failing.length > 0) {
    return {
      gate: "files-indexed",
      ok: false,
      detail: failing
        .map((lang) => {
          const missing = [...(tallies.get(lang) as Tally).missing].sort(
            comparePaths,
          );
          return `${count(lang)}: missing ${missing.slice(0, NAMED).join(", ")}`;
        })
        .join("; "),
    };
  }
  return {
    gate: "files-indexed",
    ok: true,
    detail:
      langs.length === 0
        ? "no TypeScript, JavaScript or Python files"
        : langs.map(count).join(", "),
  };
}

// Whether a file is a module of a package an import statement can name: a .py file (a stub is
// never a module) whose directory holds an __init__.py, with its own name and the name of each
// package directory above it, up to the first directory without an __init__.py, an
// identifier. The repo top is never a package, since no root inside the repo can name it; a
// migration such as 0001_initial.py, or a directory named sky-tool, is no module either.
function inImportablePackage(
  path: string,
  regular: ReadonlySet<string>,
): boolean {
  if (!path.endsWith(".py")) return false;
  const dirs = path.split("/");
  const name = posix.basename(dirs.pop() as string, ".py");
  if (name !== "__init__" && !IDENTIFIER.test(name)) return false;
  const holdsInit = (): boolean =>
    dirs.length > 0 && regular.has([...dirs, "__init__.py"].join("/"));
  if (!holdsInit()) return false;
  while (holdsInit()) {
    if (!IDENTIFIER.test(dirs.pop() as string)) return false;
  }
  return true;
}

const percent = (share: number): string => `${(share * 100).toFixed(2)}%`;

function unresolvedImports(input: GateInput): GateResult {
  const { total, unresolved } = input.relative;
  const limit = input.maxUnresolvedRelativeImports;
  const share = total === 0 ? 0 : unresolved / total;
  const shareDetail = `${unresolved} of ${total} relative imports unresolved (${percent(share)}); limit ${percent(limit)}`;
  if (share > limit) {
    return { gate: "unresolved-imports", ok: false, detail: shareDetail };
  }
  const current = input.currentUnresolved;
  if (current !== null && unresolved > current) {
    return {
      gate: "unresolved-imports",
      ok: false,
      detail: `${unresolved} unresolved relative imports, up from ${current} in the current store`,
    };
  }
  return { gate: "unresolved-imports", ok: true, detail: shareDetail };
}

function scipDuplicates(input: GateInput): GateResult {
  if (input.scip === null) {
    return {
      gate: "scip-duplicates",
      ok: true,
      detail: "scip-typescript did not run",
    };
  }
  const duplicates = [...input.scip.duplicates].sort(comparePaths);
  if (duplicates.length === 0) {
    return { gate: "scip-duplicates", ok: true, detail: "0 duplicate symbols" };
  }
  return {
    gate: "scip-duplicates",
    ok: false,
    detail: `${duplicates.length} duplicate symbols, e.g. ${duplicates[0]}`,
  };
}

function denylist(input: GateInput): GateResult {
  const denied = input.files
    .map((f) => f.path)
    .filter((path) => isDenied(path, input.denylistExtra))
    .sort(comparePaths);
  if (denied.length === 0) {
    return { gate: "denylist", ok: true, detail: "0 denylisted paths" };
  }
  return {
    gate: "denylist",
    ok: false,
    detail: `${denied.length} denylisted paths: ${denied.slice(0, NAMED).join(", ")}`,
  };
}

function redaction(input: GateInput): GateResult {
  const found: Array<{ path: string; line: number; rule: string }> = [];
  for (const { path, line, text } of input.texts) {
    for (const secret of findSecrets(text)) {
      found.push({ path, line: line + secret.line - 1, rule: secret.rule });
    }
  }
  if (found.length === 0) {
    return {
      gate: "redaction",
      ok: true,
      detail: `ran; ${input.redactions} redactions; re-scan clean`,
    };
  }
  found.sort(
    (a, b) =>
      comparePaths(a.path, b.path) ||
      a.line - b.line ||
      comparePaths(a.rule, b.rule),
  );
  return {
    gate: "redaction",
    ok: false,
    detail: `re-scan found ${found.length}: ${found
      .slice(0, NAMED)
      .map((f) => `${f.path}:${f.line} ${f.rule}`)
      .join(", ")}`,
  };
}
