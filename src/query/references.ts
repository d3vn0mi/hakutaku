// code_references: the uses of a definition that are not calls, or the files that import a
// library (docs/tools.md). Each answer is built as one literal in the contract's key order,
// which JSON.stringify keeps.
import { type NodeRef, viewOf } from "../model/index.js";
import type { Store } from "../store/index.js";
import { INLINE_CAPS } from "../tools/limits.js";
import type {
  Checked,
  LibraryReferencesAnswer,
  ReferencesAnswer,
} from "../tools/types.js";
import { referrersOf } from "./calls.js";
import { fail, ok, type QueryCtx, type QueryOut } from "./ctx.js";
import { resolveTarget, wrongKind } from "./resolve.js";
import { locationText } from "./source.js";
import { type FileInfo, type StoreIndex, storeIndex } from "./store-index.js";

type Reference = ReferencesAnswer["references"][number];

export function queryReferences(
  store: Store,
  args: Checked<"code_references">,
  q: QueryCtx,
): QueryOut<ReferencesAnswer | LibraryReferencesAnswer> {
  const target = resolveTarget(store, q.repo, args.symbol, "symbol");
  if ("code" in target) return fail(target);
  const ix = storeIndex(store);
  const refuse = (hint: string) =>
    fail(
      wrongKind(
        "symbol",
        target,
        "code_references",
        "a definition or a library",
        hint,
      ),
    );
  switch (target.kind) {
    case "file":
      return refuse("code_deps with direction in lists a file's importers");
    case "repo":
    case "directory":
      return refuse("code_overview describes repos and components");
    case "external":
      return ok(libraryAnswer(ix, target.externalId, target.ref, q));
    case "definition":
      return ok(definitionAnswer(store, ix, target.defId, target.ref, q));
  }
}

// A definition's uses, by their file's rank, then path, line and col.
function definitionAnswer(
  store: Store,
  ix: StoreIndex,
  defId: number,
  ref: NodeRef,
  q: QueryCtx,
): ReferencesAnswer {
  const uses = referrersOf(store, defId)
    .map((use) => ({ use, file: fileAt(ix, use.fileId) }))
    .sort(
      (a, b) =>
        ix.compareFiles(a.file, b.file) ||
        a.use.line - b.use.line ||
        a.use.col - b.use.col ||
        a.use.refId - b.use.refId,
    );
  return {
    id: ix.idOfDef(defId),
    builtCommit: q.builtCommit,
    stale: q.stale,
    references: uses.map(({ use, file }) => {
      const out: Reference = {
        in: ix.idOfDef(use.callerDefId),
        file: ix.idOfFile(file.id),
        line: use.line,
        col: use.col,
        role: use.role,
        test: file.test,
      };
      const text = locationText(store, q, file.id, use.line);
      if (text !== undefined) out.text = text;
      return out;
    }),
    view: viewOf(ref),
  };
}

// A library's importers: the distinct repo files with an import of it, tests included; their
// count, and the first of them by rank.
function libraryAnswer(
  ix: StoreIndex,
  externalId: number,
  ref: NodeRef,
  q: QueryCtx,
): LibraryReferencesAnswer {
  const importers = new Set<number>();
  for (const edges of ix.importsOut.values()) {
    for (const edge of edges) {
      if (edge.dstExternal === externalId) importers.add(edge.src);
    }
  }
  const files = [...importers]
    .map((id) => fileAt(ix, id))
    .sort(ix.compareFiles);
  return {
    id: ix.idOfExternal(externalId),
    kind: "library",
    builtCommit: q.builtCommit,
    stale: q.stale,
    importedBy: {
      total: files.length,
      top: files
        .slice(0, INLINE_CAPS.library.importedBy)
        .map((file) => ix.idOfFile(file.id)),
    },
    view: viewOf(ref),
  };
}

function fileAt(ix: StoreIndex, fileId: number): FileInfo {
  const file = ix.files.get(fileId);
  if (file === undefined)
    throw new RangeError(`the store has no file ${fileId}`);
  return file;
}
