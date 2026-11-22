// mapData: a store's whole map as compact arrays, read with one SELECT per table, in store order.
// Files, components and externals are numbered by their place, which is the store id minus 1;
// definitions by their place once module scope is left out.
import { comparePaths } from "../../model/order.js";
import type {
  DefKind,
  Ecosystem,
  EntryKind,
  FileKind,
  ImportKind,
  Lang,
  Stale,
} from "../../model/types.js";
import type { Store } from "../../store/index.js";
import {
  DEF_KINDS,
  ECOSYSTEMS,
  ENTRY_KINDS,
  FILE_KINDS,
  FLAG_CORE,
  FLAG_ENTRY,
  FLAG_SOURCE,
  IMPORT_KINDS,
  INLINE_OUTLINES_UP_TO,
} from "./constants.js";
import { builtCommitOf, rows } from "./lookup.js";
import type { MapData, MapFile } from "./types.js";

const DAY_SECONDS = 86_400;

// A file with its metrics. A file without a metrics row (one that is not code, a test or test
// support) reads 0 for each, and null for pagerank and last_change.
interface FileLine {
  path: string;
  kind: FileKind;
  lang: Lang | null;
  component_id: number | null;
  lines: number;
  entry: number;
  has_source: number;
  rank: number;
  pagerank: number | null;
  hotspot: number;
  churn: number;
  last_change: number | null;
  cycle: number;
  core: number;
}

const FILES_SQL = `SELECT f.path, f.kind, f.lang, f.component_id, f.lines, f.entry, f.has_source,
  COALESCE(m.dependents_rank, 0) AS rank, m.pagerank, COALESCE(m.hotspot, 0) AS hotspot,
  COALESCE(m.churn_90d, 0) AS churn, m.last_change, COALESCE(m.cycle_id, 0) AS cycle,
  COALESCE(m.core, 0) AS core
  FROM files f LEFT JOIN file_metrics m ON m.file_id = f.id ORDER BY f.id`;

const COMPONENTS_SQL =
  "SELECT path, files, tests, lines FROM components ORDER BY id";

const EXTERNALS_SQL =
  "SELECT ecosystem, name, files FROM externals ORDER BY id";

// The resolved imports: those of a repo file or of a library.
const IMPORTS_SQL = `SELECT src_file_id, dst_file_id, dst_external_id, kind FROM imports
  WHERE dst_file_id IS NOT NULL OR dst_external_id IS NOT NULL ORDER BY id`;

const CYCLES_SQL =
  "SELECT cycle_id, file_id FROM cycles ORDER BY cycle_id, ord";

const ENTRIES_SQL = `SELECT file_id, kind, manifest_file_id, manifest_line, name, def_id
  FROM entry_points ORDER BY file_id, kind, manifest_file_id, manifest_line, name`;

const DEFS_SQL = `SELECT d.id, d.file_id, d.qualname, d.ordinal, d.kind, d.start_line, d.end_line,
  d.exported, COALESCE(m.used_by_files, 0) AS used_by,
  COALESCE(m.mentioned_by_tests, 0) AS tested
  FROM definitions d LEFT JOIN def_metrics m ON m.def_id = d.id
  WHERE d.kind <> 'module' ORDER BY d.id`;

const COCHANGE_SQL =
  "SELECT file_id, partner_file_id, commits FROM cochange ORDER BY file_id, partner_file_id";

