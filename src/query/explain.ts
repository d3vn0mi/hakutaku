// code_explain: a code file, or a definition, in the contract's fixed shape (docs/tools.md).
// Each answer is built as one literal in the contract's key order, which JSON.stringify keeps.
import {
  comparePaths,
  type DefKind,
  type Id,
  type NodeRef,
  viewOf,
} from "../model/index.js";
import type { Store } from "../store/index.js";
import { type ToolError, toolError } from "../tools/errors.js";
import { INLINE_CAPS } from "../tools/limits.js";
import type {
  Checked,
  ExplainDefinitionAnswer,
  ExplainFileAnswer,
  ExplainMetrics,
} from "../tools/types.js";
import { fail, ok, type QueryCtx, type QueryOut } from "./ctx.js";
import { resolveTarget, wrongKind } from "./resolve.js";
import {
  type DefInfo,
  type FileInfo,
  type StoreIndex,
  storeIndex,
} from "./store-index.js";
import { explainLabel } from "./tiers.js";

const TAKES = "a code file or a definition";

export function queryExplain(
  store: Store,
  args: Checked<"code_explain">,
  q: QueryCtx,
): QueryOut<ExplainFileAnswer | ExplainDefinitionAnswer> {
  const target = resolveTarget(store, q.repo, args.target, "target");
  if ("code" in target) return fail(target);
  const ix = storeIndex(store);
  switch (target.kind) {
    case "repo":
    case "directory":
      return fail(
        wrongKind(
          "target",
          target,
          "code_explain",
          TAKES,
          "code_overview describes repos and components",
        ),
      );
    case "external":
      return fail(
        wrongKind(
          "target",
          target,
          "code_explain",
          TAKES,
          "code_references lists a library's importers",
        ),
      );
    case "file": {
      const file = fileAt(ix, target.fileId);
      if (!file.production && !file.test) return fail(notCode(file));
      return ok(fileAnswer(store, ix, file, q));
    }
    case "definition": {
      const file = fileAt(ix, target.fileId);
      const def = ix.defs.get(target.defId);
      if (def === undefined) {
        throw new RangeError(`the store has no definition ${target.defId}`);
      }
      // module scope is its file; resolveTarget already answers it so
      if (!isNamed(def)) return ok(fileAnswer(store, ix, file, q));
      return ok(definitionAnswer(store, ix, file, def, q));
    }
  }
}

// A config, doc or other file: code_explain takes code, tests and test support only.
function notCode(file: FileInfo): ToolError {
  const article = /^[aeiou]/.test(file.kind) ? "an" : "a";
  return toolError(
    "invalid_argument",
    `target is ${article} ${file.kind} file; code_explain takes ${TAKES}`,
    {
      field: "target",
      hint: "code_snippet shows its lines; code_search_text searches it",
    },
  );
}

function fileAnswer(
  store: Store,
  ix: StoreIndex,
  file: FileInfo,
  q: QueryCtx,
): ExplainFileAnswer {
  const ref: NodeRef = { kind: "file", repo: ix.repo, path: file.path };
  return {
    id: ix.idOfFile(file.id),
    kind: file.test ? "test-file" : "file",
    builtCommit: q.builtCommit,
    stale: q.stale,
    ...fileFacts(store, ix, file),
    definitions: definitionsOf(ix, file),
    view: viewOf(ref),
  };
}

function definitionAnswer(
  store: Store,
  ix: StoreIndex,
  file: FileInfo,
  def: Named,
  q: QueryCtx,
): ExplainDefinitionAnswer {
  const ref: NodeRef = {
    kind: "definition",
    repo: ix.repo,
    path: file.path,
    qualname: def.qualname,
    ordinal: def.ordinal,
  };
  const { label, note } = explainLabel(store, def, file.lang);
  return {
    id: ix.idOfDef(def.id),
    kind: def.kind,
    builtCommit: q.builtCommit,
    stale: q.stale,
    definedIn: ix.idOfFile(file.id),
    line: def.startLine,
    usedByFiles: def.usedByFiles,
    mentionedByTests: def.mentionedByTests,
    label,
    note,
    ...fileFacts(store, ix, file),
    view: viewOf(ref),
  };
}

