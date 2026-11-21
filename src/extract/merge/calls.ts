// The call_sites and call_targets tables. Every call fact of a code, test or test-support file
// is one site, except a shell command that names no function a shell file defines: every shell
// command is a call fact. A site's enclosing definition is the innermost outline definition
// whose range holds the callee's position, else its file's module row, so a call inside an
// anonymous callback belongs to the nearest named definition. Its receiver is redacted, then
// cut to 240 characters.
//
// A site's targets come from the first rule that applies:
// - bound: the SCIP uses at the callee's position bind exactly one outline definition, each
//   through a symbol that joined it; that definition is the site's one row. Uses that bind
//   two or more definitions name no one of them, and the rules below decide;
// - none: a use there names a symbol no repo document defines and that is not local, such as
//   the TypeScript library's Array#map;
// - scoped: one row for every function, method or class named as the callee in the files the
//   site's file sees, with collision 1 on each when there are two or more. A file sees itself,
//   the files it imports, and the files reached from those through re-exports: a TS or JS
//   export ... from, any import an __init__.py makes, and a shell source. A shell script run
//   by path shares no function with the one that runs it, so a shell exec is not followed.
// A site with no row counts as unresolved in coverage.
//
// unmatchedBoundUses counts the uses at the sites' positions whose symbol a repo document
// defines but that bind no single outline definition: its symbol joined none, or two or more.
import { posix } from "node:path";
import { comparePaths } from "../../model/index.js";
import type {
  CallSiteRow,
  CallTargetRow,
  DefinitionRow,
  FileRow,
  ImportRow,
} from "../../store/index.js";
import type { Pos } from "../facts.js";
import { comparePos } from "../outline.js";
import { positionKey } from "../scip/facts.js";
import { type MergedDefinitions, scipKey } from "./definitions.js";
import { isOnMap } from "./files.js";
import { redactLine } from "./text.js";
import type { MergeInput } from "./types.js";

export interface MergedCalls {
  call_sites: CallSiteRow[];
  call_targets: CallTargetRow[];
  unmatchedBoundUses: number;
  // redactText's count over the stored receivers
  redactions: number;
}

type Use = NonNullable<MergeInput["scip"]>["uses"][number];

// The kinds of definition a call can name.
const CALLABLE: ReadonlySet<string> = new Set(["function", "method", "class"]);

const isLocal = (symbol: string): boolean => symbol.startsWith("local ");

export function mergeCalls(
  input: MergeInput,
  files: readonly FileRow[],
  defs: MergedDefinitions,
  imports: readonly ImportRow[],
): MergedCalls {
  const onMap = new Map(
    files.filter((f) => isOnMap(f.kind)).map((f) => [f.path, f]),
  );
  const shellFunctions = new Set<string>();
  for (const [path, rows] of defs.byFile) {
    if (onMap.get(path)?.lang !== "shell") continue;
    for (const row of rows) {
      if (row.kind === "function") shellFunctions.add(row.name);
    }
  }

  const finders = new Map<string, (at: Pos) => number>();
  const drafts: Array<{ row: CallSiteRow; redactions: number }> = [];
  for (const fact of input.astGrep?.calls ?? []) {
    const file = onMap.get(fact.file);
    if (file === undefined) continue;
    if (file.lang === "shell" && !shellFunctions.has(fact.callee)) continue;
    let enclosing = finders.get(file.path);
    if (enclosing === undefined) {
      enclosing = enclosingIn(file.path, defs.byFile.get(file.path) ?? []);
      finders.set(file.path, enclosing);
    }
    const receiver = fact.receiver === null ? null : redactLine(fact.receiver);
    drafts.push({
      row: {
        id: 0,
        file_id: file.id,
        line: fact.at.line,
        col: fact.at.col,
        enclosing_def_id: enclosing(fact.at),
        callee_name: fact.callee,
        receiver_text: receiver === null ? null : receiver.text,
        producer: "ast-grep",
      },
      redactions: receiver === null ? 0 : receiver.count,
    });
  }
  drafts.sort((a, b) => compareSites(a.row, b.row));
  const call_sites: CallSiteRow[] = [];
  let redactions = 0;
  for (const { row, redactions: count } of drafts) {
    const last = call_sites.at(-1);
    if (last !== undefined && compareSites(last, row) === 0) continue;
    row.id = call_sites.length + 1;
    call_sites.push(row);
    redactions += count;
  }

  const usesAt = new Map<string, Use[]>();
  for (const use of input.scip?.uses ?? []) {
    const key = positionKey(use.file, use.at);
    const list = usesAt.get(key);
    if (list === undefined) usesAt.set(key, [use]);
    else list.push(use);
  }
  // every symbol a repo document defines, a local one keyed with its document
  const defined = new Set(
    (input.scip?.definitions ?? []).map((d) => scipKey(d.file, d.symbol)),
  );
  const sees = visibility(files, imports);
  const callable = callableByName(defs.definitions);

  const call_targets: CallTargetRow[] = [];
  let unmatched = 0;
  for (const site of call_sites) {
    const file = files[site.file_id - 1] as FileRow;
    const key = positionKey(file.path, { line: site.line, col: site.col });
    const bound = new Set<number>();
    let outside = false;
    for (const use of usesAt.get(key) ?? []) {
      const symbol = scipKey(use.file, use.symbol);
      const def = defs.scipToDef.get(symbol);
      if (def !== undefined) bound.add(def);
      else if (defined.has(symbol)) unmatched++;
      else if (!isLocal(use.symbol)) outside = true;
    }
    if (bound.size === 1) {
      const [def] = bound;
      call_targets.push({
        site_id: site.id,
        def_id: def as number,
        label: "bound",
        collision: 0,
      });
      continue;
    }
    if (outside) continue;
    const targets: number[] = [];
    for (const seen of sees(site.file_id)) {
      targets.push(...(callable.get(seen)?.get(site.callee_name) ?? []));
    }
    targets.sort((a, b) => a - b);
    const collision = targets.length >= 2 ? 1 : 0;
    for (const def of targets) {
      call_targets.push({
        site_id: site.id,
        def_id: def,
        label: "scoped",
        collision,
      });
    }
  }
  return {
    call_sites,
    call_targets,
    unmatchedBoundUses: unmatched,
    redactions,
  };
}

