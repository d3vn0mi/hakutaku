// code_overview: the map of a repo, or of one component (docs/tools.md). Each answer is built
// as one literal in the contract's key order, which JSON.stringify keeps.
import {
  comparePaths,
  type EntryKind,
  formatId,
  type Id,
  viewOf,
} from "../model/index.js";
import type { Store } from "../store/index.js";
import { CORE_SHARE, HOTSPOT_MARK, INLINE_CAPS } from "../tools/limits.js";
import type {
  Checked,
  OverviewComponentAnswer,
  OverviewRepoAnswer,
} from "../tools/types.js";
import { fail, ok, type QueryCtx, type QueryOut } from "./ctx.js";
import { resolveTarget, wrongKind } from "./resolve.js";
import {
  type ComponentInfo,
  type FileInfo,
  type StoreIndex,
  storeIndex,
} from "./store-index.js";

export function queryOverview(
  store: Store,
  args: Checked<"code_overview">,
  q: QueryCtx,
): QueryOut<OverviewRepoAnswer | OverviewComponentAnswer> {
  const ix = storeIndex(store);
  if (args.component === undefined) return ok(repoAnswer(store, ix, q));
  const target = resolveTarget(store, q.repo, args.component, "component");
  if ("code" in target) return fail(target);
  const refuse = (hint: string) =>
    fail(wrongKind("component", target, "code_overview", "a component", hint));
  switch (target.kind) {
    case "directory":
      return ok(componentAnswer(ix, target.componentId, q));
    case "file":
    case "definition":
      return refuse("code_explain explains files and definitions");
    case "repo":
      return refuse("code_overview without component describes the repo");
    case "external":
      return refuse("code_references lists a library's importers");
  }
}

function componentAnswer(
  ix: StoreIndex,
  componentId: number,
  q: QueryCtx,
): OverviewComponentAnswer {
  const component = ix.components.get(componentId);
  if (component === undefined) {
    throw new RangeError(`the store has no component ${componentId}`);
  }
  const caps = INLINE_CAPS.component;
  const files = [...ix.files.values()]
    .filter((f) => f.componentId === componentId)
    .sort(ix.compareFiles);
  return {
    id: ix.idOfComponent(componentId),
    kind: "component",
    builtCommit: q.builtCommit,
    stale: q.stale,
    files: component.files,
    tests: component.tests,
    core: files
      .filter((f) => f.production)
      .slice(0, caps.core)
      .map((f) => ({ id: ix.idOfFile(f.id), importedBy: f.fanIn })),
    entryPoints: files
      .filter((f) => f.entry)
      .slice(0, caps.entryPoints)
      .map((f) => ix.idOfFile(f.id)),
    view: viewOf({ kind: "directory", repo: ix.repo, path: component.path }),
  };
}

// A file with its dependents rank, as every core file has.
type Ranked = FileInfo & { readonly rank: number };

const isRanked = (f: FileInfo): f is Ranked => f.rank !== null;

// What the repo answer counts per component.
interface ComponentTally {
  best: number | null; // the best rank of its files
  coreFiles: number;
  entryPoints: number;
}

function repoAnswer(
  store: Store,
  ix: StoreIndex,
  q: QueryCtx,
): OverviewRepoAnswer {
  const caps = INLINE_CAPS.repo;
  let files = 0;
  let tests = 0;
  let lines = 0;
  const languages = new Map<string, number>();
  const core: Ranked[] = [];
  const hot: FileInfo[] = [];
  const tally = new Map<number, ComponentTally>();
  for (const f of ix.files.values()) {
    if (!f.production && !f.test) continue;
    if (f.production) files += 1;
    else tests += 1;
    lines += f.lines;
    if (f.lang !== null)
      languages.set(f.lang, (languages.get(f.lang) ?? 0) + 1);
    if (f.production && f.core && isRanked(f)) core.push(f);
    if (f.production && f.hotspot !== null && f.hotspot >= HOTSPOT_MARK) {
      hot.push(f);
    }
    if (f.componentId !== null) {
      const t = tally.get(f.componentId) ?? {
        best: null,
        coreFiles: 0,
        entryPoints: 0,
      };
      if (f.rank !== null && (t.best === null || f.rank < t.best)) {
        t.best = f.rank;
      }
      if (f.core) t.coreFiles += 1;
      if (f.entry) t.entryPoints += 1;
      tally.set(f.componentId, t);
    }
  }
  core.sort(ix.compareFiles);
  hot.sort(
    (a, b) =>
      (b.hotspot ?? 0) - (a.hotspot ?? 0) || comparePaths(a.path, b.path),
  );
  const components = [...ix.components.values()].map((component) => ({
    component,
    tally: tally.get(component.id) ?? {
      best: null,
      coreFiles: 0,
      entryPoints: 0,
    },
  }));
  components.sort(
    (a, b) =>
      nullsLast(a.tally.best, b.tally.best) ||
      comparePaths(a.component.path, b.component.path),
  );
  const dependsOn = componentImports(ix);
  const entryPoints = entryPointRows(store, ix);
  return {
    id: formatId({ kind: "repo", repo: ix.repo }),
    kind: "repo",
    builtCommit: q.builtCommit,
    stale: q.stale,
    files,
    tests,
    lines,
    languages: Object.fromEntries(
      [...languages].sort(([a], [b]) => comparePaths(a, b)),
    ),
    coreSet: {
      files: core.length,
      ofFiles: files,
      share: CORE_SHARE,
      top: core.slice(0, caps.coreSet).map((f) => ({
        id: ix.idOfFile(f.id),
        dependentsRank: f.rank,
        importedBy: f.fanIn,
      })),
    },
    components: {
      total: components.length,
      top: components.slice(0, caps.components).map(({ component, tally }) => ({
        id: ix.idOfComponent(component.id),
        files: component.files,
        tests: component.tests,
        coreFiles: tally.coreFiles,
        entryPoints: tally.entryPoints,
      })),
    },
    dependsOn: {
      total: dependsOn.length,
      top: dependsOn.slice(0, caps.dependsOn).map((d) => ({
        from: ix.idOfComponent(d.from.id),
        to: ix.idOfComponent(d.to.id),
        imports: d.imports,
      })),
    },
    entryPoints: {
      total: entryPoints.length,
      top: entryPoints.slice(0, caps.entryPoints).map((row) => ({
        id:
          row.def_id === null
            ? ix.idOfFile(row.file_id)
            : ix.idOfDef(row.def_id),
        kind: row.kind,
        via: ix.idOfFile(row.manifest_file_id),
        line: row.manifest_line,
      })),
    },
    hotspots: {
      total: hot.length,
      top: hot.slice(0, caps.hotspots).map((f) => ({
        id: ix.idOfFile(f.id),
        hotspot: f.hotspot ?? 0,
        commits90d: f.churn,
      })),
    },
    cycles: cyclesOf(store, ix, caps.cycles),
    view: "#",
  };
}

