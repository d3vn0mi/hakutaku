// code_find: where a name is defined (docs/tools.md). Every definition (never a <module> row)
// is matched by its qualname and its name, and every file by its path and its basename, at the
// closest match level. Exact matches come first; the rest are near misses, each labelled.
import type { DefKind } from "../model/index.js";
import type { Store } from "../store/index.js";
import type { Checked, FindAnswer } from "../tools/types.js";
import { ok, type QueryCtx, type QueryOut } from "./ctx.js";
import { MATCH_LEVELS, type MatchLevel, matchLevel } from "./match.js";
import {
  type DefInfo,
  type FileInfo,
  type StoreIndex,
  storeIndex,
} from "./store-index.js";

type Named = DefInfo & { readonly kind: DefKind };

interface Hit {
  level: MatchLevel;
  file: FileInfo; // the file, or the one that holds def
  def: Named | null;
}

export function queryFind(
  store: Store,
  args: Checked<"code_find">,
  q: QueryCtx,
): QueryOut<FindAnswer> {
  const ix = storeIndex(store);
  const hits: Hit[] = [];
  if (args.kind !== "file") {
    for (const def of ix.defs.values()) {
      if (!isNamed(def)) continue;
      if (args.kind !== undefined && def.kind !== args.kind) continue;
      const level = matchLevel(args.name, [def.qualname, def.name]);
      if (level !== null)
        hits.push({ level, file: fileAt(ix, def.fileId), def });
    }
  }
  if (args.kind === undefined || args.kind === "file") {
    for (const file of ix.files.values()) {
      const level = matchLevel(args.name, [file.path, basename(file.path)]);
      if (level !== null) hits.push({ level, file, def: null });
    }
  }
  // by level, then by rank, then path, then line (a file is line 0), then row order
  hits.sort(
    (a, b) =>
      MATCH_LEVELS.indexOf(a.level) - MATCH_LEVELS.indexOf(b.level) ||
      ix.compareFiles(a.file, b.file) ||
      (a.def?.startLine ?? 0) - (b.def?.startLine ?? 0) ||
      (a.def?.id ?? 0) - (b.def?.id ?? 0),
  );
  return ok({
    query: args.name,
    builtCommit: q.builtCommit,
    stale: q.stale,
    matches: hits.map((hit) => matchOf(ix, hit)),
  });
}

function matchOf(ix: StoreIndex, hit: Hit): FindAnswer["matches"][number] {
  const { def, file } = hit;
  if (def === null) {
    return {
      id: ix.idOfFile(file.id),
      kind: file.test ? "test-file" : "file",
      match: hit.level,
    };
  }
  return {
    id: ix.idOfDef(def.id),
    kind: def.kind,
    match: hit.level,
    line: def.startLine,
    container: containerOf(ix, def),
    exported: def.exported,
    usedByFiles: def.usedByFiles,
  };
}

// The parent definition's ID, or else the file's: a <module> row names its file.
function containerOf(ix: StoreIndex, def: Named): string {
  const parent = def.parentId === null ? undefined : ix.defs.get(def.parentId);
  return parent !== undefined && isNamed(parent)
    ? ix.idOfDef(parent.id)
    : ix.idOfFile(def.fileId);
}

const isNamed = (def: DefInfo): def is Named => def.kind !== "module";

const basename = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1);

function fileAt(ix: StoreIndex, fileId: number): FileInfo {
  const file = ix.files.get(fileId);
  if (file === undefined)
    throw new RangeError(`the store has no file ${fileId}`);
  return file;
}
