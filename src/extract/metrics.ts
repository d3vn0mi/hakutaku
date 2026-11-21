// The metrics tables, from the merged rows and the history: each file's PageRank and rank, fan
// counts, churn, hotspot, cycle, core flag and last change; each definition's users and whether
// tests mention it; the files that change together; commits per week; and the renames.
//
// Production means kind code. Every window is anchored at the built commit's committer time t
// and is open at its start: (t - window, t]. A commit touches the paths its files list, which
// hold its deleted paths and a rename's new path.
import type { History } from "../export/index.js";
import {
  closingChain,
  comparePaths,
  coreSet,
  type Edge,
  type FileKind,
  hotspots,
  type Lang,
  pagerank,
  rankOrder,
  tarjan,
} from "../model/index.js";
import type {
  CochangeRow,
  Coverage,
  CycleRow,
  DefinitionRow,
  DefMetricRow,
  FileMetricRow,
  FileRow,
  ImportRow,
  RenameRow,
  TimelineRow,
} from "../store/index.js";
import type { ImportFact } from "./facts.js";
import { isOnMap } from "./merge/files.js";
import type { MergedContent } from "./merge/index.js";

const CHURN_SECONDS = 7_776_000; // 90 days
const COCHANGE_SECONDS = 15_552_000; // 180 days, for co-change and the renames
const WEEK_SECONDS = 604_800;
const TIMELINE_WEEKS = 26;
const CORE_SHARE = 0.5;
// A commit counts for co-change when it touches 2 to 30 files of the map, and two files are
// partners when they share at least 2 such commits. Each file keeps its top 8.
const COCHANGE_MIN_FILES = 2;
const COCHANGE_MAX_FILES = 30;
const COCHANGE_MIN_SHARED = 2;
const COCHANGE_TOP = 8;

/** What the test-mention rule reads beyond the merged rows: how the build's engines ended,
 *  and ast-grep's import statements with the names each one binds. */
export interface MentionInput {
  tiers: Coverage["tiers"];
  imports: readonly Pick<ImportFact, "file" | "names">[];
}

export interface Metrics {
  file_metrics: FileMetricRow[];
  def_metrics: DefMetricRow[];
  cochange: CochangeRow[];
  cycles: CycleRow[];
  timeline: TimelineRow[];
  renames: RenameRow[];
  // the files one cycle finder puts in a cycle and the other does not
  cycleDifferences: number;
}

const NO_MENTIONS: MentionInput = { tiers: {}, imports: [] };

/** The metrics of a build. `depcruiseCircular` holds the files dependency-cruiser reports in a
 *  cycle, or null when it did not run; `mentions` defaults to no compiler tier and no imported
 *  names. */
export function computeMetrics(
  content: MergedContent,
  history: History,
  commitTime: number,
  depcruiseCircular: ReadonlySet<string> | null,
  mentions: MentionInput = NO_MENTIONS,
): Metrics {
  // the files table is in path order, so each node list is too, and ties go by path
  const onMap = content.files.filter((f) => isOnMap(f.kind));
  const production = onMap.filter((f) => f.kind === "code");
  const node = new Map(production.map((f, i) => [f.id, i]));
  const { ranked, runtime, lineOf } = productionEdges(content.imports, node);

  const scores = pagerank(production.length, ranked);
  const ranks = rankOrder(scores);
  const { churn, lastChange } = changesOf(history, commitTime);
  const churnOf = (f: FileRow): number => churn.get(f.path) ?? 0;
  const hot = hotspots(scores, production.map(churnOf));
  // a file of the map always has a component; 0 names none
  const core = coreSet(
    scores,
    production.map((f) => f.component_id ?? 0),
    CORE_SHARE,
  );

  const sets = tarjan(production.length, runtime);
  const cycleOf = new Map<number, number>();
  sets.forEach((set, k) => {
    for (const i of set) cycleOf.set(fileAt(production, i).id, k + 1);
  });

  const { importers, imported } = fanOf(content.imports);
  const file_metrics = onMap.map((f): FileMetricRow => {
    const i = node.get(f.id);
    return {
      file_id: f.id,
      pagerank: i === undefined ? null : (scores[i] as number),
      dependents_rank: i === undefined ? null : (ranks[i] as number),
      fan_in: importers.get(f.id)?.size ?? 0,
      fan_out: imported.get(f.id)?.size ?? 0,
      churn_90d: churnOf(f),
      hotspot: i === undefined ? null : (hot[i] as number),
      cycle_id: cycleOf.get(f.id) ?? null,
      core: i !== undefined && core[i] === true ? 1 : 0,
      last_change: lastChange.get(f.path) ?? null,
    };
  });

  return {
    file_metrics,
    def_metrics: defMetrics(content, mentions),
    cochange: cochangeOf(history, commitTime, onMap),
    cycles: cycleRows(sets, runtime, lineOf, production),
    timeline: timelineOf(history, commitTime),
    renames: renamesOf(history, commitTime),
    cycleDifferences:
      depcruiseCircular === null
        ? 0
        : differencesOf(
            content.imports,
            onMap,
            production,
            sets,
            depcruiseCircular,
          ),
  };
}