// Ascending, with null after every number.
function nullsLast(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

// The resolved imports from a production file in one component to a production file in
// another, counted per pair of components: by count descending, then the from and to paths.
function componentImports(
  ix: StoreIndex,
): Array<{ from: ComponentInfo; to: ComponentInfo; imports: number }> {
  const pairs = new Map<
    string,
    { from: ComponentInfo; to: ComponentInfo; imports: number }
  >();
  for (const edges of ix.importsOut.values()) {
    for (const edge of edges) {
      if (edge.dstFile === null) continue;
      const src = ix.files.get(edge.src);
      const dst = ix.files.get(edge.dstFile);
      if (!src?.production || !dst?.production) continue;
      if (src.componentId === null || dst.componentId === null) continue;
      if (src.componentId === dst.componentId) continue;
      const key = `${src.componentId}>${dst.componentId}`;
      const pair = pairs.get(key);
      if (pair !== undefined) {
        pair.imports += 1;
        continue;
      }
      const from = ix.components.get(src.componentId);
      const to = ix.components.get(dst.componentId);
      if (from === undefined || to === undefined) {
        throw new RangeError(`the store has no component ${key}`);
      }
      pairs.set(key, { from, to, imports: 1 });
    }
  }
  return [...pairs.values()].sort(
    (a, b) =>
      b.imports - a.imports ||
      comparePaths(a.from.path, b.from.path) ||
      comparePaths(a.to.path, b.to.path),
  );
}

interface EntryPointRow {
  file_id: number;
  def_id: number | null;
  kind: EntryKind;
  manifest_file_id: number;
  manifest_line: number;
}

// The entry points other than dev scripts, by their file's rank and path, then kind, then
// manifest line; rows that tie keep the store's row order.
function entryPointRows(store: Store, ix: StoreIndex): EntryPointRow[] {
  const rows = store.db
    .prepare(
      "SELECT file_id, def_id, kind, manifest_file_id, manifest_line FROM entry_points WHERE kind <> 'dev-script' ORDER BY file_id, kind, manifest_file_id, manifest_line, name",
    )
    .all() as unknown as EntryPointRow[];
  return rows
    .map((row) => ({ row, file: fileAt(ix, row.file_id) }))
    .sort(
      (a, b) =>
        ix.compareFiles(a.file, b.file) ||
        comparePaths(a.row.kind, b.row.kind) ||
        a.row.manifest_line - b.row.manifest_line,
    )
    .map(({ row }) => row);
}

interface CycleRow {
  cycle_id: number;
  file_id: number;
}

// The number of cycles, and the first cap of them by cycle_id, each as the file IDs of its
// stored chain in ord order.
function cyclesOf(
  store: Store,
  ix: StoreIndex,
  cap: number,
): { total: number; top: Id[][] } {
  const rows = store.db
    .prepare("SELECT cycle_id, file_id FROM cycles ORDER BY cycle_id, ord")
    .all() as unknown as CycleRow[];
  const top: Id[][] = [];
  let total = 0;
  let last: number | null = null;
  for (const row of rows) {
    if (row.cycle_id !== last) {
      last = row.cycle_id;
      total += 1;
      if (total <= cap) top.push([]);
    }
    if (total <= cap) top.at(-1)?.push(ix.idOfFile(row.file_id));
  }
  return { total, top };
}

function fileAt(ix: StoreIndex, fileId: number): FileInfo {
  const file = ix.files.get(fileId);
  if (file === undefined)
    throw new RangeError(`the store has no file ${fileId}`);
  return file;
}
