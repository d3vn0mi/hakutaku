// The galaxy layout: production files on a disc by rank, in their group's sector; tests, hubs and
// libraries on rings outside it; and the same picture every time.
import { expect, it } from "vitest";
import { comparePaths } from "../../../../src/model/order.js";
import { F } from "../../../../src/query/view/constants.js";
import {
  HUB_RING,
  LIB_RING,
  R,
  TEST_RING,
  TEST_SPREAD,
  TWIST,
} from "../../../../src/viewer/app/constants.js";
import {
  type GalaxyLayout,
  galaxyLayout,
} from "../../../../src/viewer/app/map/layout.js";
import { buildModel, groupKey } from "../../../../src/viewer/app/model.js";
import { bestOf, tinyModel } from "./helpers.js";
import { syntheticMap } from "./synthetic-map.js";

const TAU = 2 * Math.PI;
const norm = (a: number) => ((a % TAU) + TAU) % TAU; // into [0, 2π)
const radius = (l: GalaxyLayout, f: number) =>
  Math.hypot(l.pos[2 * f], l.pos[2 * f + 1]);
const angle = (l: GalaxyLayout, f: number) =>
  Math.atan2(l.pos[2 * f + 1], l.pos[2 * f]);
const libAngle = (l: GalaxyLayout, e: number) =>
  Math.atan2(l.libs[2 * e + 1], l.libs[2 * e]);

function hubOf(l: GalaxyLayout, key: string) {
  const hub = l.hubs.find((h) => h.key === key);
  if (hub === undefined) throw new Error(`no hub ${key}`);
  return hub;
}

it("is deterministic", () => {
  const m = buildModel(syntheticMap(500, { tests: 50, libraries: 20 }));
  const a = galaxyLayout(m, "component");
  const b = galaxyLayout(m, "component");
  expect([Array.from(a.pos), a.hubs, Array.from(a.libs)]).toEqual([
    Array.from(b.pos),
    b.hubs,
    Array.from(b.libs),
  ]);
});

it("puts rank 1 nearest the centre", () => {
  const m = buildModel(syntheticMap(500));
  const l = galaxyLayout(m, "component");
  for (const f of m.production.slice(1))
    expect(radius(l, m.production[0])).toBeLessThan(radius(l, f));
});

it("keeps each production file inside its group's sector", () => {
  const m = buildModel(syntheticMap(2000));
  const l = galaxyLayout(m, "component");
  for (const f of m.production) {
    const hub = hubOf(l, groupKey(m, f, "component"));
    const r = radius(l, f);
    const a = norm(angle(l, f) - (TWIST * r) / R - hub.a0);
    expect(a).toBeGreaterThanOrEqual(hub.w * 0.1 - 1e-9);
    expect(a).toBeLessThanOrEqual(hub.w * 0.9 + 1e-9);
  }
});

it("places tests, hubs and libraries on their rings", () => {
  const m = buildModel(syntheticMap(300, { tests: 40, libraries: 12 }));
  const l = galaxyLayout(m, "component");
  for (const t of m.tests) {
    expect(radius(l, t)).toBeGreaterThanOrEqual(R + 46 - 1e-9);
    expect(radius(l, t)).toBeLessThanOrEqual(R + 116 + 1e-9);
  }
  for (const h of l.hubs) expect(Math.hypot(h.x, h.y)).toBeCloseTo(R + 175, 9);
  for (let j = 0; j < l.libs.length / 2; j++)
    expect(Math.hypot(l.libs[2 * j], l.libs[2 * j + 1])).toBeCloseTo(
      R + 330,
      9,
    );
});

it("orders groups of equal size by key", () => {
  const l = galaxyLayout(buildModel(syntheticMap(40)), "component"); // 20 components of 2 files each
  expect(l.hubs.map((h) => h.key)).toEqual(
    [...l.hubs.map((h) => h.key)].sort(comparePaths),
  );
});

