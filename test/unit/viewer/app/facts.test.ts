// What the details say about a node: a file's facts and the sub-line under its name, how each of
// its definitions is drawn and named, the tabs each kind of node has, and the counts the lists
// beside a file give, one thing in the singular.
import { expect, it } from "vitest";
import {
  DEF_KINDS,
  ENTRY_KINDS,
  F,
  FILE_KINDS,
} from "../../../../src/query/view/constants.js";
import { mapData } from "../../../../src/query/view/index.js";
import type { MapData } from "../../../../src/query/view/types.js";
import { openStore } from "../../../../src/store/index.js";
import { HOTSPOT_MARK } from "../../../../src/viewer/app/constants.js";
import type { DataSource } from "../../../../src/viewer/app/data-types.js";
import {
  brightness,
  changesText,
  componentFiles,
  defRowText,
  dotClass,
  dotTitle,
  entryKinds,
  fileFacts,
  GLYPH,
  importersText,
  outlineFileOf,
  subLine,
  subLineOf,
  tabsFor,
} from "../../../../src/viewer/app/detail/facts.js";
import { buildModel, type Model } from "../../../../src/viewer/app/model.js";
import {
  createOutlineCache,
  type Outline,
} from "../../../../src/viewer/app/outline-cache.js";
import { tinyStore } from "../tiny-store.js";
import { tinyModel } from "./helpers.js";

// A data source that is never asked: the tiny map carries its outlines.
const none = () =>
  Promise.reject(new Error("the tiny map carries its outlines"));
const nullSource: DataSource = {
  kind: "http",
  map: none,
  outline: none,
  source: none,
  history: none,
  tool: none,
};

// The tiny store's files: 0 package.json (config), 1 src/cli/main.ts (an entry point, rank 3),
// 2 src/core/graph.test.ts (a test), 3 src/core/graph.ts (rank 1, in a cycle, hotspot 1) and 4
// src/core/util.ts (rank 2, in the cycle). Its definitions: 0 main, 1 Graph, 2 Graph.add, 3
// helper, 4 the second helper, 5 clamp.
const m = tinyModel();
const o3 = createOutlineCache(m, nullSource).peek(3);

// The tiny map, changed, as a model of its own.
const variant = (change: (map: MapData) => void): Model => {
  const map = structuredClone(m.map);
  change(map);
  return buildModel(map);
};

it("gathers a file's neighbours by rank", () => {
  expect(fileFacts(m, 3, o3)).toEqual({
    lines: 40,
    importedBy: [4, 1, 2],
    imports: [4],
    libraries: [0],
    cochange: [[2, 3]],
    definitions: 4,
    launchedBy: [],
  });
  expect(fileFacts(m, 1, null).launchedBy).toEqual([
    { manifest: 0, line: 4, kind: "bin", name: "tiny" },
  ]);
  expect(fileFacts(m, 3, null).cochange).toBeNull();
});

it("the sub-line names rank, entry, cycle and hotspot", () => {
  expect([
    subLine(m, 3),
    subLine(m, 1),
    subLine(m, 4),
    subLine(m, 2),
    subLine(m, 0),
  ]).toEqual([
    "#1 of 3 by dependents \u00b7 in an import cycle \u00b7 hotspot",
    "#3 of 3 by dependents \u00b7 entry point",
    "#2 of 3 by dependents \u00b7 in an import cycle",
    "test",
    "config",
  ]);
});

it("a dot's class and title say the same thing", () => {
  expect([dotClass(m, 2, true), dotTitle(m, 2, true)]).toEqual([
    "used method",
    "Graph.add \u00b7 method \u00b7 line 9 \u00b7 used by 1 file",
  ]);
  expect([dotClass(m, 5, false), dotTitle(m, 5, false)]).toEqual([
    "exp untested",
    "clamp \u00b7 function \u00b7 line 2 \u00b7 exported, unused \u00b7 no test mentions it",
  ]);
  expect([dotClass(m, 3, false), dotTitle(m, 3, false)]).toEqual([
    "untested",
    "helper \u00b7 function \u00b7 line 30 \u00b7 internal \u00b7 no test mentions it",
  ]);
});

it("definition rows say in words what the dot's colour and ring say", () => {
  expect([
    defRowText(m, 2, false),
    defRowText(m, 5, false),
    defRowText(m, 3, true),
  ]).toEqual([
    "m  Graph.add \u00b7 1 user \u00b7 line 9 \u00b7 no test mentions it",
    "\u0192  clamp \u00b7 exported, unused \u00b7 line 2 \u00b7 no test mentions it",
    "\u0192  helper \u00b7 internal \u00b7 line 30",
  ]);
});

