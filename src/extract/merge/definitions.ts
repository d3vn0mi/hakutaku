// The definitions table. Each code, test and test-support file gets its outline definitions
// and one module row: qualname <module>, kind module, from (1,1) to (lines + 1, 1), its end
// exclusive, producer hakutaku.
// - Ordinals number the repeats of a qualname in file order.
// - A definition's parent is the innermost outline definition whose range holds it, as the
//   outline nests them; a top-level one has none.
// - A SCIP definition joins each outline definition one of whose name positions equals its
//   own. Each document's module symbol goes to its file's module row and joins nothing; any
//   other SCIP definition that joins nothing is counted. SCIP facts of a file off the map are
//   dropped.
// - TS and JS take exported from the outline's syntax. Python's is set once the imports are
//   known (mergeImports); shell and other languages export nothing.
// - A signature is the trimmed line at the definition's name, redacted, then cut to 240
//   characters.
import { comparePaths, MODULE_QUALNAME } from "../../model/index.js";
import type { DefinitionRow, FileRow } from "../../store/index.js";
import type { OutlineDef } from "../facts.js";
import { comparePos } from "../outline.js";
import { isModuleOf, positionKey } from "../scip/facts.js";
import { isOnMap } from "./files.js";
import { decodeText, redactLine } from "./text.js";
import type { MergeInput } from "./types.js";

export interface MergedDefinitions {
  definitions: DefinitionRow[];
  // each file's rows, in id order, for every code, test and test-support file
  byFile: Map<string, DefinitionRow[]>;
  unmatchedScipDefinitions: number;
  // scipKey(file, symbol) to the outline definition the symbol joined; a symbol that joined
  // two or more definitions is left out, so nothing binds through it to a guess
  scipToDef: Map<string, number>;
  // redactText's count over the stored signatures
  redactions: number;
}

const NUL = String.fromCharCode(0);

const isLocal = (symbol: string): boolean => symbol.startsWith("local ");

// A SCIP symbol's key in scipToDef. A global symbol is its own key. A local one ("local N")
// names something inside its own document only, so its key also holds that document's path,
// joined by a NUL: no repo path holds one, and no global symbol ends as a local id does.
export function scipKey(file: string, symbol: string): string {
  return isLocal(symbol) ? `${file}${NUL}${symbol}` : symbol;
}

// A definition before its id is known.
interface Draft {
  row: DefinitionRow;
  parent: Draft | null;
  symbols: string[];
}

// The outline's order: start, the longer first, then qualname.
const compareOutline = (a: OutlineDef, b: OutlineDef): number =>
  comparePos(a.start, b.start) ||
  comparePos(b.end, a.end) ||
  comparePaths(a.qualname, b.qualname);

// The store's order inside one file: start, qualname, ordinal.
const compareRows = (a: DefinitionRow, b: DefinitionRow): number =>
  a.start_line - b.start_line ||
  a.start_col - b.start_col ||
  comparePaths(a.qualname, b.qualname) ||
  a.ordinal - b.ordinal;

// A global symbol before a local one, then path order.
const compareSymbols = (a: string, b: string): number =>
  Number(isLocal(a)) - Number(isLocal(b)) || comparePaths(a, b);

const holds = (outer: OutlineDef, inner: OutlineDef): boolean =>
  comparePos(outer.start, inner.start) <= 0 &&
  comparePos(inner.end, outer.end) <= 0;

