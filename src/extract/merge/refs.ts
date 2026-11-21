// The refs table: each SCIP use in a code, test or test-support file that is not at a call
// site's position, and whose symbol joined an outline definition, is one reference. A use of
// a file's module symbol (an import's specifier), of a local that names no outline definition,
// or of a library's symbol is none. Its role is the first that applies:
// - import, on one of the lines of an import statement of its file;
// - write, when SCIP marks it with the WriteAccess role;
// - type, when the definition it names is a type;
// - read otherwise.
// No other role is produced. The enclosing definition follows the call sites' rule. A use in a
// Python file is scip-python's, any other scip-typescript's. Rows are in the store's order and
// a row equal to another in every column is kept once.
import { comparePaths, type Producer } from "../../model/index.js";
import type {
  CallSiteRow,
  DefinitionRow,
  FileRow,
  RefRow,
} from "../../store/index.js";
import type { Pos } from "../facts.js";
import { positionKey } from "../scip/facts.js";
import { enclosingIn } from "./calls.js";
import { type MergedDefinitions, scipKey } from "./definitions.js";
import { isOnMap } from "./files.js";
import type { MergeInput } from "./types.js";

// SymbolRole.WriteAccess in SCIP's schema.
const WRITE_ACCESS = 0x4;

export function mergeRefs(
  input: MergeInput,
  files: readonly FileRow[],
  defs: MergedDefinitions,
  sites: readonly CallSiteRow[],
): RefRow[] {
  const onMap = new Map(
    files.filter((f) => isOnMap(f.kind)).map((f) => [f.path, f]),
  );
  const callees = new Set(
    sites.map((s) =>
      positionKey((files[s.file_id - 1] as FileRow).path, {
        line: s.line,
        col: s.col,
      }),
    ),
  );
  // each file's lines that an import statement covers
  const importLines = new Map<string, Set<number>>();
  for (const fact of input.astGrep?.imports ?? []) {
    let set = importLines.get(fact.file);
    if (set === undefined) {
      set = new Set();
      importLines.set(fact.file, set);
    }
    for (let line = fact.startLine; line <= fact.endLine; line++) set.add(line);
  }

  const finders = new Map<string, (at: Pos) => number>();
  const rows: RefRow[] = [];
  for (const use of input.scip?.uses ?? []) {
    const file = onMap.get(use.file);
    if (file === undefined || callees.has(positionKey(use.file, use.at))) {
      continue;
    }
    const defId = defs.scipToDef.get(scipKey(use.file, use.symbol));
    if (defId === undefined) continue;
    let enclosing = finders.get(file.path);
    if (enclosing === undefined) {
      enclosing = enclosingIn(file.path, defs.byFile.get(file.path) ?? []);
      finders.set(file.path, enclosing);
    }
    const def = defs.definitions[defId - 1] as DefinitionRow;
    rows.push({
      id: 0,
      file_id: file.id,
      line: use.at.line,
      col: use.at.col,
      enclosing_def_id: enclosing(use.at),
      def_id: defId,
      role: importLines.get(file.path)?.has(use.at.line)
        ? "import"
        : (use.roles & WRITE_ACCESS) !== 0
          ? "write"
          : def.kind === "type"
            ? "type"
            : "read",
      producer: producerOf(file),
    });
  }
  rows.sort(compareRefs);
  const refs: RefRow[] = [];
  for (const row of rows) {
    const last = refs.at(-1);
    if (last !== undefined && compareRefs(last, row) === 0) continue;
    row.id = refs.length + 1;
    refs.push(row);
  }
  return refs;
}

const producerOf = (file: FileRow): Producer =>
  file.lang === "python" ? "scip-python" : "scip-typescript";

// The store's order: file, line, col and definition, then the other columns.
const compareRefs = (a: RefRow, b: RefRow): number =>
  a.file_id - b.file_id ||
  a.line - b.line ||
  a.col - b.col ||
  a.def_id - b.def_id ||
  a.enclosing_def_id - b.enclosing_def_id ||
  comparePaths(a.role, b.role) ||
  comparePaths(a.producer, b.producer);
