// Find: one index over the map's files, definitions and libraries, searched as the viewer types.
// No DOM here: Node tests import it.
// - Each item has two keys, lower-cased once, here: a file its basename and its path, a
//   definition the last part of its qualified name and the whole name, a library its name and
//   <ecosystem>:<name>. The query is trimmed and lower-cased, and an empty one finds nothing.
// - A match is exact when a key is the query, a prefix when a key starts with it, and a
//   substring when the longer key holds it.
// - Matches rank by class, exact first, then by weight, highest first, then by label in path
//   order, then by place in the index, so the order never depends on anything else. A production
//   file weighs 1 + its share of the top pagerank; a test file 0.2, and any other file 0.1; a
//   definition 0.6 + a tenth of the files that use it, ten at most, + 0.2 when it is exported; a
//   library 0.5 + a twentieth of the files that import it, ten at most.
// - A search keeps the best few as it goes, by insertion into a list of at most max matches, and
//   never sorts every match: one pass over 100,000 items stays within 50 ms.
import { comparePaths } from "../../../model/order.js";
import {
  DEF_KINDS,
  ECOSYSTEMS,
  F,
  FILE_KINDS,
} from "../../../query/view/constants.js";
import { FIND_MAX } from "../constants.js";
import type { Model } from "../model.js";
import type { Sel, Tab } from "../state.js";

export type FindKind =
  | "file"
  | "test-file"
  | "function"
  | "class"
  | "method"
  | "constant"
  | "type"
  | "library";

// ref: a file index, a definition index or an external index, by kind
export interface FindHit {
  kind: FindKind;
  ref: number;
  label: string;
  match: "exact" | "prefix" | "substring";
}

export interface FindIndex {
  size: number;
  search(query: string, max?: number): FindHit[]; // max defaults to FIND_MAX
}

const SEP = " \u00b7 ";
const CODE = FILE_KINDS.indexOf("code");
const TEST = FILE_KINDS.indexOf("test");
const TEST_SUPPORT = FILE_KINDS.indexOf("test-support");
const MATCHES = ["exact", "prefix", "substring"] as const;

export function buildFindIndex(model: Model): FindIndex {
  const { files, defs, externals } = model.map;
  const size = files.length + defs.name.length + externals.length;
  const kinds: FindKind[] = [];
  const refs = new Int32Array(size);
  const labels: string[] = [];
  const shorts: string[] = [];
  const longs: string[] = [];
  const weights = new Float64Array(size);
  let at = 0;
  // An item, with its keys lower-cased: the longer one, and the short one at its end.
  const add = (
    kind: FindKind,
    ref: number,
    label: string,
    long: string,
    short: string,
    weight: number,
  ): void => {
    kinds.push(kind);
    refs[at] = ref;
    labels.push(label);
    shorts.push(short);
    longs.push(long);
    weights[at] = weight;
    at++;
  };

  const top = model.maxPagerank;
  files.forEach((file, f) => {
    const path = file[F.path];
    const kind = file[F.kind];
    const test = kind === TEST || kind === TEST_SUPPORT;
    const weight =
      kind === CODE
        ? 1 + (top > 0 ? file[F.pagerank] / top : 0)
        : test
          ? 0.2
          : 0.1;
    const long = path.toLowerCase();
    const short = long.slice(long.lastIndexOf("/") + 1);
    add(test ? "test-file" : "file", f, path, long, short, weight);
  });
  defs.name.forEach((name, d) => {
    const path = files[defs.file[d]][F.path];
    const weight =
      0.6 +
      Math.min(defs.usedBy[d], 10) / 10 +
      (defs.exported[d] === 1 ? 0.2 : 0);
    const label = `${name}${SEP}${path.slice(path.lastIndexOf("/") + 1)}`;
    const long = name.toLowerCase();
    const short = long.slice(long.lastIndexOf(".") + 1);
    add(DEF_KINDS[defs.kind[d]], d, label, long, short, weight);
  });
  externals.forEach(([e, name, importers], x) => {
    const ecosystem = ECOSYSTEMS[e];
    const label = `${ecosystem}:${name}`;
    const long = label.toLowerCase();
    const short = long.slice(ecosystem.length + 1);
    add("library", x, label, long, short, 0.5 + Math.min(importers, 10) / 20);
  });

  // Whether item a, of class ca, ranks before item b, of class cb.
  const before = (ca: number, a: number, cb: number, b: number): boolean => {
    if (ca !== cb) return ca < cb;
    if (weights[a] !== weights[b]) return weights[a] > weights[b];
    const byLabel = comparePaths(labels[a], labels[b]);
    return byLabel !== 0 ? byLabel < 0 : a < b;
  };

  return {
    size,
    search(query, max = FIND_MAX) {
      const q = query.trim().toLowerCase();
      const cap = Math.floor(max);
      if (q === "" || !(cap >= 1)) return [];
      // the best matches so far, best first: their items and their classes
      const best: number[] = [];
      const classes: number[] = [];
      for (let i = 0; i < size; i++) {
        const short = shorts[i];
        const long = longs[i];
        let c: number;
        if (short === q || long === q) c = 0;
        else if (short.startsWith(q) || long.startsWith(q)) c = 1;
        else if (long.includes(q)) c = 2;
        else continue;
        let slot = best.length;
        if (slot === cap) {
          // full: a match no better than the last kept is dropped; a better one drops the last
          if (!before(c, i, classes[cap - 1], best[cap - 1])) continue;
          slot = cap - 1;
        }
        while (slot > 0 && before(c, i, classes[slot - 1], best[slot - 1])) {
          best[slot] = best[slot - 1];
          classes[slot] = classes[slot - 1];
          slot--;
        }
        best[slot] = i;
        classes[slot] = c;
      }
      return best.map((i, k) => ({
        kind: kinds[i],
        ref: refs[i],
        label: labels[i],
        match: MATCHES[classes[k]],
      }));
    },
  };
}

// What picking a hit opens: a file or a library on its Overview, a definition on its Source tab
// with the details widened to read it.
export function pickOf(
  model: Model,
  hit: FindHit,
): { sel: Exclude<Sel, null>; tab: Tab; widen: boolean } {
  switch (hit.kind) {
    case "file":
    case "test-file":
      return {
        sel: { kind: "file", file: hit.ref },
        tab: "overview",
        widen: false,
      };
    case "library":
      return {
        sel: { kind: "library", external: hit.ref },
        tab: "overview",
        widen: false,
      };
    default:
      return {
        sel: {
          kind: "definition",
          file: model.map.defs.file[hit.ref],
          def: hit.ref,
        },
        tab: "source",
        widen: true,
      };
  }
}