it("a file's facts are copies, so whoever reads them cannot change the model", () => {
  const facts = fileFacts(m, 3, o3);
  facts.importedBy.push(0);
  facts.imports.push(0);
  facts.libraries.push(1);
  facts.cochange?.push([1, 1]);
  expect(fileFacts(m, 3, o3)).toMatchObject({
    importedBy: [4, 1, 2],
    imports: [4],
    libraries: [0],
    cochange: [[2, 3]],
  });
  // a file that nothing imports gets a list of its own, not the model's shared empty one
  expect(() => fileFacts(m, 1, null).importedBy.push(4)).not.toThrow();
  expect(m.importers[1]).toEqual([]);
});

it("orders the files that change together by shared commits, then by path", () => {
  const outline: Outline = {
    endLine: [],
    tested: [],
    cochange: [
      [4, 1],
      [2, 3],
      [1, 3],
    ],
  };
  expect(fileFacts(m, 3, outline).cochange).toEqual([
    [1, 3],
    [2, 3],
    [4, 1],
  ]);
});

it("a file whose outline is fetched on demand has no partners until it is loaded, and still counts its definitions", () => {
  const store = openStore(tinyStore());
  if ("code" in store) throw new Error(store.reason);
  // its 3 production files are over a limit of 2: the map carries no outline
  const fetched = buildModel(
    mapData(store, { stale: false, snippets: true, inlineUpTo: 2 }),
  );
  store.close();
  const outlines = createOutlineCache(fetched, nullSource);
  expect(outlines.peek(3)).toBeNull();
  expect(fileFacts(fetched, 3, outlines.peek(3))).toMatchObject({
    lines: 40,
    cochange: null,
    definitions: 4,
  });
});

it("lists every entry point that launches a file, in the map's order, whatever its kind", () => {
  const v = variant((map) => {
    map.entries.push(
      [1, ENTRY_KINDS.indexOf("dev-script"), 0, 7, "dev", -1],
      [1, ENTRY_KINDS.indexOf("unit"), 0, 9, "tiny.service", -1],
    );
  });
  expect(fileFacts(v, 1, null).launchedBy).toEqual([
    { manifest: 0, line: 4, kind: "bin", name: "tiny" },
    { manifest: 0, line: 7, kind: "dev-script", name: "dev" },
    { manifest: 0, line: 9, kind: "unit", name: "tiny.service" },
  ]);
  // what an entry point's file is, as the component's list names it: dev scripts left out, each
  // kind once
  expect(entryKinds(v, 1)).toEqual(["bin", "unit"]);
  expect([entryKinds(m, 1), entryKinds(m, 3)]).toEqual([["bin"], []]);
});

it("the sub-line names each kind of file outside the code", () => {
  const doc = variant((map) => {
    map.files[0][F.kind] = FILE_KINDS.indexOf("doc");
    map.files[2][F.kind] = FILE_KINDS.indexOf("test-support");
  });
  const other = variant((map) => {
    map.files[0][F.kind] = FILE_KINDS.indexOf("other");
  });
  expect([subLine(doc, 0), subLine(doc, 2), subLine(other, 0)]).toEqual([
    "doc",
    "test support",
    "other",
  ]);
});

it("the sub-line names a hotspot only above the mark, and every mark in its order", () => {
  const at = (hotspot: number) =>
    subLine(
      variant((map) => {
        map.files[4][F.hotspot] = hotspot;
      }),
      4,
    );
  expect([at(HOTSPOT_MARK), at(0.36)]).toEqual([
    "#2 of 3 by dependents \u00b7 in an import cycle",
    "#2 of 3 by dependents \u00b7 in an import cycle \u00b7 hotspot",
  ]);
  const all = variant((map) => {
    map.files[1][F.cycle] = 1;
    map.files[1][F.hotspot] = 0.9;
  });
  expect(subLine(all, 1)).toBe(
    "#3 of 3 by dependents \u00b7 entry point \u00b7 in an import cycle \u00b7 hotspot",
  );
});

it("a dot names a definition used by many files, and a method nothing uses", () => {
  expect([dotClass(m, 1, true), dotTitle(m, 1, true)]).toEqual([
    "used",
    "Graph \u00b7 class \u00b7 line 5 \u00b7 used by 1 file",
  ]);
  const v = variant((map) => {
    map.defs.usedBy[1] = 2;
    map.defs.exported[2] = 0;
    map.defs.usedBy[2] = 0;
  });
  expect([dotClass(v, 1, true), dotTitle(v, 1, true)]).toEqual([
    "used",
    "Graph \u00b7 class \u00b7 line 5 \u00b7 used by 2 files",
  ]);
  expect([dotClass(v, 2, false), dotTitle(v, 2, false)]).toEqual([
    "method untested",
    "Graph.add \u00b7 method \u00b7 line 9 \u00b7 internal \u00b7 no test mentions it",
  ]);
  expect(dotClass(v, 2, true)).toBe("method");
});

