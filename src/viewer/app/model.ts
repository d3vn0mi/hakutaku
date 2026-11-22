// The page's model of a map: the indexes that the map, its panels and its lenses read, built
// once when the map arrives. No DOM here: Node tests import it.
import { comparePaths } from "../../model/order.js";
import { F, FILE_KINDS } from "../../query/view/constants.js";
import type { MapData, MapFile } from "../../query/view/types.js";
import type { Grouping } from "./state.js";

const CODE = FILE_KINDS.indexOf("code");
const TEST = FILE_KINDS.indexOf("test");
const TEST_SUPPORT = FILE_KINDS.indexOf("test-support");

// The names the language grouping shows; any other language shows under its own name.
const LANGUAGE_NAMES: ReadonlyMap<string, string> = new Map([
  ["typescript", "TypeScript"],
  ["javascript", "JavaScript"],
  ["python", "Python"],
  ["shell", "Shell"],
]);

export interface Model {
  map: MapData;
  production: number[]; // the files of kind code, by rank
  tests: number[]; // the test and test-support files, by path
  onMap(file: number): boolean; // production, test or test-support
  importers: number[][]; // per file, the files that import it, each once, by rank
  imports: number[][]; // per file, the files it imports, each once, by rank
  libsOf: number[][]; // per file, the libraries it imports, each once, in externals order
  importersOfLib: number[][]; // per library, the files that import it, each once, by rank
  defsOf: Array<[start: number, end: number]>; // each file's slice of map.defs
  byPath: ReadonlyMap<string, number>;
  maxPagerank: number; // the maxima over production files; 0 when there is none
  maxHotspot: number;
  maxChurn: number;
}

// Rank 1 first, the files of rank 0 (all but production) last, then path order.
function compareRank(files: MapFile[], a: number, b: number): number {
  const ra = files[a][F.rank];
  const rb = files[b][F.rank];
  if (ra !== rb) return ra === 0 ? 1 : rb === 0 ? -1 : ra - rb;
  return comparePaths(files[a][F.path], files[b][F.path]);
}

export function byRank(model: Model, a: number, b: number): number {
  return compareRank(model.map.files, a, b);
}

export function buildModel(map: MapData): Model {
  const files = map.files;
  const n = files.length;
  // compareRank over flat arrays: a rank of 0 sorts last as +Infinity, and two of them, whose
  // difference is NaN, fall through to their paths.
  const rank = new Float64Array(n);
  const path: string[] = [];
  for (let f = 0; f < n; f++) {
    rank[f] =
      files[f][F.rank] === 0 ? Number.POSITIVE_INFINITY : files[f][F.rank];
    path.push(files[f][F.path]);
  }
  const cmp = (a: number, b: number) =>
    rank[a] - rank[b] || comparePaths(path[a], path[b]);

  // Every file's place in rank order: lists filled by walking the files in this order come out
  // sorted by rank, and the others are sorted by it.
  const order = Array.from({ length: n }, (_, f) => f).sort(cmp);
  const place = new Int32Array(n);
  for (let i = 0; i < n; i++) place[order[i]] = i;

  const production = order.filter((f) => files[f][F.kind] === CODE);
  const tests: number[] = [];
  const onMap = new Uint8Array(n);
  const byPath = new Map<string, number>();
  for (let f = 0; f < n; f++) {
    byPath.set(files[f][F.path], f);
    const kind = files[f][F.kind];
    if (kind === TEST || kind === TEST_SUPPORT) tests.push(f);
    onMap[f] = kind === CODE || kind === TEST || kind === TEST_SUPPORT ? 1 : 0;
  }
  tests.sort((a, b) => comparePaths(files[a][F.path], files[b][F.path]));

  const imports = lists(n);
  for (let i = 0; i < map.imports.length; i += 3) {
    add(imports, map.imports[i], map.imports[i + 1]);
  }
  for (let f = 0; f < n; f++) imports[f] = once(imports[f], place);
  const importers = lists(n);
  for (const src of order)
    for (const dst of imports[src]) add(importers, dst, src);

  const libsOf = lists(n);
  for (let i = 0; i < map.libImports.length; i += 2) {
    add(libsOf, map.libImports[i], map.libImports[i + 1]);
  }
  const libOrder = new Int32Array(map.externals.length).map((_, e) => e);
  for (let f = 0; f < n; f++) libsOf[f] = once(libsOf[f], libOrder);
  const importersOfLib = lists(map.externals.length);
  for (const src of order)
    for (const e of libsOf[src]) add(importersOfLib, e, src);

  // map.defs is in store order, which holds each file's definitions together, file by file.
  const defsOf: Array<[number, number]> = [];
  for (let f = 0, at = 0; f < n; f++) {
    const start = at;
    while (at < map.defs.file.length && map.defs.file[at] === f) at++;
    defsOf.push([start, at]);
  }

  let maxPagerank = 0;
  let maxHotspot = 0;
  let maxChurn = 0;
  for (const f of production) {
    maxPagerank = Math.max(maxPagerank, files[f][F.pagerank]);
    maxHotspot = Math.max(maxHotspot, files[f][F.hotspot]);
    maxChurn = Math.max(maxChurn, files[f][F.churn]);
  }

  return {
    map,
    production,
    tests,
    onMap: (file) => onMap[file] === 1,
    importers,
    imports,
    libsOf,
    importersOfLib,
    defsOf,
    byPath,
    maxPagerank,
    maxHotspot,
    maxChurn,
  };
}

// Most files import no library, and many import or are imported by no file, so every empty
// list is this one, frozen: the model is read, never written.
const NONE = Object.freeze([]) as readonly number[] as number[];

// n lists, each empty.
const lists = (n: number): number[][] => new Array<number[]>(n).fill(NONE);

// Adds item to the list at index i.
function add(of: number[][], i: number, item: number): void {
  if (of[i] === NONE) of[i] = [item];
  else of[i].push(item);
}

// The items of list, each once, sorted by their place.
function once(list: number[], place: ArrayLike<number>): number[] {
  if (list.length < 2) return list;
  list.sort((a, b) => place[a] - place[b]);
  let kept = 1;
  for (let i = 1; i < list.length; i++) {
    if (list[i] !== list[kept - 1]) list[kept++] = list[i];
  }
  list.length = kept;
  return list;
}

// The key a grouping puts a file under: its component's path, or "(none)" without one; the
// first segment of its path, or "(root)" for a file at the top; or its language's name, or
// "(none)" for a file with no language.
export function groupKey(model: Model, file: number, g: Grouping): string {
  const f = model.map.files[file];
  if (g === "component") {
    const c = f[F.component];
    return c < 0 ? "(none)" : model.map.components[c][0];
  }
  if (g === "folder") {
    const path = f[F.path];
    const slash = path.indexOf("/");
    return slash < 0 ? "(root)" : path.slice(0, slash);
  }
  const lang = f[F.lang] < 0 ? undefined : model.map.langs[f[F.lang]];
  return lang === undefined ? "(none)" : (LANGUAGE_NAMES.get(lang) ?? lang);
}
