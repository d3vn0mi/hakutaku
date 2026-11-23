// Find: one index over the map's files, definitions and libraries. Exact matches come first, then
// prefixes, then substrings, each class ranked by importance, and the search keeps only the best
// few as it goes. A pick opens a file or a library on its Overview, a definition on its Source.
import { expect, it } from "vitest";
import { DEF_KINDS, ECOSYSTEMS } from "../../../../src/query/view/constants.js";
import type { MapData } from "../../../../src/query/view/types.js";
import { FIND_MAX } from "../../../../src/viewer/app/constants.js";
import {
  buildFindIndex,
  type FindHit,
  pickOf,
} from "../../../../src/viewer/app/find/index.js";
import { buildModel } from "../../../../src/viewer/app/model.js";
import { bestOf, tinyModel } from "./helpers.js";
import { syntheticMap } from "./synthetic-map.js";

const SEP = " \u00b7 ";
const m = tinyModel();
const idx = buildFindIndex(m);

it("puts exact matches before prefix matches before substrings", () => {
  expect(idx.search("graph").map((h) => [h.label, h.match])).toEqual([
    [`Graph${SEP}graph.ts`, "exact"],
    ["src/core/graph.ts", "prefix"],
    [`Graph.add${SEP}graph.ts`, "prefix"],
    ["src/core/graph.test.ts", "prefix"],
  ]);
});

it("finds libraries by name and by ecosystem", () => {
  expect(idx.search("kleur")[0]).toMatchObject({
    kind: "library",
    ref: 1,
    match: "exact",
  });
  expect(idx.search("npm:kl")[0]).toMatchObject({
    kind: "library",
    ref: 1,
    match: "prefix",
  });
});

it("matches substrings of paths", () => {
  expect(idx.search("re/gra")[0]).toMatchObject({
    kind: "file",
    ref: 3,
    match: "substring",
  });
});

it("ignores case and surrounding space, and an empty query finds nothing", () => {
  expect(idx.search("  CLAMP ")[0]).toMatchObject({
    kind: "function",
    ref: 5,
    match: "exact",
  });
  expect(idx.search("")).toEqual([]);
  expect(idx.search(" \t ")).toEqual([]);
});

it("caps the hits", () => {
  expect(idx.search("s", 2)).toHaveLength(2);
  expect(idx.search("s", 0)).toEqual([]);
  expect(idx.search("s", -1)).toEqual([]);
  // FIND_MAX by default
  const many = buildFindIndex(buildModel(syntheticMap(300)));
  expect(many.search("f")).toHaveLength(FIND_MAX);
});

it("searches 100,000 items within 50 ms", () => {
  const big = buildFindIndex(
    buildModel(syntheticMap(20000, { defsPerFile: 4 })),
  );
  expect(big.size).toBeGreaterThanOrEqual(100_000);
  for (const q of ["f1", "e", "fn19999_3", "lib"])
    expect(bestOf(5, () => big.search(q))).toBeLessThan(50);
});

it("indexes every file, definition and library once, each with its kind and label", () => {
  expect(idx.size).toBe(5 + 6 + 2);
  // each item is an exact match for its whole key, and the only match
  expect(idx.search("package.json")).toEqual([
    { kind: "file", ref: 0, label: "package.json", match: "exact" },
  ]);
  expect(idx.search("src/core/graph.test.ts")).toEqual([
    {
      kind: "test-file",
      ref: 2,
      label: "src/core/graph.test.ts",
      match: "exact",
    },
  ]);
  expect(idx.search("Graph.add")).toEqual([
    {
      kind: "method",
      ref: 2,
      label: `Graph.add${SEP}graph.ts`,
      match: "exact",
    },
  ]);
  expect(idx.search("node:fs")).toEqual([
    { kind: "library", ref: 0, label: "node:fs", match: "exact" },
  ]);
  expect(idx.search("main")[0]).toEqual({
    kind: "function",
    ref: 0,
    label: `main${SEP}main.ts`,
    match: "exact",
  });
  // a definition's last name is a key of its own
  expect(idx.search("add")).toEqual([
    {
      kind: "method",
      ref: 2,
      label: `Graph.add${SEP}graph.ts`,
      match: "exact",
    },
  ]);
});

