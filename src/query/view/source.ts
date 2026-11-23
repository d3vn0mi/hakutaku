// sourceData: one file's stored text, as redacted at build time, with its definitions and the
// call sites in it, each with the definition it calls. Null when the store holds no text for it.
import { formatId } from "../../model/ids.js";
import type { DefKind } from "../../model/types.js";
import type { Store } from "../../store/index.js";
import { readSource } from "../source.js";
import { buildOf, builtCommitOf, fileFacts, rows } from "./lookup.js";
import type { SourceData } from "./types.js";

// What redaction leaves in a stored line, in the form «redacted:<rule>».
const REDACTED = "«redacted:";

const DEFS_SQL = `SELECT qualname, ordinal, kind, start_line, end_line FROM definitions
  WHERE file_id = ? AND kind <> 'module' ORDER BY id`;

const SITES_SQL = `SELECT s.line, s.col, t.label, t.collision, f.path, d.qualname, d.ordinal
  FROM call_sites s
  JOIN call_targets t ON t.site_id = s.id
  JOIN definitions d ON d.id = t.def_id
  JOIN files f ON f.id = d.file_id
  WHERE s.file_id = ? ORDER BY s.line, s.col, t.def_id`;

export function sourceData(store: Store, fileId: number): SourceData | null {
  const repo = store.meta.repoId;
  const file = fileFacts(store, fileId);
  if (file.has_source === 0) return null;
  const text = readSource(store, fileId);
  if (text === null) return null;
  return {
    builtCommit: builtCommitOf(store),
    build: buildOf(store),
    file: formatId({ kind: "file", repo, path: file.path }),
    lines: file.lines,
    text,
    redactions: occurrences(text, REDACTED),
    defs: rows<{
      qualname: string;
      ordinal: number;
      kind: DefKind;
      start_line: number;
      end_line: number;
    }>(store, DEFS_SQL, fileId).map((d) => ({
      id: formatId({
        kind: "definition",
        repo,
        path: file.path,
        qualname: d.qualname,
        ordinal: d.ordinal,
      }),
      kind: d.kind,
      line: d.start_line,
      endLine: d.end_line,
    })),
    sites: rows<{
      line: number;
      col: number;
      label: "bound" | "scoped";
      collision: number;
      path: string;
      qualname: string;
      ordinal: number;
    }>(store, SITES_SQL, fileId).map((s) => ({
      line: s.line,
      col: s.col,
      target: formatId({
        kind: "definition",
        repo,
        path: s.path,
        qualname: s.qualname,
        ordinal: s.ordinal,
      }),
      label: s.label,
      collision: s.collision !== 0,
    })),
  };
}

function occurrences(text: string, part: string): number {
  let count = 0;
  for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + 1)) {
    count += 1;
  }
  return count;
}
