// code_search_text: every stored line that holds a literal (docs/tools.md). The literal goes to
// the store's trigram index as one quoted phrase, so none of its characters is query syntax, and
// each row the index returns is checked again for the literal itself. path_glob filters the
// paths the store holds, and nothing else: no glob ever reaches a filesystem.
//
// A literal that holds a NUL finds nothing. FTS5 reads a query only up to its first NUL, and
// SQLite hands a stored line back only up to its first NUL, so no row could show that it holds
// one; the index is not asked.
import type { StatementSync } from "node:sqlite";
import type { Store } from "../store/index.js";
import { toolError } from "../tools/errors.js";
import { MAX_GLOB_CHARS } from "../tools/limits.js";
import type { Checked, SearchTextAnswer } from "../tools/types.js";
import { fail, ok, type QueryCtx, type QueryOut } from "./ctx.js";
import { matchGlob } from "./glob.js";
import { locationText } from "./source.js";
import { type FileInfo, storeIndex } from "./store-index.js";
import { searchBlindSpots } from "./tiers.js";

const SEARCH_SQL =
  "SELECT text, file_id, line FROM text_index WHERE text_index MATCH ?";
const searches = new WeakMap<Store, StatementSync>();
const NUL = String.fromCharCode(0);

// One row of the text index, with the types the store's writer guarantees.
interface IndexRow {
  text: string;
  file_id: number;
  line: number;
}

export function querySearchText(
  store: Store,
  args: Checked<"code_search_text">,
  q: QueryCtx,
): QueryOut<SearchTextAnswer> {
  const glob = args.path_glob;
  // Counted in UTF-16 units, as the cap on every string argument is.
  if (glob !== undefined && glob.length > MAX_GLOB_CHARS) {
    return fail(
      toolError(
        "invalid_argument",
        `path_glob must have at most ${MAX_GLOB_CHARS} characters`,
        {
          field: "path_glob",
          hint: "see the input schema of code_search_text",
        },
      ),
    );
  }
  if (store.meta.noSource) {
    return fail(toolError("no_source", `sources are not stored for ${q.repo}`));
  }
  const ix = storeIndex(store);
  const globbed = new Map<number, boolean>(); // by file id: does its path match the glob
  const found: Array<{ file: FileInfo; line: number }> = [];
  for (const row of rowsFor(store, args.text)) {
    if (!row.text.includes(args.text)) continue;
    const file = ix.files.get(row.file_id);
    if (file === undefined) {
      throw new RangeError(`the store has no file ${row.file_id}`);
    }
    if (glob !== undefined) {
      let matches = globbed.get(file.id);
      if (matches === undefined) {
        matches = matchGlob(glob, file.path);
        globbed.set(file.id, matches);
      }
      if (!matches) continue;
    }
    found.push({ file, line: row.line });
  }
  found.sort((a, b) => ix.compareFiles(a.file, b.file) || a.line - b.line);
  return ok({
    text: args.text,
    builtCommit: q.builtCommit,
    stale: q.stale,
    hits: found.map(({ file, line }) => {
      const text = locationText(store, q, file.id, line);
      return {
        file: ix.idOfFile(file.id),
        line,
        ...(text === undefined ? {} : { text }),
      };
    }),
    blindSpots: searchBlindSpots(store),
  });
}

// The rows of the text index that may hold text: those the index finds for it as one phrase.
function rowsFor(store: Store, text: string): IndexRow[] {
  if (text.includes(NUL)) return [];
  let search = searches.get(store);
  if (search === undefined) {
    search = store.db.prepare(SEARCH_SQL);
    searches.set(store, search);
  }
  return search.all(`"${text.replaceAll('"', '""')}"`) as unknown as IndexRow[];
}