const inWindow = (time: number, t: number, seconds: number): boolean =>
  time > t - seconds && time <= t;

const isTestSide = (kind: FileKind): boolean =>
  kind === "test" || kind === "test-support";

function fileAt(files: readonly FileRow[], i: number): FileRow {
  const file = files[i];
  if (file === undefined) throw new Error(`metrics: no file at node ${i}`);
  return file;
}

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key);
  if (set === undefined) map.set(key, new Set([value]));
  else set.add(value);
}

// The import edges between production files, each pair once, as node indexes: every kind for
// PageRank, every kind but type-only for the cycles, with the smallest line of a non-type-only
// import of each such pair. A pair (from, to) is keyed from * n + to.
function productionEdges(
  imports: readonly ImportRow[],
  node: ReadonlyMap<number, number>,
): { ranked: Edge[]; runtime: Edge[]; lineOf: Map<number, number> } {
  const n = node.size;
  const ranked: Edge[] = [];
  const runtime: Edge[] = [];
  const lineOf = new Map<number, number>();
  const seen = new Set<number>();
  for (const row of imports) {
    if (row.dst_file_id === null) continue;
    const from = node.get(row.src_file_id);
    const to = node.get(row.dst_file_id);
    if (from === undefined || to === undefined) continue;
    const key = from * n + to;
    if (!seen.has(key)) {
      seen.add(key);
      ranked.push([from, to]);
    }
    if (row.kind === "type-only") continue;
    const line = lineOf.get(key);
    if (line === undefined) {
      runtime.push([from, to]);
      lineOf.set(key, row.line);
    } else if (row.line < line) {
      lineOf.set(key, row.line);
    }
  }
  return { ranked, runtime, lineOf };
}

// Each file's distinct importers and imported files, of any kind; a package or an unresolved
// import names no file.
function fanOf(imports: readonly ImportRow[]): {
  importers: Map<number, Set<number>>;
  imported: Map<number, Set<number>>;
} {
  const importers = new Map<number, Set<number>>();
  const imported = new Map<number, Set<number>>();
  for (const row of imports) {
    if (row.dst_file_id === null) continue;
    addTo(importers, row.dst_file_id, row.src_file_id);
    addTo(imported, row.src_file_id, row.dst_file_id);
  }
  return { importers, imported };
}

// Each path's churn, the commits in (t - 90 days, t] that touch it, and its last change, the
// time of the newest commit of the history that touches it.
function changesOf(
  history: History,
  t: number,
): { churn: Map<string, number>; lastChange: Map<string, number> } {
  const churn = new Map<string, number>();
  const lastChange = new Map<string, number>();
  for (const commit of history.commits) {
    const recent = inWindow(commit.time, t, CHURN_SECONDS);
    for (const path of commit.files) {
      if (recent) churn.set(path, (churn.get(path) ?? 0) + 1);
      const last = lastChange.get(path);
      if (last === undefined || commit.time > last) {
        lastChange.set(path, commit.time);
      }
    }
  }
  return { churn, lastChange };
}

// One row per file of each set's shortest closing chain, from the set's first file on: the
// file, and the smallest line of a non-type-only import from it to the next file of the chain,
// the last file's next being the first. Each chain search gets only its own set's edges, so
// many cycles cost no more than one.
function cycleRows(
  sets: readonly number[][],
  runtime: readonly Edge[],
  lineOf: ReadonlyMap<number, number>,
  production: readonly FileRow[],
): CycleRow[] {
  const n = production.length;
  const setOf = new Int32Array(n).fill(-1);
  sets.forEach((set, k) => {
    for (const i of set) setOf[i] = k;
  });
  const own: Edge[][] = sets.map(() => []);
  for (const edge of runtime) {
    const k = setOf[edge[0]] as number;
    if (k !== -1 && setOf[edge[1]] === k) own[k]?.push(edge);
  }
  const rows: CycleRow[] = [];
  sets.forEach((set, k) => {
    const chain = closingChain(set, own[k] ?? []);
    chain.forEach((from, ord) => {
      const to = chain[(ord + 1) % chain.length] as number;
      const line = lineOf.get(from * n + to);
      if (line === undefined) {
        throw new Error(`metrics: no import line from node ${from} to ${to}`);
      }
      rows.push({
        cycle_id: k + 1,
        ord,
        file_id: fileAt(production, from).id,
        line,
      });
    });
  });
  return rows;
}