it("names each kind of definition, tells overloads apart by their line, and breaks a tie by place in the map", () => {
  const map = structuredClone(m.map);
  map.defs.kind[3] = DEF_KINDS.indexOf("constant");
  map.defs.kind[4] = DEF_KINDS.indexOf("type");
  const kinds = buildFindIndex(buildModel(map));
  // helper and helper(2) share their name and their weight: each row says its line, and the
  // first in the map comes first
  expect(kinds.search("helper")).toEqual([
    {
      kind: "constant",
      ref: 3,
      label: `helper (line 30)${SEP}graph.ts`,
      match: "exact",
    },
    {
      kind: "type",
      ref: 4,
      label: `helper (line 35)${SEP}graph.ts`,
      match: "exact",
    },
  ]);
  expect(kinds.search("Graph")[0].kind).toBe("class");
  // still by place in the map, not by the labels' text, which would put line 35 before line 9
  map.defs.line[3] = 9;
  expect(
    buildFindIndex(buildModel(map))
      .search("helper")
      .map((hit) => hit.label),
  ).toEqual([
    `helper (line 9)${SEP}graph.ts`,
    `helper (line 35)${SEP}graph.ts`,
  ]);
});

it("ranks production files by pagerank, above libraries, tests and other files", () => {
  // the four paths under src/ start with "s"; the library and package.json only hold one
  expect(idx.search("s", 20).map((h) => [h.label, h.match])).toEqual([
    ["src/core/graph.ts", "prefix"],
    ["src/core/util.ts", "prefix"],
    ["src/cli/main.ts", "prefix"],
    ["src/core/graph.test.ts", "prefix"],
    ["node:fs", "substring"],
    ["package.json", "substring"],
  ]);
  // every item that holds an "e" holds it inside: one class, ranked by weight alone, from the
  // production files (2 and 1.6) through definitions (0.6) and libraries (0.55, so by label) to
  // the test file (0.2) and the config file (0.1)
  expect(idx.search("e", 20).map((h) => h.label)).toEqual([
    "src/core/graph.ts",
    "src/core/util.ts",
    `helper (line 30)${SEP}graph.ts`,
    `helper (line 35)${SEP}graph.ts`,
    "node:fs",
    "npm:kleur",
    "src/core/graph.test.ts",
    "package.json",
  ]);
  expect(new Set(idx.search("e", 20).map((h) => h.match))).toEqual(
    new Set(["substring"]),
  );
});

it("ranks definitions by the files that use them, ten at most, and by being exported", () => {
  const map = syntheticMap(2, { defsPerFile: 4 });
  map.defs.usedBy = [0, 15, 10, 3, 0, 0, 0, 0];
  map.defs.exported = [1, 0, 1, 1, 1, 1, 1, 1];
  // weights 0.8, 1.6 (15 counts as 10), 1.8 and 1.1
  expect(
    buildFindIndex(buildModel(map))
      .search("fn0_")
      .map((h) => h.ref),
  ).toEqual([2, 1, 3, 0]);
});

it("ranks libraries by the files that import them, ten at most", () => {
  const map = syntheticMap(4, { libraries: 4 });
  map.externals = map.externals.map(
    ([e, name], j): [number, string, number] => [e, name, [3, 25, 10, 12][j]],
  );
  // lib1, lib2 and lib3 all weigh 1, so their labels order them
  expect(
    buildFindIndex(buildModel(map))
      .search("lib")
      .map((h) => h.label),
  ).toEqual(["npm:lib1", "npm:lib2", "npm:lib3", "npm:lib0"]);
});