// A finder of the definition enclosing a position in one file: the innermost of its outline
// definitions whose range holds the position, ends exclusive, else its module row. rows are
// the file's definitions, the module row among them, each nested in its parent's range.
export function enclosingIn(
  path: string,
  rows: readonly DefinitionRow[],
): (at: Pos) => number {
  const module = rows.find((r) => r.kind === "module");
  if (module === undefined) {
    throw new Error(`the merge has no module row for ${path}`);
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const depth = (row: DefinitionRow): number => {
    let n = 0;
    for (
      let p = row.parent_id;
      p !== null;
      p = byId.get(p)?.parent_id ?? null
    ) {
      n++;
    }
    return n;
  };
  // by start, the longer first, then the outer first: the order the outline nests them in
  const sorted = rows
    .filter((r) => r !== module)
    .map((row) => ({ row, depth: depth(row) }))
    .sort(
      (a, b) =>
        comparePos(startOf(a.row), startOf(b.row)) ||
        comparePos(endOf(b.row), endOf(a.row)) ||
        a.depth - b.depth,
    )
    .map((d) => d.row);
  return (at) => {
    // the last definition to start at or before the position
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (comparePos(startOf(sorted[mid] as DefinitionRow), at) <= 0) {
        lo = mid + 1;
      } else hi = mid;
    }
    // the innermost holder is that definition or one of its ancestors, since ranges nest
    for (
      let row: DefinitionRow | undefined = sorted[lo - 1];
      row !== undefined;
      row = row.parent_id === null ? undefined : byId.get(row.parent_id)
    ) {
      if (comparePos(at, endOf(row)) < 0) return row.id;
    }
    return module.id;
  };
}

const startOf = (row: DefinitionRow): Pos => ({
  line: row.start_line,
  col: row.start_col,
});
const endOf = (row: DefinitionRow): Pos => ({
  line: row.end_line,
  col: row.end_col,
});

// The store's order: file, line and col, then the other columns, a NULL receiver first.
function compareSites(a: CallSiteRow, b: CallSiteRow): number {
  return (
    a.file_id - b.file_id ||
    a.line - b.line ||
    a.col - b.col ||
    a.enclosing_def_id - b.enclosing_def_id ||
    comparePaths(a.callee_name, b.callee_name) ||
    compareNullable(a.receiver_text, b.receiver_text) ||
    comparePaths(a.producer, b.producer)
  );
}

function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return comparePaths(a, b);
}

// Each file's functions, methods and classes by name, their ids ascending.
function callableByName(
  definitions: readonly DefinitionRow[],
): Map<number, Map<string, number[]>> {
  const out = new Map<number, Map<string, number[]>>();
  for (const def of definitions) {
    if (!CALLABLE.has(def.kind)) continue;
    let names = out.get(def.file_id);
    if (names === undefined) {
      names = new Map();
      out.set(def.file_id, names);
    }
    const ids = names.get(def.name);
    if (ids === undefined) names.set(def.name, [def.id]);
    else ids.push(def.id);
  }
  return out;
}

// The files each file sees, itself included, by id: those it imports, other than a script a
// shell file runs by path, and those reached from them through imports that pass names on.
function visibility(
  files: readonly FileRow[],
  imports: readonly ImportRow[],
): (fileId: number) => ReadonlySet<number> {
  const imported = new Map<number, Set<number>>();
  const passed = new Map<number, Set<number>>();
  for (const row of imports) {
    if (row.dst_file_id === null || row.kind === "exec") continue;
    add(imported, row.src_file_id, row.dst_file_id);
    if (passesOn(files[row.src_file_id - 1] as FileRow, row)) {
      add(passed, row.src_file_id, row.dst_file_id);
    }
  }
  const memo = new Map<number, Set<number>>();
  return (fileId) => {
    let seen = memo.get(fileId);
    if (seen !== undefined) return seen;
    seen = new Set([fileId]);
    const queue: number[] = [];
    for (const dst of imported.get(fileId) ?? []) {
      seen.add(dst);
      queue.push(dst);
    }
    for (let i = 0; i < queue.length; i++) {
      for (const next of passed.get(queue[i] as number) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    memo.set(fileId, seen);
    return seen;
  };
}

// Whether an import makes the names of the file it imports its importers' too: a TS or JS
// export ... from, any import of a Python package's __init__.py, and a shell source.
function passesOn(src: FileRow, row: ImportRow): boolean {
  switch (src.lang) {
    case "typescript":
    case "javascript":
      return row.kind === "re-export";
    case "python":
      return posix.basename(src.path) === "__init__.py";
    case "shell":
      return row.kind === "source";
    default:
      return false;
  }
}

function add(map: Map<number, Set<number>>, key: number, value: number): void {
  const set = map.get(key);
  if (set === undefined) map.set(key, new Set([value]));
  else set.add(value);
}
