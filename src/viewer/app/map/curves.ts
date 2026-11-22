// Which import curves the map draws, and where a curve bends. No DOM here: Node tests import it.
// - With a selection, only the curves that touch it: each is "cycle" when both ends share a cycle
//   and the import is more than a type, else "selected". The selection's libraries get a curve
//   each, and only then.
// - Without one, every visible curve while they number at most the budget; "cycle" or "base"
//   under the Risk lens, "base" otherwise. Beyond the budget, only the curves with both ends in
//   the core view, cut to the budget.
// A pair of files that the store holds several imports between is one curve, in the order of
// the pair's first import.
import { F, IMPORT_KINDS } from "../../../query/view/constants.js";
import { CURVE_BUDGET } from "../constants.js";
import { groupKey, type Model } from "../model.js";
import type { Grouping } from "../state.js";

export type CurveKind =
  | "base"
  | "cycle"
  | "selected"
  | "cochange"
  | "aggregate";

// from and to are file indices, except that a curve to a library ends at
// map.files.length + the library's index in externals, and an "aggregate" curve joins two hubs
// by their indices. weight counts the imports a curve carries.
export interface CurvePick {
  from: number;
  to: number;
  kind: CurveKind;
  weight: number;
}

export interface CurveView {
  visible(file: number): boolean;
  inCore(file: number): boolean;
  selected: number | null; // a file index
  riskLens: boolean;
  cochange?: Array<[number, number]>; // [file, partner] pairs to join with a dashed curve
}

const TYPE_ONLY = IMPORT_KINDS.indexOf("type-only");

// Each pair of files with an import between them, once, in the order of its first import, and
// whether its curve is a cycle's: both ends share a cycle, and one import of the pair is more
// than a type.
interface Pairs {
  from: Int32Array;
  to: Int32Array;
  cycle: Uint8Array;
}

const pairsOf = new WeakMap<Model, Pairs>();

function importPairs(model: Model): Pairs {
  const known = pairsOf.get(model);
  if (known !== undefined) return known;
  const { files, imports } = model.map;
  const n = files.length;
  const at = new Map<number, number>();
  const from: number[] = [];
  const to: number[] = [];
  const more: number[] = []; // 1 once an import of the pair is more than a type
  for (let i = 0; i < imports.length; i += 3) {
    const [src, dst, kind] = [imports[i], imports[i + 1], imports[i + 2]];
    const key = src * n + dst;
    let p = at.get(key);
    if (p === undefined) {
      p = from.length;
      at.set(key, p);
      from.push(src);
      to.push(dst);
      more.push(0);
    }
    if (kind !== TYPE_ONLY) more[p] = 1;
  }
  const cycle = new Uint8Array(from.length);
  for (let p = 0; p < from.length; p++) {
    const c = files[from[p]][F.cycle];
    cycle[p] = more[p] === 1 && c !== 0 && c === files[to[p]][F.cycle] ? 1 : 0;
  }
  const pairs = {
    from: Int32Array.from(from),
    to: Int32Array.from(to),
    cycle,
  };
  pairsOf.set(model, pairs);
  return pairs;
}

export function pickCurves(
  model: Model,
  view: CurveView,
  budget: number = CURVE_BUDGET,
): CurvePick[] {
  const { from, to, cycle } = importPairs(model);
  const out: CurvePick[] = [];
  const sel = view.selected;
  if (sel !== null) {
    for (let p = 0; p < from.length; p++) {
      const [a, b] = [from[p], to[p]];
      if ((a === sel || b === sel) && view.visible(a) && view.visible(b)) {
        out.push({
          from: a,
          to: b,
          kind: cycle[p] ? "cycle" : "selected",
          weight: 1,
        });
      }
    }
    if (view.visible(sel)) {
      const n = model.map.files.length;
      for (const e of model.libsOf[sel]) {
        out.push({ from: sel, to: n + e, kind: "selected", weight: 1 });
      }
    }
  } else {
    const shown: number[] = [];
    for (let p = 0; p < from.length; p++) {
      if (view.visible(from[p]) && view.visible(to[p])) shown.push(p);
    }
    const kept =
      shown.length <= budget
        ? shown
        : shown.filter((p) => view.inCore(from[p]) && view.inCore(to[p]));
    for (const p of kept.length > budget ? kept.slice(0, budget) : kept) {
      out.push({
        from: from[p],
        to: to[p],
        kind: view.riskLens && cycle[p] ? "cycle" : "base",
        weight: 1,
      });
    }
  }
  for (const [a, b] of view.cochange ?? []) {
    if (view.visible(a) && view.visible(b)) {
      out.push({ from: a, to: b, kind: "cochange", weight: 1 });
    }
  }
  return out.length > budget ? out.slice(0, budget) : out;
}

// The imports between production files of two different groups, added up per pair of hubs, by
// the hubs' indices; a group that hubIndex does not know (-1) has none.
export function aggregateCurves(
  model: Model,
  g: Grouping,
  hubIndex: (key: string) => number,
): CurvePick[] {
  const hubOf = new Int32Array(model.map.files.length).fill(-1);
  for (const f of model.production) hubOf[f] = hubIndex(groupKey(model, f, g));
  const { from, to } = importPairs(model);
  const weights = new Map<number, Map<number, number>>();
  for (let p = 0; p < from.length; p++) {
    const [a, b] = [hubOf[from[p]], hubOf[to[p]]];
    if (a < 0 || b < 0 || a === b) continue;
    const row = weights.get(a) ?? new Map<number, number>();
    weights.set(a, row);
    row.set(b, (row.get(b) ?? 0) + 1);
  }
  const out: CurvePick[] = [];
  for (const a of [...weights.keys()].sort((x, y) => x - y)) {
    const row = weights.get(a) ?? new Map<number, number>();
    for (const b of [...row.keys()].sort((x, y) => x - y)) {
      out.push({ from: a, to: b, kind: "aggregate", weight: row.get(b) ?? 0 });
    }
  }
  return out;
}

// The control point of the curve from a to b: its midpoint, scaled toward the centre (0, 0) by
// pull.
export function controlPoint(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  pull: number,
): [number, number] {
  return [((ax + bx) / 2) * pull, ((ay + by) / 2) * pull];
}