// The files one cycle finder puts in a cycle and the other does not, counted only where both
// can see. dependency-cruiser reads TS and JS alone, so a file of Tarjan's sets counts only in
// those languages. Its cycle rule also follows type-only imports and tests, which the production
// run-time sets leave out, so a file it reports counts only when no cycle holds it even over
// every import between files of the map.
function differencesOf(
  imports: readonly ImportRow[],
  onMap: readonly FileRow[],
  production: readonly FileRow[],
  sets: readonly number[][],
  reported: ReadonlySet<string>,
): number {
  const node = new Map(onMap.map((f, i) => [f.id, i]));
  const n = onMap.length;
  const edges: Edge[] = [];
  const seen = new Set<number>();
  for (const row of imports) {
    if (row.dst_file_id === null) continue;
    const from = node.get(row.src_file_id);
    const to = node.get(row.dst_file_id);
    if (from === undefined || to === undefined) continue;
    const key = from * n + to;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push([from, to]);
  }
  const anyCycle = new Set<string>();
  for (const set of tarjan(n, edges)) {
    for (const i of set) anyCycle.add(fileAt(onMap, i).path);
  }
  let count = 0;
  for (const set of sets) {
    for (const i of set) {
      const file = fileAt(production, i);
      const read = file.lang === "typescript" || file.lang === "javascript";
      if (read && !reported.has(file.path)) count++;
    }
  }
  for (const path of reported) if (!anyCycle.has(path)) count++;
  return count;
}

// One row per definition but the module rows. Its users are the production files other than
// its own with a call target on it or a reference to it, and its bound users those of them with
// a bound target or a reference. A test or test-support file with any of these mentions it.
function defMetrics(
  content: MergedContent,
  mentions: MentionInput,
): DefMetricRow[] {
  const files = new Map(content.files.map((f) => [f.id, f]));
  const fileOf = (id: number): FileRow => {
    const file = files.get(id);
    if (file === undefined) throw new Error(`metrics: no file ${id}`);
    return file;
  };
  const defFile = new Map(content.definitions.map((d) => [d.id, d.file_id]));
  const siteFile = new Map(content.call_sites.map((s) => [s.id, s.file_id]));
  const users = new Map<number, Set<number>>();
  const boundUsers = new Map<number, Set<number>>();
  const mentioned = new Set<number>();
  const use = (fileId: number, defId: number, bound: boolean): void => {
    const file = fileOf(fileId);
    if (isTestSide(file.kind)) mentioned.add(defId);
    if (file.kind !== "code" || fileId === defFile.get(defId)) return;
    addTo(users, defId, fileId);
    if (bound) addTo(boundUsers, defId, fileId);
  };
  for (const target of content.call_targets) {
    const fileId = siteFile.get(target.site_id);
    if (fileId === undefined) {
      throw new Error(`metrics: no call site ${target.site_id}`);
    }
    use(fileId, target.def_id, target.label === "bound");
  }
  for (const ref of content.refs) use(ref.file_id, ref.def_id, true);
  mentionByName(content, fileOf, mentions, mentioned);

  return content.definitions
    .filter((d) => d.kind !== "module")
    .map((d) => ({
      def_id: d.id,
      used_by_files: users.get(d.id)?.size ?? 0,
      used_by_files_bound: boundUsers.get(d.id)?.size ?? 0,
      mentioned_by_tests: mentioned.has(d.id) ? 1 : 0,
    }));
}

// Where no compiler tier ran for a definition's language, a test or test-support file also
// mentions it when the file imports the definition's file and holds a call site or an imported
// binding of the definition's name, wherever that binding comes from. A script the file runs by
// path shares no names with it, so an exec import does not count. The compiler tiers are the
// ones code_explain reads: scip-typescript for TS and JS, scip-python for Python, and none for
// any other language.
function mentionByName(
  content: MergedContent,
  fileOf: (id: number) => FileRow,
  mentions: MentionInput,
  mentioned: Set<number>,
): void {
  const { tiers } = mentions;
  const compiled = (lang: Lang | null): boolean =>
    lang === "typescript" || lang === "javascript"
      ? tiers["scip-typescript"] === "ran"
      : lang === "python" && tiers["scip-python"] === "ran";

  // each test-side file's names: its callees and the names its imports bind
  const names = new Map<number, Set<string>>();
  const testSide = new Map<string, number>();
  for (const f of content.files)
    if (isTestSide(f.kind)) testSide.set(f.path, f.id);
  for (const site of content.call_sites) {
    if (isTestSide(fileOf(site.file_id).kind)) {
      addTo(names, site.file_id, site.callee_name);
    }
  }
  for (const fact of mentions.imports) {
    const id = testSide.get(fact.file);
    if (id === undefined) continue;
    for (const name of fact.names) addTo(names, id, name);
  }

  const defsOf = new Map<number, DefinitionRow[]>();
  for (const d of content.definitions) {
    if (d.kind === "module") continue;
    const list = defsOf.get(d.file_id);
    if (list === undefined) defsOf.set(d.file_id, [d]);
    else list.push(d);
  }
  for (const row of content.imports) {
    if (row.dst_file_id === null || row.kind === "exec") continue;
    const heard = names.get(row.src_file_id);
    if (heard === undefined || compiled(fileOf(row.dst_file_id).lang)) continue;
    for (const d of defsOf.get(row.dst_file_id) ?? []) {
      if (heard.has(d.name)) mentioned.add(d.id);
    }
  }
}