it("a definition row counts one user in the singular, and says nothing of tests when one mentions it", () => {
  expect([
    defRowText(m, 1, true),
    defRowText(m, 2, true),
    defRowText(m, 3, false),
  ]).toEqual([
    "C  Graph \u00b7 1 user \u00b7 line 5",
    "m  Graph.add \u00b7 1 user \u00b7 line 9",
    "\u0192  helper \u00b7 internal \u00b7 line 30 \u00b7 no test mentions it",
  ]);
  const v = variant((map) => {
    map.defs.kind[5] = DEF_KINDS.indexOf("constant");
    map.defs.kind[0] = DEF_KINDS.indexOf("type");
  });
  expect([defRowText(v, 5, true), defRowText(v, 0, true)]).toEqual([
    "K  clamp \u00b7 exported, unused \u00b7 line 2",
    "T  main \u00b7 exported, unused \u00b7 line 3",
  ]);
});

it("each kind of definition has its glyph", () => {
  expect(GLYPH).toEqual({
    function: "\u0192",
    class: "C",
    method: "m",
    constant: "K",
    type: "T",
  });
  expect(Object.isFrozen(GLYPH)).toBe(true);
});

it("the lists beside a file count its importers and its changes, one in the singular", () => {
  expect([
    importersText(m, 3),
    importersText(m, 4),
    importersText(m, 1),
  ]).toEqual(["3 importers", "1 importer", "0 importers"]);
  expect([changesText(m, 3), changesText(m, 1), changesText(m, 4)]).toEqual([
    "4 changes",
    "1 change",
    "0 changes",
  ]);
});

it("files and definitions have four tabs, components and libraries two, and a group none", () => {
  const four = ["overview", "inside", "source", "agent"];
  expect(tabsFor({ kind: "file", file: 3 })).toEqual(four);
  expect(tabsFor({ kind: "definition", file: 3, def: 1 })).toEqual(four);
  expect(tabsFor({ kind: "component", component: 1 })).toEqual([
    "overview",
    "agent",
  ]);
  expect(tabsFor({ kind: "library", external: 1 })).toEqual([
    "overview",
    "agent",
  ]);
  expect([tabsFor({ kind: "group", key: "src" }), tabsFor(null)]).toEqual([
    [],
    [],
  ]);
});

it("the details show the outline of a selected file, or of a definition's file, and no other", () => {
  expect([
    outlineFileOf({ kind: "file", file: 3 }),
    outlineFileOf({ kind: "definition", file: 4, def: 5 }),
    outlineFileOf({ kind: "component", component: 1 }),
    outlineFileOf({ kind: "library", external: 0 }),
    outlineFileOf({ kind: "group", key: "src" }),
    outlineFileOf(null),
  ]).toEqual([3, 4, -1, -1, -1, -1]);
});

it("a definition, a component and a library each have a sub-line, and a group none", () => {
  expect(subLineOf(m, { kind: "file", file: 1 })).toBe(subLine(m, 1));
  expect(subLineOf(m, { kind: "definition", file: 3, def: 1 })).toBe(
    subLine(m, 3),
  );
  expect([
    subLineOf(m, { kind: "component", component: 1 }),
    subLineOf(m, { kind: "component", component: 0 }),
  ]).toEqual([
    "2 code files \u00b7 1 test \u00b7 75 lines",
    "1 code file \u00b7 0 tests \u00b7 12 lines",
  ]);
  expect(subLineOf(m, { kind: "library", external: 1 })).toBe(
    "imported by 1 file",
  );
  expect(subLineOf(m, { kind: "group", key: "src" })).toBe("");
});

it("a component's code files come by rank, each as bright as the Structure lens draws it", () => {
  expect([componentFiles(m, 1), componentFiles(m, 0)]).toEqual([[3, 4], [1]]);
  const v = variant((map) => {
    map.files[4][F.pagerank] = 0.03;
    map.files[1][F.pagerank] = 0.005;
  });
  expect([brightness(v, 3), brightness(v, 4), brightness(v, 1)]).toEqual([
    "hi",
    "mid",
    "",
  ]);
});
