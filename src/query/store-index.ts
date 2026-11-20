// The store index: what the query functions look up in a store, read once per Store object
// (each table with one SELECT, in id order) and kept for as long as that Store is.
import {
  comparePaths,
  type DefKind,
  type Ecosystem,
  type FileKind,
  formatId,
  type GitMode,
  type Id,
  type ImportKind,
  type Lang,
  type RepoId,
} from "../model/index.js";
import type { Store } from "../store/index.js";

export interface FileInfo {
  readonly id: number;
  readonly path: string;
  readonly kind: FileKind;
  readonly lang: Lang | null;
  readonly componentId: number | null;
  readonly lines: number;
  readonly mode: GitMode;
  readonly entry: boolean;
  readonly hasSource: boolean;
  // The metrics. A file without a metrics row (one that is not code, a test or test support)
  // has rank, hotspot and cycleId null, counts 0, and core false.
  readonly rank: number | null; // dependents rank: 1 is the most depended-on production file
  readonly fanIn: number;
  readonly fanOut: number;
  readonly churn: number; // commits in the last 90 days
  readonly hotspot: number | null;
  readonly cycleId: number | null;
  readonly core: boolean;
  readonly production: boolean; // kind "code"
  readonly test: boolean; // kind "test" or "test-support"
}

export interface ComponentInfo {
  readonly id: number;
  readonly path: string; // ends with "/"
  readonly files: number;
  readonly tests: number;
  readonly lines: number;
}

export interface DefInfo {
  readonly id: number;
  readonly fileId: number;
  readonly qualname: string;
  readonly ordinal: number;
  readonly name: string;
  readonly kind: DefKind | "module";
  readonly startLine: number;
  readonly startCol: number;
  readonly endLine: number;
  readonly exported: boolean;
  readonly parentId: number | null;
  readonly usedByFiles: number;
  readonly usedByFilesBound: number;
  readonly mentionedByTests: boolean;
}

export interface ImportEdge {
  readonly id: number;
  readonly src: number;
  readonly dstFile: number | null;
  readonly dstExternal: number | null;
  readonly kind: ImportKind;
  readonly line: number;
  readonly specifier: string;
}

export interface ExternalInfo {
  readonly id: number;
  readonly ecosystem: Ecosystem;
  readonly name: string;
  readonly files: number;
}

export interface StoreIndex {
  readonly repo: RepoId;
  readonly files: ReadonlyMap<number, FileInfo>;
  readonly fileByPath: ReadonlyMap<string, FileInfo>;
  readonly components: ReadonlyMap<number, ComponentInfo>;
  readonly componentByPath: ReadonlyMap<string, ComponentInfo>;
  readonly defs: ReadonlyMap<number, DefInfo>;
  // Each file's definitions in file order, its module row included. A file with none has no entry.
  readonly defsByFile: ReadonlyMap<number, readonly DefInfo[]>;
  // Keyed by DefInfo.name, in id order; module rows are left out.
  readonly defsByName: ReadonlyMap<string, readonly DefInfo[]>;
  readonly externals: ReadonlyMap<number, ExternalInfo>;
  // Every import row of a file, by line.
  readonly importsOut: ReadonlyMap<number, readonly ImportEdge[]>;
  // The rows that import a repo file, keyed by that file, in id order.
  readonly importsIn: ReadonlyMap<number, readonly ImportEdge[]>;
  // The ID of a row of the store; a RangeError for an id it does not hold.
  idOfFile(fileId: number): Id;
  idOfDef(defId: number): Id;
  idOfExternal(externalId: number): Id;
  idOfComponent(componentId: number): Id;
  // By rank: rank ascending with nulls last, then comparePaths.
  compareFiles(a: FileInfo, b: FileInfo): number;
}

// The columns each SELECT reads, with the types the store's writer guarantees.
interface FileRow {
  id: number;
  path: string;
  lang: Lang | null;
  kind: FileKind;
  component_id: number | null;
  lines: number;
  mode: GitMode;
  entry: number;
  has_source: number;
}
interface FileMetricRow {
  file_id: number;
  dependents_rank: number | null;
  fan_in: number;
  fan_out: number;
  churn_90d: number;
  hotspot: number | null;
  cycle_id: number | null;
  core: number;
}
interface ComponentRow {
  id: number;
  path: string;
  files: number;
  tests: number;
  lines: number;
}
interface DefinitionRow {
  id: number;
  file_id: number;
  qualname: string;
  ordinal: number;
  name: string;
  kind: DefKind | "module";
  start_line: number;
  start_col: number;
  end_line: number;
  exported: number;
  parent_id: number | null;
}
interface DefMetricRow {
  def_id: number;
  used_by_files: number;
  used_by_files_bound: number;
  mentioned_by_tests: number;
}
interface ExternalRow {
  id: number;
  ecosystem: Ecosystem;
  name: string;
  files: number;
}
interface ImportRow {
  id: number;
  src_file_id: number;
  dst_file_id: number | null;
  dst_external_id: number | null;
  kind: ImportKind;
  line: number;
  specifier: string;
}

const INDEXES = new WeakMap<Store, StoreIndex>();

export function storeIndex(store: Store): StoreIndex {
  let index = INDEXES.get(store);
  if (index === undefined) {
    index = buildIndex(store);
    INDEXES.set(store, index);
  }
  return index;
}