// Each file's partners over the commits in (t - 180 days, t] that touch 2 to 30 files of the
// map: the files sharing at least 2 of them. A file keeps its top 8 by shared commits
// descending, then by the partner's path; rows go by file, then partner.
function cochangeOf(
  history: History,
  t: number,
  onMap: readonly FileRow[],
): CochangeRow[] {
  const byPath = new Map(onMap.map((f) => [f.path, f.id]));
  const pathOf = new Map(onMap.map((f) => [f.id, f.path]));
  const shared = new Map<number, Map<number, number>>();
  const bump = (a: number, b: number): void => {
    let partners = shared.get(a);
    if (partners === undefined) {
      partners = new Map();
      shared.set(a, partners);
    }
    partners.set(b, (partners.get(b) ?? 0) + 1);
  };
  for (const commit of history.commits) {
    if (!inWindow(commit.time, t, COCHANGE_SECONDS)) continue;
    const ids: number[] = [];
    for (const path of commit.files) {
      const id = byPath.get(path);
      if (id !== undefined) ids.push(id);
    }
    if (ids.length < COCHANGE_MIN_FILES || ids.length > COCHANGE_MAX_FILES) {
      continue;
    }
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        bump(ids[a] as number, ids[b] as number);
        bump(ids[b] as number, ids[a] as number);
      }
    }
  }

  const rows: CochangeRow[] = [];
  for (const file of [...shared.keys()].sort((a, b) => a - b)) {
    const kept = [...(shared.get(file) ?? [])]
      .filter(([, commits]) => commits >= COCHANGE_MIN_SHARED)
      .sort(
        ([a, ca], [b, cb]) =>
          cb - ca || comparePaths(pathOf.get(a) ?? "", pathOf.get(b) ?? ""),
      )
      .slice(0, COCHANGE_TOP)
      .sort(([a], [b]) => a - b);
    for (const [partner, commits] of kept) {
      rows.push({ file_id: file, partner_file_id: partner, commits });
    }
  }
  return rows;
}

// 26 rows, oldest first: week k = 0..25 starts at t - (26 - k) weeks and counts the commits in
// (week_start, week_start + 1 week]. A merge or an empty commit counts too.
function timelineOf(history: History, t: number): TimelineRow[] {
  const counts = new Array<number>(TIMELINE_WEEKS).fill(0);
  for (const commit of history.commits) {
    const k = TIMELINE_WEEKS - 1 - Math.floor((t - commit.time) / WEEK_SECONDS);
    if (k < 0 || k >= TIMELINE_WEEKS) continue;
    counts[k] = (counts[k] as number) + 1;
  }
  return counts.map((commits, k) => ({
    week_start: t - (TIMELINE_WEEKS - k) * WEEK_SECONDS,
    commits,
  }));
}

// The renames of the commits in (t - 180 days, t], in (old path, new path, commit) order, each
// once.
function renamesOf(history: History, t: number): RenameRow[] {
  const found: RenameRow[] = [];
  for (const commit of history.commits) {
    if (!inWindow(commit.time, t, COCHANGE_SECONDS)) continue;
    for (const { from, to } of commit.renames) {
      found.push({ old_path: from, new_path: to, commit_sha: commit.sha });
    }
  }
  found.sort(
    (a, b) =>
      comparePaths(a.old_path, b.old_path) ||
      comparePaths(a.new_path, b.new_path) ||
      comparePaths(a.commit_sha, b.commit_sha),
  );
  return found.filter((r, k) => {
    const last = found[k - 1];
    return (
      last === undefined ||
      last.old_path !== r.old_path ||
      last.new_path !== r.new_path ||
      last.commit_sha !== r.commit_sha
    );
  });
}
