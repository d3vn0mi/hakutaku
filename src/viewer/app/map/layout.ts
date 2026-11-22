// The galaxy layout. It draws no randomness and follows no order that depends on a hash map, so
// the same map always gives the same picture, in a few milliseconds for 20,000 files:
// - Sectors: the groups of the production files, by file count, the larger first, then by key
//   in path order. A group's sector is 2π·max(0.012, n/N) over the sum of those values, and the
//   sectors run end to end from −π/2, the top of the circle.
// - Production files, in rank order: file i of N, the k-th of its group, sits at radius
//   R·√((i + 0.5)/N), so the most depended-on are at the centre, and at angle
//   a0 + w·(0.1 + 0.8·((k·0.618034) mod 1)) + TWIST·r/R in its group's sector.
// - Tests, in path order: test j sits on a ring outside the disc, at radius
//   R + TEST_RING + TEST_SPREAD·((j·0.754877) mod 1), and angle
//   a0 + w·(0.06 + 0.88·((j·0.381966) mod 1)) + TWIST, in its group's sector, else in the first
//   one, else, with no sector at all, over the whole circle from the top.
// - Hubs: at R + HUB_RING, at their sector's middle angle + TWIST.
// - Libraries: each prefers the angle of the mean unit vector of its importers' positions (0
//   when it has none). Sorted by that angle, then by name, they sit 2π/L apart at R + LIB_RING,
//   turned by atan2(Σ sin(a_j − jθ), Σ cos(a_j − jθ)), the turn that best keeps each near the
//   angle it prefers.
// No DOM here: Node tests import it.
import { comparePaths } from "../../../model/order.js";
import {
  HUB_RING,
  LIB_RING,
  R,
  TEST_RING,
  TEST_SPREAD,
  TWIST,
} from "../constants.js";
import { groupKey, type Model } from "../model.js";
import type { Grouping } from "../state.js";

const TAU = 2 * Math.PI;
const TOP = -Math.PI / 2;
const MIN_SHARE = 0.012;

export interface Hub {
  key: string;
  x: number;
  y: number;
  files: number; // its production files
  a0: number; // where its sector starts
  w: number; // its sector's width
}

export interface GalaxyLayout {
  pos: Float64Array; // x, y per file index; NaN for a file off the map
  hubs: Hub[]; // one per group of production files, in sector order
  libs: Float64Array; // x, y per library, by its index in externals
}

export function galaxyLayout(model: Model, g: Grouping): GalaxyLayout {
  const files = model.map.files;
  const pos = new Float64Array(2 * files.length).fill(Number.NaN);
  const put = (f: number, r: number, angle: number) => {
    pos[2 * f] = r * Math.cos(angle);
    pos[2 * f + 1] = r * Math.sin(angle);
  };

  // Sectors.
  const total = model.production.length;
  const keys = model.production.map((f) => groupKey(model, f, g));
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  const groups = [...counts].sort(
    (a, b) => b[1] - a[1] || comparePaths(a[0], b[0]),
  );
  const shares = groups.map(([, n]) => Math.max(MIN_SHARE, n / total));
  const sum = shares.reduce((s, v) => s + v, 0);
  const hubs: Hub[] = [];
  const sectorOf = new Map<string, { hub: Hub; placed: number }>();
  let a0 = TOP;
  groups.forEach(([key, n], i) => {
    const w = (TAU * shares[i]) / sum;
    const mid = a0 + w / 2 + TWIST;
    const hub = {
      key,
      x: (R + HUB_RING) * Math.cos(mid),
      y: (R + HUB_RING) * Math.sin(mid),
      files: n,
      a0,
      w,
    };
    hubs.push(hub);
    sectorOf.set(key, { hub, placed: 0 });
    a0 += w;
  });

  // Production files, in rank order.
  model.production.forEach((f, i) => {
    const sector = sectorOf.get(keys[i]);
    if (sector === undefined) return; // every key has its sector
    const k = sector.placed++;
    const r = R * Math.sqrt((i + 0.5) / total);
    const { a0: start, w } = sector.hub;
    put(f, r, start + w * (0.1 + 0.8 * ((k * 0.618034) % 1)) + (TWIST * r) / R);
  });

  // Tests, in path order.
  const first = hubs[0] ?? { a0: TOP, w: TAU };
  model.tests.forEach((f, j) => {
    const { a0: start, w } = sectorOf.get(groupKey(model, f, g))?.hub ?? first;
    const r = R + TEST_RING + TEST_SPREAD * ((j * 0.754877) % 1);
    put(f, r, start + w * (0.06 + 0.88 * ((j * 0.381966) % 1)) + TWIST);
  });

  return { pos, hubs, libs: libraryPositions(model, pos) };
}

function libraryPositions(model: Model, pos: Float64Array): Float64Array {
  const externals = model.map.externals;
  const count = externals.length;
  const libs = new Float64Array(2 * count);
  if (count === 0) return libs;

  const preferred = new Float64Array(count);
  for (let e = 0; e < count; e++) {
    let sx = 0;
    let sy = 0;
    for (const f of model.importersOfLib[e]) {
      if (Number.isNaN(pos[2 * f])) continue; // an importer off the map has no position
      const a = Math.atan2(pos[2 * f + 1], pos[2 * f]);
      sx += Math.cos(a);
      sy += Math.sin(a);
    }
    preferred[e] = sx === 0 && sy === 0 ? 0 : Math.atan2(sy, sx);
  }
  const order = Array.from({ length: count }, (_, e) => e).sort(
    (a, b) =>
      preferred[a] - preferred[b] ||
      comparePaths(externals[a][1], externals[b][1]) ||
      a - b,
  );
  const step = TAU / count;
  let sin = 0;
  let cos = 0;
  order.forEach((e, j) => {
    sin += Math.sin(preferred[e] - j * step);
    cos += Math.cos(preferred[e] - j * step);
  });
  const turn = Math.atan2(sin, cos);
  order.forEach((e, j) => {
    libs[2 * e] = (R + LIB_RING) * Math.cos(turn + j * step);
    libs[2 * e + 1] = (R + LIB_RING) * Math.sin(turn + j * step);
  });
  return libs;
}
