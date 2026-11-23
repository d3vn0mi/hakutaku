// Filters and the list view's order: each filter keeps the files it names and every set filter
// must hold; the list holds the production files by rank, then, when tests are shown, the test
// files by path, under the filters; and each row's label reads well aloud.
import { describe, expect, it } from "vitest";
import { F, FILE_KINDS } from "../../../../src/query/view/constants.js";
import {
  languageCounts,
  listFiles,
  listLabel,
  passes,
} from "../../../../src/viewer/app/filters.js";
import { buildModel } from "../../../../src/viewer/app/model.js";
import { type Filters, NO_FILTERS } from "../../../../src/viewer/app/state.js";
import { bestOf, tinyModel } from "./helpers.js";
import { syntheticMap } from "./synthetic-map.js";

// The tiny store's files: 0 package.json (config, off the map), 1 src/cli/main.ts (an entry
// point, rank 3, changed 10 days ago, hotspot 0.1), 2 src/core/graph.test.ts (a test, changed 3
// days ago), 3 src/core/graph.ts (rank 1, in a cycle, changed 1 day ago, hotspot 1) and 4
// src/core/util.ts (rank 2, in the cycle, changed 120 days ago, hotspot 0).
const m = tinyModel();
const kept = (f: Partial<Filters>) =>
  [1, 2, 3, 4].filter((i) => passes(m, i, { ...NO_FILTERS, ...f }));

describe("passes", () => {
  it("each filter keeps what it names", () => {
    expect(kept({ lang: 0 })).toEqual([1, 2, 3, 4]);
    expect([kept({ component: 0 }), kept({ component: 1 })]).toEqual([
      [1],
      [2, 3, 4],
    ]);
    expect([kept({ entriesOnly: true }), kept({ inCycle: true })]).toEqual([
      [1],
      [3, 4],
    ]);
    expect([
      kept({ changedWithin: 7 }),
      kept({ changedWithin: 30 }),
      kept({ changedWithin: 90 }),
    ]).toEqual([
      [2, 3],
      [1, 2, 3],
      [1, 2, 3],
    ]);
    expect(kept({ hotspotAbove: 0.35 })).toEqual([3]);
  });

  it("no filter passes every file on the map", () => {
    expect(kept({})).toEqual([1, 2, 3, 4]);
  });

  it("every filter that is set must hold", () => {
    expect(
      kept({ component: 1, inCycle: true, changedWithin: 7, lang: 0 }),
    ).toEqual([3]);
    expect(kept({ entriesOnly: true, inCycle: true })).toEqual([]);
    // a language no file has keeps nothing
    expect(kept({ lang: 1 })).toEqual([]);
  });

  it("the language and component filters keep that one, and no other", () => {
    // files 0 to 2 in Python, 3 to 5 in TypeScript, 6 to 8 in Shell; component i % 20 each
    const map = syntheticMap(9);
    map.langs = ["python", "typescript", "shell"];
    map.files.forEach((file, i) => {
      file[F.lang] = Math.floor(i / 3);
    });
    const s = buildModel(map);
    const where = (f: Partial<Filters>) =>
      s.production
        .filter((i) => passes(s, i, { ...NO_FILTERS, ...f }))
        .sort((a, b) => a - b);
    expect([
      where({ lang: 0 }),
      where({ lang: 1 }),
      where({ lang: 2 }),
    ]).toEqual([
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
    ]);
    expect([where({ component: 0 }), where({ component: 4 })]).toEqual([
      [0],
      [4],
    ]);
  });

  it("a hotspot must be above the threshold, and a change below the days", () => {
    expect(m.map.files[1][F.hotspot]).toBe(0.1);
    expect(kept({ hotspotAbove: 0.1 })).toEqual([3]);
    expect(kept({ hotspotAbove: 0.05 })).toEqual([1, 3]);
    expect(kept({ hotspotAbove: 0 })).toEqual([1, 3]);
    expect(kept({ hotspotAbove: 1 })).toEqual([]);
    // main.ts changed 10 days ago: within 30 days, not within 7
    expect(m.map.files[1][F.changedDaysAgo]).toBe(10);
    expect(passes(m, 1, { ...NO_FILTERS, changedWithin: 30 })).toBe(true);
    expect(passes(m, 1, { ...NO_FILTERS, changedWithin: 7 })).toBe(false);
  });

  it("a file that never changed, or whose change reads as later than the build, changed in no window", () => {
    // package.json has no history: -1
    expect(m.map.files[0][F.changedDaysAgo]).toBe(-1);
    expect(passes(m, 0, NO_FILTERS)).toBe(true);
    expect(passes(m, 0, { ...NO_FILTERS, changedWithin: 90 })).toBe(false);
    // a committer clock behind the build's gives a negative number of days, never a recent change
    const skewed = syntheticMap(3);
    skewed.files[0][F.changedDaysAgo] = -3;
    skewed.files[1][F.changedDaysAgo] = 0;
    skewed.files[2][F.changedDaysAgo] = 7;
    const s = buildModel(skewed);
    expect(
      [0, 1, 2].filter((i) =>
        passes(s, i, { ...NO_FILTERS, changedWithin: 7 }),
      ),
    ).toEqual([1]);
  });
});