// The fields both answers give about a file, from component to changesTogetherWith, in order.
interface FileFacts {
  component: string;
  lines: number;
  entryPoint: boolean;
  inImportCycle: boolean;
  metrics: ExplainMetrics;
  importedBy: { total: number; top: Id[] };
  imports: { total: number; top: Id[] };
  changesTogetherWith: Array<{ id: Id; commits: number }>;
}

function fileFacts(store: Store, ix: StoreIndex, file: FileInfo): FileFacts {
  const caps = INLINE_CAPS.explain;
  const importers = (ix.importsIn.get(file.id) ?? []).map((edge) => edge.src);
  const imported = (ix.importsOut.get(file.id) ?? []).flatMap((edge) =>
    edge.dstFile === null ? [] : [edge.dstFile],
  );
  return {
    component: componentName(ix, file),
    lines: file.lines,
    entryPoint: file.entry,
    inImportCycle: file.cycleId !== null,
    metrics: {
      dependentsRank: file.rank,
      importedBy: file.fanIn,
      imports: file.fanOut,
      commits90d: file.churn,
      hotspot: file.production ? (file.hotspot ?? 0) : 0,
    },
    importedBy: byRank(ix, importers, caps.importedBy),
    imports: byRank(ix, imported, caps.imports),
    changesTogetherWith: partners(store, ix, file, caps.changesTogetherWith),
  };
}

// The component's path without its "/": the root component "./" is ".".
function componentName(ix: StoreIndex, file: FileInfo): string {
  if (file.componentId === null) return "";
  const component = ix.components.get(file.componentId);
  if (component === undefined) {
    throw new RangeError(`the store has no component ${file.componentId}`);
  }
  return component.path.slice(0, -1);
}

// The distinct files among fileIds: their count, and the first cap of them by rank.
function byRank(
  ix: StoreIndex,
  fileIds: readonly number[],
  cap: number,
): { total: number; top: Id[] } {
  const files = [...new Set(fileIds)]
    .map((id) => fileAt(ix, id))
    .sort(ix.compareFiles);
  return {
    total: files.length,
    top: files.slice(0, cap).map((f) => ix.idOfFile(f.id)),
  };
}

interface CochangeRow {
  partner_file_id: number;
  commits: number;
}

// The file's stored co-change partners, by shared commits descending, then path.
function partners(
  store: Store,
  ix: StoreIndex,
  file: FileInfo,
  cap: number,
): Array<{ id: Id; commits: number }> {
  const rows = store.db
    .prepare("SELECT partner_file_id, commits FROM cochange WHERE file_id = ?")
    .all(file.id) as unknown as CochangeRow[];
  return rows
    .map((row) => ({
      file: fileAt(ix, row.partner_file_id),
      commits: row.commits,
    }))
    .sort(
      (a, b) => b.commits - a.commits || comparePaths(a.file.path, b.file.path),
    )
    .slice(0, cap)
    .map((p) => ({ id: ix.idOfFile(p.file.id), commits: p.commits }));
}

// The file's definitions without its module row, by files using them descending, then line,
// then qualname; the first 8 of them.
function definitionsOf(
  ix: StoreIndex,
  file: FileInfo,
): ExplainFileAnswer["definitions"] {
  const defs = (ix.defsByFile.get(file.id) ?? [])
    .filter(isNamed)
    .sort(
      (a, b) =>
        b.usedByFiles - a.usedByFiles ||
        a.startLine - b.startLine ||
        comparePaths(a.qualname, b.qualname) ||
        a.ordinal - b.ordinal,
    );
  return {
    total: defs.length,
    top: defs.slice(0, INLINE_CAPS.explain.definitions).map((def) => ({
      id: ix.idOfDef(def.id),
      kind: def.kind,
      line: def.startLine,
      exported: def.exported,
      usedByFiles: def.usedByFiles,
      mentionedByTests: def.mentionedByTests,
    })),
  };
}

type Named = DefInfo & { readonly kind: DefKind };

const isNamed = (def: DefInfo): def is Named => def.kind !== "module";

function fileAt(ix: StoreIndex, fileId: number): FileInfo {
  const file = ix.files.get(fileId);
  if (file === undefined)
    throw new RangeError(`the store has no file ${fileId}`);
  return file;
}
