// The map's inks, and how each lens draws a file: its colour, its size, and which files it
// labels; and the legend over the map. No DOM here: Node tests import it.
// - Structure: the larger a file's share of the top PageRank, the brighter and larger its dot.
//   With entry points on, entry files are orange and every other file is faint.
// - Risk: a file in a cycle, or a hotspot above HOTSPOT_MARK, is orange, a hotspot above 0.12 a
//   darker orange, and the rest faint; a dot grows with its share of the top hotspot, so colour
//   is never the only signal. The store scales hotspots so that the top one is 1.
// - History: the larger a file's share of the top churn of the last 90 days, the brighter and
//   larger its dot.
// Tests are faint and small under every lens. A share of a top of 0 counts as 0, so an empty map
// gives no NaN.
import { F, FILE_KINDS, FLAG_ENTRY } from "../../../query/view/constants.js";
import { HOTSPOT_MARK, LABEL_TOP } from "../constants.js";
import type { Model } from "../model.js";
import type { Depth, Grouping, Lens } from "../state.js";

export const INK = Object.freeze({
  hi: "#EAE4D6",
  mid: "#A69D8C",
  lo: "#5C554A",
  faint: "#3A342D",
  dim: "#26221D",
  hub: "#D9CFBB",
  lib: "#7D7568",
  accent: "#E8613C",
  accentMid: "#9A4A30",
} as const);

// How to read the map under each lens, and with entry points on.
export const LEGEND: Readonly<Record<Lens | "entries", string>> = Object.freeze(
  {
    structure:
      "Each dot is a file. The closer to the centre, the more of the code depends on it. Curves through the middle are imports between components.",
    risk: "Orange marks hotspots: files the code depends on that also change often. Orange curves are imports that run in a loop.",
    history:
      "Brighter files changed more in the last 90 days. Select one to see, dashed, the files that change together with it.",
    entries:
      "Orange marks entry points: where code starts running (scripts, plugin entries, routes, units).",
  },
);

// What a hub is under each grouping, one and many.
const HUBS: Readonly<Record<Grouping, readonly [string, string]>> = {
  component: ["component", "components"],
  folder: ["folder", "folders"],
  language: ["language", "languages"],
};

// How to read the map at Components depth, where every dot is a hub of the grouping.
export function componentsLegend(g: Grouping): string {
  const [one, many] = HUBS[g];
  return `Each hub is a ${one}, sized by its code files. Curves are imports between ${many}; thicker means more of them.`;
}

// The legend for a view: the hubs' at Components depth, else the entry points' under Structure
// with them on, else the lens's.
export function legendOf(view: {
  lens: Lens;
  depth: Depth;
  group: Grouping;
  entriesOn: boolean;
}): string {
  if (view.depth === "components") return componentsLegend(view.group);
  if (view.lens === "structure" && view.entriesOn) return LEGEND.entries;
  return LEGEND[view.lens];
}

const CODE = FILE_KINDS.indexOf("code");
const TEST_SIZE = 1.6;
const HOTSPOT_MID = 0.12; // a hotspot above this, up to HOTSPOT_MARK, is a darker orange
const CHURN_HI = 0.45; // shares of the top churn above which a file is orange, then darker
const CHURN_MID = 0.15;

// value / max, or 0 when max is 0.
const share = (value: number, max: number) => (max > 0 ? value / max : 0);

export function fileColor(
  model: Model,
  file: number,
  lens: Lens,
  entriesOn: boolean,
): string {
  const f = model.map.files[file];
  if (f[F.kind] !== CODE) return INK.faint;
  if (lens === "risk") {
    const hot = f[F.hotspot];
    if (f[F.cycle] !== 0 || hot > HOTSPOT_MARK) return INK.accent;
    return hot > HOTSPOT_MID ? INK.accentMid : INK.faint;
  }
  if (lens === "history") {
    const c = share(f[F.churn], model.maxChurn);
    return c > CHURN_HI
      ? INK.accent
      : c > CHURN_MID
        ? INK.accentMid
        : c > 0
          ? INK.lo
          : INK.faint;
  }
  if (entriesOn) {
    return (f[F.flags] & FLAG_ENTRY) !== 0 ? INK.accent : INK.faint;
  }
  const p = share(f[F.pagerank], model.maxPagerank);
  return p > 0.08 ? INK.hi : p > 0.015 ? INK.mid : INK.lo;
}

export function fileSize(model: Model, file: number, lens: Lens): number {
  const f = model.map.files[file];
  if (f[F.kind] !== CODE) return TEST_SIZE;
  if (lens === "risk") {
    return 2 + 10 * Math.sqrt(share(f[F.hotspot], model.maxHotspot));
  }
  if (lens === "history") {
    return 2 + 9 * Math.sqrt(share(f[F.churn], model.maxChurn));
  }
  return 2.2 + 9 * Math.sqrt(share(f[F.pagerank], model.maxPagerank));
}

// The production files a lens labels: its top LABEL_TOP. By rank under Structure, the entry
// points by rank with them on, by hotspot under Risk and by churn under History, rank breaking
// ties; a file whose hotspot or churn is 0 is none of the top.
export function labelledFiles(
  model: Model,
  lens: Lens,
  entriesOn: boolean,
): number[] {
  const files = model.map.files;
  if (lens === "structure") {
    const pool = entriesOn
      ? model.production.filter((f) => (files[f][F.flags] & FLAG_ENTRY) !== 0)
      : model.production;
    return pool.slice(0, LABEL_TOP);
  }
  const at = lens === "risk" ? F.hotspot : F.churn;
  return model.production
    .filter((f) => files[f][at] > 0)
    .sort((a, b) => files[b][at] - files[a][at])
    .slice(0, LABEL_TOP);
}
