// Which import curves the map draws: every visible one within the budget, else the core view's;
// only the selection's when there is one, its libraries' included; cycles marked; and the
// imports between groups added up for the hubs.
import { beforeAll, expect, it } from "vitest";
import { IMPORT_KINDS } from "../../../../src/query/view/constants.js";
import {
  aggregateCurves,
  type CurvePick,
  controlPoint,
  pickCurves,
} from "../../../../src/viewer/app/map/curves.js";
import { buildModel, type Model } from "../../../../src/viewer/app/model.js";
import { bestOf, tinyModel } from "./helpers.js";
import { syntheticMap } from "./synthetic-map.js";

let m: Model;
beforeAll(() => {
  m = tinyModel();
});

// every file visible; the core view holds main.ts and graph.ts
const view = (o: object = {}) => ({
  visible: () => true,
  inCore: (f: number) => f === 1 || f === 3,
  selected: null,
  riskLens: false,
  ...o,
});
const pairs = (c: CurvePick[]) => c.map((x) => [x.from, x.to, x.kind]);

it("draws every visible curve within the budget", () => {
  expect(pairs(pickCurves(m, view()))).toEqual([
    [1, 3, "base"],
    [2, 3, "base"],
    [3, 4, "base"],
    [4, 3, "base"],
  ]);
});

it("marks the cycle's curves under the Risk lens", () => {
  expect(pairs(pickCurves(m, view({ riskLens: true })))).toEqual([
    [1, 3, "base"],
    [2, 3, "base"],
    [3, 4, "cycle"],
    [4, 3, "cycle"],
  ]);
});

it("draws every visible curve while they number exactly the budget", () => {
  expect(pairs(pickCurves(m, view(), 4))).toHaveLength(4);
});

it("keeps only core curves over the budget", () => {
  expect(pairs(pickCurves(m, view(), 1))).toEqual([[1, 3, "base"]]);
  // one end in the core view is not enough
  expect(pairs(pickCurves(m, view(), 3))).toEqual([[1, 3, "base"]]);
});

it("truncates the core curves to the budget too", () => {
  expect(pairs(pickCurves(m, view({ inCore: () => true }), 2))).toEqual([
    [1, 3, "base"],
    [2, 3, "base"],
  ]);
});

it("draws only the selection's curves, cycle edges marked", () => {
  expect(pairs(pickCurves(m, view({ selected: 4 })))).toEqual([
    [3, 4, "cycle"],
    [4, 3, "cycle"],
  ]);
});

it("never draws a curve to a file that is not visible", () => {
  const visible = (f: number) => f !== 2;
  expect(pairs(pickCurves(m, view({ visible })))).toEqual([
    [1, 3, "base"],
    [3, 4, "base"],
    [4, 3, "base"],
  ]);
  expect(pairs(pickCurves(m, view({ visible, selected: 3 })))).toEqual([
    [1, 3, "selected"],
    [3, 4, "cycle"],
    [4, 3, "cycle"],
    [3, 5, "selected"],
  ]);
});

it("never draws more curves than the budget, a selection's included", () => {
  // graph.ts has four import curves and one library curve
  expect(pairs(pickCurves(m, view({ selected: 3 }), 2))).toEqual([
    [1, 3, "selected"],
    [2, 3, "selected"],
  ]);
});

it("draws nothing for a selection that is not visible", () => {
  expect(
    pickCurves(m, view({ selected: 3, visible: (f: number) => f !== 3 })),
  ).toEqual([]);
});

it("draws library curves only for a selection, each to files.length + the library", () => {
  // graph.ts imports fs, library 0, so its curve ends at 5 + 0
  expect(pairs(pickCurves(m, view({ selected: 3 })))).toEqual([
    [1, 3, "selected"],
    [2, 3, "selected"],
    [3, 4, "cycle"],
    [4, 3, "cycle"],
    [3, 5, "selected"],
  ]);
  expect(pickCurves(m, view()).every((c) => c.to < m.map.files.length)).toBe(
    true,
  );
});

it("marks no curve as a cycle when its every import is type-only", () => {
  const map = tinyModel().map;
  const typeOnly = IMPORT_KINDS.indexOf("type-only");
  // util.ts imports graph.ts as a type only; graph.ts imports util.ts both ways
  map.imports = [1, 3, 0, 2, 3, 0, 3, 4, 0, 4, 3, typeOnly, 3, 4, typeOnly];
  const t = buildModel(map);
  expect(pairs(pickCurves(t, view({ riskLens: true })))).toEqual([
    [1, 3, "base"],
    [2, 3, "base"],
    [3, 4, "cycle"],
    [4, 3, "base"],
  ]);
  expect(pairs(pickCurves(t, view({ selected: 4 })))).toEqual([
    [3, 4, "cycle"],
    [4, 3, "selected"],
  ]);
});

it("joins the selection to its visible co-change partners", () => {
  const cochange: Array<[number, number]> = [[3, 2]];
  expect(
    pairs(pickCurves(m, view({ selected: 3, cochange }))).filter(
      ([, , kind]) => kind === "cochange",
    ),
  ).toEqual([[3, 2, "cochange"]]);
  expect(
    pickCurves(
      m,
      view({ selected: 3, cochange, visible: (f: number) => f !== 2 }),
    ).filter((c) => c.kind === "cochange"),
  ).toEqual([]);
});

it("aggregates imports across groups", () => {
  const hubs = ["src/cli", "src/core"];
  expect(aggregateCurves(m, "component", (k) => hubs.indexOf(k))).toEqual([
    { from: 0, to: 1, kind: "aggregate", weight: 1 },
  ]);
});

it("aggregates nothing within one group, or to a group without a hub", () => {
  expect(aggregateCurves(m, "folder", () => 0)).toEqual([]); // every file is under src
  expect(aggregateCurves(m, "language", () => 0)).toEqual([]);
  const hubs = ["src/core"];
  expect(aggregateCurves(m, "component", (k) => hubs.indexOf(k))).toEqual([]);
});

it("weighs an aggregate curve by the imports it carries", () => {
  // syntheticMap(40): file i in src/c<i % 20> imports file (7i + 3) mod 40
  const s = buildModel(syntheticMap(40));
  const keys = s.map.components.map(([path]) => path);
  // hubs numbered against the components' order, so that the hubs a walk of the imports meets
  // first are the last by number
  const curves = aggregateCurves(
    s,
    "component",
    (k) => keys.length - 1 - keys.indexOf(k),
  );
  expect(curves.reduce((n, c) => n + c.weight, 0)).toBe(40);
  expect(curves.every((c) => c.kind === "aggregate" && c.from !== c.to)).toBe(
    true,
  );
  const ordered = curves.map((c) => [c.from, c.to]);
  expect(ordered).toEqual(
    [...ordered].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
  );
});

it("pulls the control point toward the centre", () => {
  expect(controlPoint(100, 0, 0, 100, 0.22)).toEqual([11, 11]);
});

it("picks the curves of a 20,000-file map within 50 ms", () => {
  // 22,000 visible curves, all in the core view, so the budget cuts them to 15,000
  const s = buildModel(syntheticMap(20000, { tests: 2000, libraries: 200 }));
  const all = view({ inCore: () => true });
  expect(bestOf(5, () => pickCurves(s, all))).toBeLessThan(50);
  expect(pickCurves(s, all)).toHaveLength(15000);
});