describe("listFiles", () => {
  it("the list ranks production first, then tests, under the filters", () => {
    expect([
      listFiles(m, NO_FILTERS, true),
      listFiles(m, NO_FILTERS, false),
      listFiles(m, { ...NO_FILTERS, inCycle: true }, true),
    ]).toEqual([
      [3, 4, 1, 2],
      [3, 4, 1],
      [3, 4],
    ]);
  });

  it("filters tests too, and lists none when nothing passes", () => {
    expect(listFiles(m, { ...NO_FILTERS, changedWithin: 7 }, true)).toEqual([
      3, 2,
    ]);
    expect(listFiles(m, { ...NO_FILTERS, changedWithin: 7 }, false)).toEqual([
      3,
    ]);
    expect(listFiles(m, { ...NO_FILTERS, hotspotAbove: 1 }, true)).toEqual([]);
  });

  it("lists the tests by path after the production files by rank", () => {
    // tests 0 to 4 of a 30-file map are src/c<j>/f<j>.test.ts: by path, f0 to f4
    const s = buildModel(syntheticMap(30, { tests: 5 }));
    const list = listFiles(s, NO_FILTERS, true);
    expect(list.slice(0, 30)).toEqual(s.production);
    expect(list.slice(30).map((f) => s.map.files[f][F.path])).toEqual([
      "src/c0/f0.test.ts",
      "src/c1/f1.test.ts",
      "src/c2/f2.test.ts",
      "src/c3/f3.test.ts",
      "src/c4/f4.test.ts",
    ]);
  });

  it("lists a 20,000-file map within 25 ms", () => {
    const s = buildModel(syntheticMap(20000, { tests: 2000 }));
    const f: Filters = { ...NO_FILTERS, component: 3 };
    expect(listFiles(s, f, true)).toHaveLength(1100);
    expect(bestOf(5, () => listFiles(s, f, true))).toBeLessThan(25);
  });
});

describe("listLabel", () => {
  it("list labels read well aloud", () => {
    expect([listLabel(m, 3), listLabel(m, 2)]).toEqual([
      "src/core/graph.ts, rank 1, 3 importers",
      "src/core/graph.test.ts, test",
    ]);
  });

  it("counts one importer in the singular, and none as none", () => {
    expect([listLabel(m, 4), listLabel(m, 1)]).toEqual([
      "src/core/util.ts, rank 2, 1 importer",
      "src/cli/main.ts, rank 3, 0 importers",
    ]);
  });

  it("calls a test-support file a test, as it does a test file", () => {
    const map = structuredClone(m.map);
    map.files[2][F.kind] = FILE_KINDS.indexOf("test-support");
    const s = buildModel(map);
    expect(s.tests).toEqual([2]);
    expect(listLabel(s, 2)).toBe("src/core/graph.test.ts, test");
  });

  it("names a file off the map by its path alone", () => {
    expect(listLabel(m, 0)).toBe("package.json");
  });
});

describe("languageCounts", () => {
  it("counts each language's code files, in the map's order", () => {
    expect(m.map.langs).toEqual(["typescript"]);
    expect(languageCounts(m)).toEqual([3]);
    // a 40-file map whose second half is retyped to another language, with its tests left out
    const map = syntheticMap(40, { tests: 6 });
    map.langs = ["python", "typescript"];
    map.files.forEach((file, i) => {
      file[F.lang] = i >= 20 && i < 40 ? 0 : 1;
    });
    expect(languageCounts(buildModel(map))).toEqual([20, 20]);
  });
});