it("sizes sectors by file count, laid end to end from the top, each hub at its middle", () => {
  const l = galaxyLayout(tinyModel(), "component");
  // src/core holds two of the three production files, src/cli one
  expect(l.hubs.map((h) => [h.key, h.files])).toEqual([
    ["src/core", 2],
    ["src/cli", 1],
  ]);
  const [core, cli] = l.hubs;
  expect(core.a0).toBe(-Math.PI / 2);
  expect(core.w).toBeCloseTo((TAU * 2) / 3, 12);
  expect(cli.a0).toBeCloseTo(-Math.PI / 2 + (TAU * 2) / 3, 12);
  expect(cli.w).toBeCloseTo(TAU / 3, 12);
  for (const h of l.hubs) {
    const mid = h.a0 + h.w / 2 + TWIST;
    expect(h.x).toBeCloseTo((R + HUB_RING) * Math.cos(mid), 9);
    expect(h.y).toBeCloseTo((R + HUB_RING) * Math.sin(mid), 9);
  }
});

it("gives a small group at least its minimum share of the circle", () => {
  const map = syntheticMap(1000);
  map.files.forEach((f, i) => {
    f[F.component] = i === 0 ? 1 : 0; // 999 files in src/c0, one in src/c1
  });
  const l = galaxyLayout(buildModel(map), "component");
  expect(l.hubs.map((h) => [h.key, h.files])).toEqual([
    ["src/c0", 999],
    ["src/c1", 1],
  ]);
  expect(l.hubs[1].w).toBeCloseTo((TAU * 0.012) / 1.011, 12);
  expect(l.hubs[0].w + l.hubs[1].w).toBeCloseTo(TAU, 12);
});

it("puts each test in its group's sector, or in the first one when its group has no production file", () => {
  // production files sit in src/c0 to src/c9; tests 10 to 14 sit in src/c10 to src/c14
  const m = buildModel(syntheticMap(10, { tests: 15 }));
  const l = galaxyLayout(m, "component");
  let first = 0;
  for (const t of m.tests) {
    const key = groupKey(m, t, "component");
    const hub = l.hubs.find((h) => h.key === key) ?? l.hubs[0];
    if (hub === l.hubs[0] && key !== l.hubs[0].key) first++;
    const a = norm(angle(l, t) - TWIST - hub.a0);
    expect(a).toBeGreaterThanOrEqual(hub.w * 0.06 - 1e-9);
    expect(a).toBeLessThanOrEqual(hub.w * 0.94 + 1e-9);
  }
  expect(first).toBe(5);
});

it("gives a file off the map no position", () => {
  const m = tinyModel();
  const l = galaxyLayout(m, "component");
  expect([l.pos[0], l.pos[1]]).toEqual([Number.NaN, Number.NaN]); // package.json
  for (const f of [1, 2, 3, 4])
    expect(Number.isFinite(radius(l, f))).toBe(true);
});

it("places each production file by its rank and its place in its group", () => {
  // graph.ts and util.ts, of ranks 1 and 2, are src/core's first and second; main.ts, of rank 3,
  // is src/cli's first
  const l = galaxyLayout(tinyModel(), "component");
  const [core, cli] = l.hubs;
  for (const [f, i, k, hub] of [
    [3, 0, 0, core],
    [4, 1, 1, core],
    [1, 2, 0, cli],
  ] as const) {
    const r = R * Math.sqrt((i + 0.5) / 3);
    const a =
      hub.a0 + hub.w * (0.1 + 0.8 * ((k * 0.618034) % 1)) + (TWIST * r) / R;
    expect(l.pos[2 * f]).toBeCloseTo(r * Math.cos(a), 9);
    expect(l.pos[2 * f + 1]).toBeCloseTo(r * Math.sin(a), 9);
  }
});

it("places each test on its ring by its place in path order", () => {
  const m = buildModel(syntheticMap(10, { tests: 15 }));
  const l = galaxyLayout(m, "component");
  m.tests.forEach((t, j) => {
    const key = groupKey(m, t, "component");
    const hub = l.hubs.find((h) => h.key === key) ?? l.hubs[0];
    const r = R + TEST_RING + TEST_SPREAD * ((j * 0.754877) % 1);
    const a = hub.a0 + hub.w * (0.06 + 0.88 * ((j * 0.381966) % 1)) + TWIST;
    expect(l.pos[2 * t]).toBeCloseTo(r * Math.cos(a), 9);
    expect(l.pos[2 * t + 1]).toBeCloseTo(r * Math.sin(a), 9);
  });
});