function compareFiles(a: FileInfo, b: FileInfo): number {
  if (a.rank !== b.rank) {
    if (a.rank === null) return 1;
    if (b.rank === null) return -1;
    return a.rank - b.rank;
  }
  return comparePaths(a.path, b.path);
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function buildIndex(store: Store): StoreIndex {
  const repo = store.meta.repoId;
  const all = <R>(sql: string): R[] =>
    store.db.prepare(sql).all() as unknown as R[];

  const metrics = new Map<number, FileMetricRow>();
  for (const row of all<FileMetricRow>(
    "SELECT file_id, dependents_rank, fan_in, fan_out, churn_90d, hotspot, cycle_id, core FROM file_metrics ORDER BY file_id",
  )) {
    metrics.set(row.file_id, row);
  }
  const files = new Map<number, FileInfo>();
  const fileByPath = new Map<string, FileInfo>();
  for (const row of all<FileRow>(
    "SELECT id, path, lang, kind, component_id, lines, mode, entry, has_source FROM files ORDER BY id",
  )) {
    const m = metrics.get(row.id);
    const info: FileInfo = {
      id: row.id,
      path: row.path,
      kind: row.kind,
      lang: row.lang,
      componentId: row.component_id,
      lines: row.lines,
      mode: row.mode,
      entry: row.entry !== 0,
      hasSource: row.has_source !== 0,
      rank: m?.dependents_rank ?? null,
      fanIn: m?.fan_in ?? 0,
      fanOut: m?.fan_out ?? 0,
      churn: m?.churn_90d ?? 0,
      hotspot: m?.hotspot ?? null,
      cycleId: m?.cycle_id ?? null,
      core: m !== undefined && m.core !== 0,
      production: row.kind === "code",
      test: row.kind === "test" || row.kind === "test-support",
    };
    files.set(info.id, info);
    fileByPath.set(info.path, info);
  }

  const components = new Map<number, ComponentInfo>();
  const componentByPath = new Map<string, ComponentInfo>();
  for (const row of all<ComponentRow>(
    "SELECT id, path, files, tests, lines FROM components ORDER BY id",
  )) {
    const info: ComponentInfo = {
      id: row.id,
      path: row.path,
      files: row.files,
      tests: row.tests,
      lines: row.lines,
    };
    components.set(info.id, info);
    componentByPath.set(info.path, info);
  }

  const defMetrics = new Map<number, DefMetricRow>();
  for (const row of all<DefMetricRow>(
    "SELECT def_id, used_by_files, used_by_files_bound, mentioned_by_tests FROM def_metrics ORDER BY def_id",
  )) {
    defMetrics.set(row.def_id, row);
  }
  const defs = new Map<number, DefInfo>();
  const defsByFile = new Map<number, DefInfo[]>();
  const defsByName = new Map<string, DefInfo[]>();
  for (const row of all<DefinitionRow>(
    "SELECT id, file_id, qualname, ordinal, name, kind, start_line, start_col, end_line, exported, parent_id FROM definitions ORDER BY id",
  )) {
    const m = defMetrics.get(row.id);
    const info: DefInfo = {
      id: row.id,
      fileId: row.file_id,
      qualname: row.qualname,
      ordinal: row.ordinal,
      name: row.name,
      kind: row.kind,
      startLine: row.start_line,
      startCol: row.start_col,
      endLine: row.end_line,
      exported: row.exported !== 0,
      parentId: row.parent_id,
      usedByFiles: m?.used_by_files ?? 0,
      usedByFilesBound: m?.used_by_files_bound ?? 0,
      mentionedByTests: m !== undefined && m.mentioned_by_tests !== 0,
    };
    defs.set(info.id, info);
    push(defsByFile, info.fileId, info);
    if (info.kind !== "module") push(defsByName, info.name, info);
  }

  const externals = new Map<number, ExternalInfo>();
  for (const row of all<ExternalRow>(
    "SELECT id, ecosystem, name, files FROM externals ORDER BY id",
  )) {
    externals.set(row.id, { ...row });
  }

  const importsOut = new Map<number, ImportEdge[]>();
  const importsIn = new Map<number, ImportEdge[]>();
  for (const row of all<ImportRow>(
    "SELECT id, src_file_id, dst_file_id, dst_external_id, kind, line, specifier FROM imports ORDER BY id",
  )) {
    const edge: ImportEdge = {
      id: row.id,
      src: row.src_file_id,
      dstFile: row.dst_file_id,
      dstExternal: row.dst_external_id,
      kind: row.kind,
      line: row.line,
      specifier: row.specifier,
    };
    push(importsOut, edge.src, edge);
    if (edge.dstFile !== null) push(importsIn, edge.dstFile, edge);
  }

  const known = <T>(
    map: ReadonlyMap<number, T>,
    id: number,
    what: string,
  ): T => {
    const value = map.get(id);
    if (value === undefined)
      throw new RangeError(`the store has no ${what} ${id}`);
    return value;
  };
  return Object.freeze({
    repo,
    files,
    fileByPath,
    components,
    componentByPath,
    defs,
    defsByFile,
    defsByName,
    externals,
    importsOut,
    importsIn,
    idOfFile: (fileId: number): Id =>
      formatId({ kind: "file", repo, path: known(files, fileId, "file").path }),
    idOfDef: (defId: number): Id => {
      const def = known(defs, defId, "definition");
      return formatId({
        kind: "definition",
        repo,
        path: known(files, def.fileId, "file").path,
        qualname: def.qualname,
        ordinal: def.ordinal,
      });
    },
    idOfExternal: (externalId: number): Id => {
      const external = known(externals, externalId, "external");
      return formatId({
        kind: "external",
        repo,
        ecosystem: external.ecosystem,
        name: external.name,
      });
    },
    idOfComponent: (componentId: number): Id =>
      formatId({
        kind: "directory",
        repo,
        path: known(components, componentId, "component").path,
      }),
    compareFiles,
  });
}
