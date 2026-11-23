// The page's model of a map: who imports whom, by rank, each file's definitions, the maxima the
// lenses scale by, and the key each grouping puts a file under.
import { expect, it } from "vitest";
import { F, FILE_KINDS, mapData } from "../../../../src/query/view/index.js";
import { openStore } from "../../../../src/store/index.js";
import {
  buildModel,
  byRank,
  defName,
  groupKey,
} from "../../../../src/viewer/app/model.js";
import type { Grouping } from "../../../../src/viewer/app/state.js";
import { emptyContent, miniStore } from "../../../helpers/mini-store.js";
import { bestOf, tinyModel } from "./helpers.js";
import { syntheticMap } from "./synthetic-map.js";

// The map of the store at p; the store is closed once it is read.
const mapOf = (p: string) => {
  const s = openStore(p);
  if ("code" in s) throw new Error(s.reason);
  try {
    return mapData(s, { stale: false, snippets: true });
  } finally {
    s.close();
  }
};

it("builds importers and imports by rank", () => {
  const m = tinyModel();
  expect([
    m.importers[3],
    m.imports[3],
    m.libsOf[1],
    m.importersOfLib[0],
  ]).toEqual([[4, 1, 2], [4], [1], [3]]);
  expect([m.production, m.tests]).toEqual([[3, 4, 1], [2]]);
});

it("slices each file's definitions", () => {
  const m = tinyModel();
  expect(m.defsOf[3]).toEqual([1, 5]);
  expect(m.defsOf[0][0]).toBe(m.defsOf[0][1]);
  expect(m.defsOf.map(([start, end]) => end - start)).toEqual([0, 1, 0, 4, 1]);
});

it("maxima are 0 on an empty map", () => {
  const m = buildModel(mapOf(miniStore(emptyContent("empty"))));
  expect([m.maxPagerank, m.maxHotspot, m.maxChurn]).toEqual([0, 0, 0]);
});

it("takes the maxima over production files only", () => {
  const map = tinyModel().map;
  map.files[2][F.churn] = 9; // the test file
  map.files[0][F.pagerank] = 0.9; // package.json
  map.files[0][F.hotspot] = 7;
  const m = buildModel(map);
  // graph.ts holds every maximum among production files
  expect([m.maxPagerank, m.maxHotspot, m.maxChurn]).toEqual([0.5, 1, 4]);
});

it("groups by component, folder and language", () => {
  const m = tinyModel();
  expect(
    ["component", "folder", "language"].map((g) =>
      groupKey(m, 1, g as Grouping),
    ),
  ).toEqual(["src/cli", "src", "TypeScript"]);
  expect(groupKey(m, 0, "component")).toBe("(none)");
});

it("puts a top-level file under (root), and a file with no language under (none)", () => {
  const m = tinyModel();
  expect([groupKey(m, 0, "folder"), groupKey(m, 0, "language")]).toEqual([
    "(root)",
    "(none)",
  ]);
});

it("names the four languages it knows, and any other by its own name", () => {
  const map = syntheticMap(5);
  map.langs = ["javascript", "python", "shell", "typescript", "go"];
  map.files.forEach((f, i) => {
    f[F.lang] = i;
  });
  const m = buildModel(map);
  expect([0, 1, 2, 3, 4].map((f) => groupKey(m, f, "language"))).toEqual([
    "JavaScript",
    "Python",
    "Shell",
    "TypeScript",
    "go",
  ]);
});

it("orders by rank, files off production last, then by path", () => {
  const m = tinyModel();
  // graph.ts, util.ts and main.ts by rank; then package.json and the test, of rank 0, by path
  expect([4, 2, 1, 0, 3].sort((a, b) => byRank(m, a, b))).toEqual([
    3, 4, 1, 0, 2,
  ]);
});

it("knows which files are on the map, and finds a file by its exact path", () => {
  const m = tinyModel();
  expect([0, 1, 2, 3, 4].map((f) => m.onMap(f))).toEqual([
    false,
    true,
    true,
    true,
    true,
  ]);
  expect([
    m.byPath.get("src/core/graph.ts"),
    m.byPath.get("package.json"),
    m.byPath.get("src/core/"),
  ]).toEqual([3, 0, undefined]);
});

it("counts a test-support file among the tests, on the map", () => {
  const map = syntheticMap(2, { tests: 2 });
  map.files[3][F.kind] = FILE_KINDS.indexOf("test-support");
  const m = buildModel(map);
  expect([m.tests, m.onMap(3)]).toEqual([[2, 3], true]);
});

it("lists each import once, however many times the store holds it", () => {
  const map = syntheticMap(3);
  // file 0 imports file 1 twice more: as a type and dynamically
  map.imports.push(0, 1, 2, 0, 1, 1);
  const m = buildModel(map);
  expect([m.imports[0], m.importers[1]]).toEqual([[1], [0]]);
});

it("names a definition by its qualified name, and one its file holds twice by its line too", () => {
  // the tiny map's definitions: main, Graph, Graph.add, helper at line 30, helper(2) at line
  // 35, clamp
  const m = tinyModel();
  expect([0, 1, 2, 3, 4, 5].map((d) => defName(m, d))).toEqual([
    "main",
    "Graph",
    "Graph.add",
    "helper (line 30)",
    "helper (line 35)",
    "clamp",
  ]);
  // two of one name on one line are told apart by the ordinal their IDs carry
  const map = structuredClone(m.map);
  map.defs.line[4] = 30;
  const same = buildModel(map);
  expect([defName(same, 3), defName(same, 4)]).toEqual([
    "helper (line 30)",
    "helper(2) (line 30)",
  ]);
  // a name shared with a definition of another file is no overload
  const other = structuredClone(m.map);
  other.defs.name[0] = "clamp";
  expect([0, 5].map((d) => defName(buildModel(other), d))).toEqual([
    "clamp",
    "clamp",
  ]);
});

it("builds a 20,000-file model within 50 ms", () => {
  const map = syntheticMap(20000, { defsPerFile: 5 });
  expect(bestOf(5, () => buildModel(map))).toBeLessThan(50);
});