it("ranks files that carry no pagerank by label, and an empty map finds nothing", () => {
  const map = syntheticMap(3);
  for (const f of map.files) f[6] = 0;
  map.files.reverse();
  expect(
    buildFindIndex(buildModel(map))
      .search("f")
      .map((h) => h.label),
  ).toEqual(["src/c0/f0.ts", "src/c1/f1.ts", "src/c2/f2.ts"]);
  const empty = buildFindIndex(buildModel(syntheticMap(0)));
  expect(empty.size).toBe(0);
  expect(empty.search("f")).toEqual([]);
});

// What matches a query, by the rules alone: each item's keys, lower-cased; exact when a key is
// the query, prefix when one starts with it, substring when the longer key holds it.
function matchesOf(map: MapData, query: string): Map<string, FindHit["match"]> {
  const q = query.trim().toLowerCase();
  const out = new Map<string, FindHit["match"]>();
  const add = (item: string, short: string, long: string) => {
    const [s, l] = [short.toLowerCase(), long.toLowerCase()];
    if (s === q || l === q) out.set(item, "exact");
    else if (s.startsWith(q) || l.startsWith(q)) out.set(item, "prefix");
    else if (l.includes(q)) out.set(item, "substring");
  };
  map.files.forEach(([path], f) => {
    add(`file ${f}`, path.slice(path.lastIndexOf("/") + 1), path);
  });
  map.defs.name.forEach((name, d) => {
    add(`def ${d}`, name.slice(name.lastIndexOf(".") + 1), name);
  });
  map.externals.forEach(([e, name], x) => {
    add(`library ${x}`, name, `${ECOSYSTEMS[e]}:${name}`);
  });
  return out;
}

const itemOf = (h: FindHit) =>
  `${h.kind === "file" || h.kind === "test-file" ? "file" : h.kind === "library" ? "library" : "def"} ${h.ref}`;
const CLASS = { exact: 0, prefix: 1, substring: 2 };

it("finds every match the rules name, in class order, and keeps the same best few at any cap", () => {
  const map = syntheticMap(300, { tests: 40, defsPerFile: 3, libraries: 7 });
  const model = buildModel(map);
  const index = buildFindIndex(model);
  for (const q of [
    "f",
    "FN1",
    "fn2",
    "c1",
    "c1/",
    "lib",
    ".test",
    "1_2",
    "_",
    "zz",
  ]) {
    const all = index.search(q, 1e9);
    const expected = matchesOf(map, q);
    expect(new Map(all.map((h) => [itemOf(h), h.match])), q).toEqual(expected);
    expect(all, q).toHaveLength(expected.size);
    for (let i = 1; i < all.length; i++)
      expect(CLASS[all[i - 1].match], q).toBeLessThanOrEqual(
        CLASS[all[i].match],
      );
    for (const cap of [1, 2, 5, FIND_MAX, 50, 1000])
      expect(index.search(q, cap), `${q} at ${cap}`).toEqual(all.slice(0, cap));
  }
});

it("a pick opens a file or a library on its Overview, and a definition on its Source, widened", () => {
  const hit = (kind: FindHit["kind"], ref: number): FindHit => ({
    kind,
    ref,
    label: "",
    match: "exact",
  });
  expect(pickOf(m, hit("file", 3))).toEqual({
    sel: { kind: "file", file: 3 },
    tab: "overview",
    widen: false,
  });
  expect(pickOf(m, hit("test-file", 2))).toEqual({
    sel: { kind: "file", file: 2 },
    tab: "overview",
    widen: false,
  });
  expect(pickOf(m, hit("method", 2))).toEqual({
    sel: { kind: "definition", file: 3, def: 2 },
    tab: "source",
    widen: true,
  });
  expect(pickOf(m, hit("function", 5))).toEqual({
    sel: { kind: "definition", file: 4, def: 5 },
    tab: "source",
    widen: true,
  });
  expect(pickOf(m, hit("library", 1))).toEqual({
    sel: { kind: "library", external: 1 },
    tab: "overview",
    widen: false,
  });
});
