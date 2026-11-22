// outlineData: one file's definitions, module scope left out, and its co-change partners. The
// map carries these for every file up to the inline limit; above it, the page asks per file.
import { formatId } from "../../model/ids.js";
import type { DefKind } from "../../model/types.js";
import type { Store } from "../../store/index.js";
import { builtCommitOf, fileFacts, rows } from "./lookup.js";
import type { OutlineData } from "./types.js";

const DEFS_SQL = `SELECT d.qualname, d.ordinal, d.kind, d.start_line, d.end_line, d.exported,
  COALESCE(m.used_by_files, 0) AS used_by, COALESCE(m.mentioned_by_tests, 0) AS tested
  FROM definitions d LEFT JOIN def_metrics m ON m.def_id = d.id
  WHERE d.file_id = ? AND d.kind <> 'module' ORDER BY d.id`;

const PARTNERS_SQL = `SELECT p.path, c.commits FROM cochange c JOIN files p ON p.id = c.partner_file_id
  WHERE c.file_id = ? ORDER BY c.file_id, c.partner_file_id`;

export function outlineData(store: Store, fileId: number): OutlineData {
  const repo = store.meta.repoId;
  const { path } = fileFacts(store, fileId);
  return {
    builtCommit: builtCommitOf(store),
    file: formatId({ kind: "file", repo, path }),
    defs: rows<{
      qualname: string;
      ordinal: number;
      kind: DefKind;
      start_line: number;
      end_line: number;
      exported: number;
      used_by: number;
      tested: number;
    }>(store, DEFS_SQL, fileId).map((d) => ({
      id: formatId({
        kind: "definition",
        repo,
        path,
        qualname: d.qualname,
        ordinal: d.ordinal,
      }),
      qualname: d.qualname,
      ordinal: d.ordinal,
      kind: d.kind,
      line: d.start_line,
      endLine: d.end_line,
      exported: d.exported !== 0,
      usedByFiles: d.used_by,
      mentionedByTests: d.tested !== 0,
    })),
    cochange: rows<{ path: string; commits: number }>(
      store,
      PARTNERS_SQL,
      fileId,
    ).map((c) => ({
      id: formatId({ kind: "file", repo, path: c.path }),
      commits: c.commits,
    })),
  };
}