export function mergeDefinitions(
  input: MergeInput,
  files: readonly FileRow[],
): MergedDefinitions {
  // only the files on the map are read below, so another file's facts are dropped
  const onMap = files.filter((f) => isOnMap(f.kind));
  const outlines = groupByFile(input.astGrep?.defs ?? []);
  const scipDefs = groupByFile(input.scip?.definitions ?? []);

  const definitions: DefinitionRow[] = [];
  const byFile = new Map<string, DefinitionRow[]>();
  const joined = new Map<string, Set<Draft>>(); // scipKey to the drafts it joined
  let unmatched = 0;
  let redactions = 0;
  for (const file of onMap) {
    const outline = [...(outlines.get(file.path) ?? [])].sort(compareOutline);
    const lines = outline.length > 0 ? fileLines(input, file.path) : [];
    const moduleRow: DefinitionRow = {
      id: 0,
      file_id: file.id,
      qualname: MODULE_QUALNAME,
      ordinal: 1,
      name: MODULE_QUALNAME,
      kind: "module",
      start_line: 1,
      start_col: 1,
      end_line: file.lines + 1,
      end_col: 1,
      exported: 0,
      parent_id: null,
      scip_symbol: null,
      signature: null,
      producer: "hakutaku",
    };

    const drafts: Draft[] = [];
    const ordinals = new Map<string, number>();
    const open: Array<{ def: OutlineDef; draft: Draft }> = [];
    const atName = new Map<string, Draft[]>(); // positionKey of a name to its drafts
    for (const def of outline) {
      while (
        open.length > 0 &&
        !holds((open.at(-1) as { def: OutlineDef }).def, def)
      ) {
        open.pop();
      }
      const ordinal = (ordinals.get(def.qualname) ?? 0) + 1;
      ordinals.set(def.qualname, ordinal);
      const signature = redactLine(signatureLine(file.path, def, lines));
      redactions += signature.count;
      const draft: Draft = {
        row: {
          id: 0,
          file_id: file.id,
          qualname: def.qualname,
          ordinal,
          name: def.name,
          kind: def.kind,
          start_line: def.start.line,
          start_col: def.start.col,
          end_line: def.end.line,
          end_col: def.end.col,
          exported:
            (file.lang === "typescript" || file.lang === "javascript") &&
            def.exportedSyntax
              ? 1
              : 0,
          parent_id: null,
          scip_symbol: null,
          signature: signature.text,
          producer: "ast-grep",
        },
        parent: open.at(-1)?.draft ?? null,
        symbols: [],
      };
      drafts.push(draft);
      open.push({ def, draft });
      for (const at of def.nameAt) {
        const key = positionKey(file.path, at);
        const list = atName.get(key);
        if (list === undefined) atName.set(key, [draft]);
        else list.push(draft);
      }
    }

    const moduleSymbols: string[] = [];
    for (const d of scipDefs.get(file.path) ?? []) {
      if (isModuleOf(d.symbol, d.file)) {
        moduleSymbols.push(d.symbol);
        continue;
      }
      const hits = atName.get(positionKey(d.file, d.at));
      if (hits === undefined) {
        unmatched++;
        continue;
      }
      const key = scipKey(d.file, d.symbol);
      const set = joined.get(key) ?? new Set<Draft>();
      for (const draft of hits) {
        draft.symbols.push(d.symbol);
        set.add(draft);
      }
      joined.set(key, set);
    }
    moduleRow.scip_symbol = moduleSymbols.sort(comparePaths)[0] ?? null;

    for (const draft of drafts) {
      draft.row.scip_symbol = draft.symbols.sort(compareSymbols)[0] ?? null;
    }
    const rows = [moduleRow, ...drafts.map((d) => d.row)].sort(compareRows);
    for (const row of rows) {
      row.id = definitions.length + 1;
      definitions.push(row);
    }
    for (const draft of drafts) {
      draft.row.parent_id = draft.parent === null ? null : draft.parent.row.id;
    }
    byFile.set(file.path, rows);
  }

  const scipToDef = new Map<string, number>();
  for (const [key, drafts] of joined) {
    if (drafts.size !== 1) continue;
    const [only] = drafts;
    scipToDef.set(key, (only as Draft).row.id);
  }
  return {
    definitions,
    byFile,
    unmatchedScipDefinitions: unmatched,
    scipToDef,
    redactions,
  };
}

function groupByFile<T extends { file: string }>(
  items: readonly T[],
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const list = out.get(item.file);
    if (list === undefined) out.set(item.file, [item]);
    else list.push(item);
  }
  return out;
}

// A file's lines as the store reads them.
function fileLines(input: MergeInput, path: string): string[] {
  return decodeText(input.readSnapshot(path)).split("\n");
}

// The trimmed line at a definition's name, or at its start when it has none: the line the
// outline's own signature was cut from.
function signatureLine(
  path: string,
  def: OutlineDef,
  lines: readonly string[],
): string {
  const line = (def.nameAt[0] ?? def.start).line;
  const text = lines[line - 1];
  if (text === undefined) {
    throw new Error(
      `the outline names line ${line} of ${path}, past the file's end`,
    );
  }
  return text.trim();
}
