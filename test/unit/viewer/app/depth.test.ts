// Depth levels: the production files Core depth draws, the depth a map opens at, the order D steps
// through, the coverage line the stat band shows at Core depth, and which files each depth draws.
import { describe, expect, it } from "vitest";
import {
  F,
  FLAG_CORE,
  FLAG_ENTRY,
} from "../../../../src/query/view/constants.js";
import {
  coreView,
  coverageLine,
  DEPTHS,
  defaultDepth,
  fileShownAt,
  nextDepth,
  testsShownNowhere,
  WHY_NO_TESTS,
} from "../../../../src/viewer/app/depth.js";
import { buildModel } from "../../../../src/viewer/app/model.js";
import type { Depth } from "../../../../src/viewer/app/state.js";
import { tinyModel } from "./helpers.js";
import { syntheticMap } from "./synthetic-map.js";

const sorted = (set: ReadonlySet<number>) => [...set].sort((a, b) => a - b);
const upTo = (n: number) => Array.from({ length: n }, (_, i) => i);
const TAIL = "carry at least half of what the code depends on";

describe("coreView", () => {
  it("the core view holds the core set, entry points, hotspots above 0.35 and each component's top file", () => {
    expect([...coreView(tinyModel())].sort()).toEqual([1, 3]);
  });

  it("adds each kind of production file on its own", () => {
    // file i of 200 sits in component i % 20 with rank i + 1, so files 0 to 19 are both the core
    // set and their components' top files
    const map = syntheticMap(200, { tests: 4 });
    map.files[7][F.flags] &= ~FLAG_CORE; // out of the core set, still component 7's top file
    map.files[150][F.flags] |= FLAG_CORE; // in the core set, and no component's top file
    map.files[100][F.flags] |= FLAG_ENTRY; // an entry point
    map.files[101][F.hotspot] = 0.36; // a hotspot above the mark
    map.files[102][F.hotspot] = 0.35; // a hotspot at the mark, which is not above it
    const test = 200; // the first test file: never production, so never in the core view
    map.files[test][F.flags] |= FLAG_CORE | FLAG_ENTRY;
    map.files[test][F.hotspot] = 0.9;
    expect(sorted(coreView(buildModel(map)))).toEqual([
      ...upTo(20),
      100,
      101,
      150,
    ]);
  });

  it("takes a component's top file by rank, whatever the order of the files in the map", () => {
    // component 5 holds files 5, 25, 45, ...: with their ranks swapped, file 25 is its top
    const map = syntheticMap(200);
    map.files[5][F.rank] = 26;
    map.files[25][F.rank] = 6;
    map.files[5][F.flags] &= ~FLAG_CORE;
    expect(sorted(coreView(buildModel(map)))).toEqual([
      ...upTo(20).filter((f) => f !== 5),
      25,
    ]);
  });

  it("counts the files without a component as one more component, as the store's core set does", () => {
    const map = syntheticMap(200);
    for (const f of [180, 190]) map.files[f][F.component] = -1;
    expect(sorted(coreView(buildModel(map)))).toEqual([...upTo(20), 180]);
  });

  it("on a map whose one component holds every file, is the core set and that component's top file", () => {
    const map = syntheticMap(30);
    for (const file of map.files) file[F.component] = 0;
    map.files[0][F.flags] &= ~FLAG_CORE; // the top file, out of the core set
    expect(sorted(coreView(buildModel(map)))).toEqual([0, 1, 2]);
    expect(coverageLine(map)).toBe(`3 of 30 production files (10%) ${TAIL}`);
  });

  it("is empty on a map with no production files, and worked out once per model", () => {
    expect(coreView(buildModel(syntheticMap(0, { tests: 3 }))).size).toBe(0);
    const m = tinyModel();
    expect(coreView(m)).toBe(coreView(m));
  });
});

describe("defaultDepth and nextDepth", () => {
  it("the default depth is Core above 400 production files", () => {
    expect([
      defaultDepth(buildModel(syntheticMap(401))),
      defaultDepth(buildModel(syntheticMap(400))),
    ]).toEqual(["core", "files"]);
    // tests are not production files
    expect(defaultDepth(buildModel(syntheticMap(0, { tests: 500 })))).toBe(
      "files",
    );
  });

  it("D cycles Components, Core and Files", () => {
    expect([
      nextDepth("files"),
      nextDepth("components"),
      nextDepth("core"),
    ]).toEqual(["components", "core", "files"]);
    expect(DEPTHS).toEqual(["components", "core", "files"]);
  });
});

describe("coverageLine", () => {
  it("states the coverage over production files", () => {
    expect(coverageLine(tinyModel().map)).toBe(
      "2 of 3 production files (67%) carry at least half of what the code depends on",
    );
    expect(coverageLine(syntheticMap(0))).toBe(
      "No production files on this map.",
    );
  });

  it("rounds the share to a whole percent, and writes numbers as en-US does", () => {
    const line = (files: number, ofFiles: number) =>
      coverageLine({ ...syntheticMap(1), coreSet: { files, ofFiles } });
    expect(line(1, 3)).toBe(`1 of 3 production files (33%) ${TAIL}`);
    expect(line(1, 8)).toBe(`1 of 8 production files (13%) ${TAIL}`);
    expect(line(5, 5)).toBe(`5 of 5 production files (100%) ${TAIL}`);
    expect(coverageLine(syntheticMap(20000))).toBe(
      `2,000 of 20,000 production files (10%) ${TAIL}`,
    );
  });
});

describe("fileShownAt", () => {
  it("Files draws every file of the map, Core only the core view's, Components none", () => {
    // the tiny map: 0 package.json (config), 1 main.ts, 2 graph.test.ts, 3 graph.ts, 4 util.ts
    const m = tinyModel();
    const shown = (d: Depth) => upTo(5).filter((f) => fileShownAt(m, d, f));
    expect(DEPTHS.map(shown)).toEqual([[], [1, 3], [1, 2, 3, 4]]);
  });
});

describe("testsShownNowhere", () => {
  it("is true at Core and Components depth with no list open, where nothing draws or lists tests", () => {
    const at = (depth: Depth, listOpen: boolean) =>
      testsShownNowhere({ depth, listOpen });
    expect(DEPTHS.map((d) => at(d, false))).toEqual([true, true, false]);
    // the list view, over the map or in its place, lists tests at every depth
    expect(DEPTHS.map((d) => at(d, true))).toEqual([false, false, false]);
    expect(WHY_NO_TESTS).toBe("The map shows tests at Files depth only.");
  });
});