export function mapData(
  store: Store,
  opts: { stale: Stale; snippets: boolean; inlineUpTo?: number },
): MapData {
  const { meta } = store;
  const fileLines = rows<FileLine>(store, FILES_SQL);

  const langs = [
    ...new Set(fileLines.flatMap((f) => (f.lang === null ? [] : [f.lang]))),
  ].sort(comparePaths);
  const langIndex = new Map(langs.map((lang, i) => [lang, i]));
  let productionFiles = 0;
  let tests = 0;
  let entryPoints = 0;
  let coreFiles = 0;
  const files = fileLines.map((f): MapFile => {
    if (f.kind === "code") productionFiles += 1;
    if (f.kind === "test" || f.kind === "test-support") tests += 1;
    if (f.entry !== 0) entryPoints += 1;
    if (f.core !== 0) coreFiles += 1;
    return [
      f.path,
      FILE_KINDS.indexOf(f.kind),
      f.lang === null ? -1 : (langIndex.get(f.lang) ?? -1),
      f.component_id === null ? -1 : f.component_id - 1,
      f.lines,
      f.rank,
      f.pagerank === null ? 0 : Number(f.pagerank.toPrecision(4)),
      f.hotspot,
      f.churn,
      f.last_change === null
        ? -1
        : Math.floor((meta.commitTime - f.last_change) / DAY_SECONDS),
      f.cycle,
      (f.entry !== 0 ? FLAG_ENTRY : 0) |
        (f.core !== 0 ? FLAG_CORE : 0) |
        (f.has_source !== 0 ? FLAG_SOURCE : 0),
    ];
  });

  const components = rows<{
    path: string;
    files: number;
    tests: number;
    lines: number;
  }>(store, COMPONENTS_SQL).map((c): [string, number, number, number] => [
    c.path.endsWith("/") ? c.path.slice(0, -1) : c.path,
    c.files,
    c.tests,
    c.lines,
  ]);

  const externals = rows<{ ecosystem: Ecosystem; name: string; files: number }>(
    store,
    EXTERNALS_SQL,
  ).map((x): [number, string, number] => [
    ECOSYSTEMS.indexOf(x.ecosystem),
    x.name,
    x.files,
  ]);

  const imports: number[] = [];
  const libImports: number[] = [];
  for (const i of rows<{
    src_file_id: number;
    dst_file_id: number | null;
    dst_external_id: number | null;
    kind: ImportKind;
  }>(store, IMPORTS_SQL)) {
    if (i.dst_file_id !== null) {
      imports.push(
        i.src_file_id - 1,
        i.dst_file_id - 1,
        IMPORT_KINDS.indexOf(i.kind),
      );
    } else if (i.dst_external_id !== null) {
      libImports.push(i.src_file_id - 1, i.dst_external_id - 1);
    }
  }

  const cycles: number[][] = [];
  let cycleId: number | undefined;
  for (const c of rows<{ cycle_id: number; file_id: number }>(
    store,
    CYCLES_SQL,
  )) {
    if (c.cycle_id !== cycleId) {
      cycles.push([]);
      cycleId = c.cycle_id;
    }
    cycles[cycles.length - 1]?.push(c.file_id - 1);
  }

  const defIds: number[] = [];
  const defs: MapData["defs"] = {
    file: [],
    name: [],
    ordinal: [],
    line: [],
    kind: [],
    exported: [],
    usedBy: [],
  };
  const endLine: number[] = [];
  const tested: number[] = [];
  for (const d of rows<{
    id: number;
    file_id: number;
    qualname: string;
    ordinal: number;
    kind: DefKind;
    start_line: number;
    end_line: number;
    exported: number;
    used_by: number;
    tested: number;
  }>(store, DEFS_SQL)) {
    defIds.push(d.id);
    defs.file.push(d.file_id - 1);
    defs.name.push(d.qualname);
    defs.ordinal.push(d.ordinal);
    defs.line.push(d.start_line);
    defs.kind.push(DEF_KINDS.indexOf(d.kind));
    defs.exported.push(d.exported !== 0 ? 1 : 0);
    defs.usedBy.push(d.used_by);
    endLine.push(d.end_line);
    tested.push(d.tested !== 0 ? 1 : 0);
  }

  const entries = rows<{
    file_id: number;
    kind: EntryKind;
    manifest_file_id: number;
    manifest_line: number;
    name: string;
    def_id: number | null;
  }>(store, ENTRIES_SQL).map((e): MapData["entries"][number] => [
    e.file_id - 1,
    ENTRY_KINDS.indexOf(e.kind),
    e.manifest_file_id - 1,
    e.manifest_line,
    e.name,
    e.def_id === null ? -1 : placeOf(defIds, e.def_id),
  ]);

  const inline = productionFiles <= (opts.inlineUpTo ?? INLINE_OUTLINES_UP_TO);
  let cochange: number[] | null = null;
  if (inline) {
    cochange = [];
    for (const c of rows<{
      file_id: number;
      partner_file_id: number;
      commits: number;
    }>(store, COCHANGE_SQL)) {
      cochange.push(c.file_id - 1, c.partner_file_id - 1, c.commits);
    }
  }

  return {
    format: 1,
    repo: meta.repoId,
    builtCommit: builtCommitOf(store),
    stale: opts.stale,
    detail: meta.detail,
    sources: !meta.noSource && opts.snippets,
    counts: {
      productionFiles,
      tests,
      components: components.length,
      entryPoints,
      cycles: cycles.length,
      importEdges: imports.length / 3,
      libraries: externals.length,
      definitions: defIds.length,
    },
    coreSet: { files: coreFiles, ofFiles: productionFiles },
    langs,
    components,
    files,
    imports,
    externals,
    libImports,
    cycles,
    entries,
    defs,
    outline: inline ? { endLine, tested } : null,
    cochange,
  };
}

// The place of an id in ascending ids, or -1: a definition's index, found by its store id.
function placeOf(ids: readonly number[], id: number): number {
  let low = 0;
  let high = ids.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const at = ids[mid] as number;
    if (at === id) return mid;
    if (at < id) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}