it("leaves a file off the map out of a library's preferred angle", () => {
  const map = tinyModel().map;
  const without = galaxyLayout(buildModel(map), "component");
  map.libImports.push(0, 1); // package.json, which has no position, imports kleur too
  const m = buildModel(map);
  expect(m.importersOfLib[1]).toEqual([1, 0]);
  expect(Array.from(galaxyLayout(m, "component").libs)).toEqual(
    Array.from(without.libs),
  );
});

it("puts a library on its own at the mean angle of the files that import it", () => {
  const m = buildModel(syntheticMap(40, { libraries: 1 }));
  const l = galaxyLayout(m, "component");
  let sx = 0;
  let sy = 0;
  for (const f of m.importersOfLib[0]) {
    sx += Math.cos(angle(l, f));
    sy += Math.sin(angle(l, f));
  }
  const d = norm(libAngle(l, 0) - Math.atan2(sy, sx));
  expect(Math.min(d, TAU - d)).toBeLessThan(1e-9);
});

it("spaces libraries evenly, in the order of their preferred angles", () => {
  const m = buildModel(syntheticMap(300, { libraries: 12 }));
  const l = galaxyLayout(m, "component");
  const preferred = m.map.externals.map((_, e) => {
    let sx = 0;
    let sy = 0;
    for (const f of m.importersOfLib[e]) {
      sx += Math.cos(angle(l, f));
      sy += Math.sin(angle(l, f));
    }
    return Math.atan2(sy, sx);
  });
  const order = m.map.externals
    .map((_, e) => e)
    .sort((a, b) => preferred[a] - preferred[b]);
  for (let j = 1; j < order.length; j++)
    expect(norm(libAngle(l, order[j]) - libAngle(l, order[j - 1]))).toBeCloseTo(
      TAU / 12,
      9,
    );
  // turned as a whole to keep each library nearest the angle it prefers
  const step = TAU / 12;
  let sin = 0;
  let cos = 0;
  order.forEach((e, j) => {
    sin += Math.sin(preferred[e] - j * step);
    cos += Math.cos(preferred[e] - j * step);
  });
  const d = norm(libAngle(l, order[0]) - Math.atan2(sin, cos));
  expect(Math.min(d, TAU - d)).toBeLessThan(1e-9);
});

it("orders libraries with the same preferred angle by name", () => {
  // no production file, so no library has an importer and each prefers angle 0
  const map = syntheticMap(0, { libraries: 3 });
  // in name order alpha, mid, zeta: libraries 0, 2 and 1, which no turn of the order 0, 1, 2 gives
  map.externals[0][1] = "alpha";
  map.externals[1][1] = "zeta";
  map.externals[2][1] = "mid";
  const l = galaxyLayout(buildModel(map), "component");
  for (const [a, b] of [
    [0, 2],
    [2, 1],
  ])
    expect(norm(libAngle(l, b) - libAngle(l, a))).toBeCloseTo(TAU / 3, 9);
  expect(Math.hypot(l.libs[0], l.libs[1])).toBeCloseTo(R + LIB_RING, 9);
});

it("lays out 20,000 files within 50 ms", () => {
  const m = buildModel(syntheticMap(20000, { tests: 2000, libraries: 200 }));
  expect(bestOf(5, () => galaxyLayout(m, "component"))).toBeLessThan(50);
});

it("galaxyLayout handles a map with no production files", () => {
  const l = galaxyLayout(
    buildModel(syntheticMap(0, { tests: 3, libraries: 2 })),
    "component",
  );
  expect(l.hubs).toEqual([]);
  expect(Array.from(l.libs).every(Number.isFinite)).toBe(true);
  expect(
    Array.from(l.pos)
      .filter((v) => !Number.isNaN(v))
      .every(Number.isFinite),
  ).toBe(true);
});
