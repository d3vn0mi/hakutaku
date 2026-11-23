// Depth levels: how much of the map is drawn. No DOM here: Node tests import it.
// - Components: the hubs alone, with the imports between them added up. The big picture.
// - Core: the core view, with the hubs and the libraries; tests are hidden.
// - Files: every production file, with tests and libraries by their toggles.
// The core view keeps the picture small, yet no part of the repo vanishes from it: the core set,
// every entry point, every hotspot above HOTSPOT_MARK, and each component's top file by rank,
// the files without a component counting as one more component, as the store's core set counts
// them. A map opens at Core depth above CORE_DEPTH_ABOVE production files, else at Files.
import { F, FLAG_CORE, FLAG_ENTRY } from "../../query/view/constants.js";
import type { MapData } from "../../query/view/types.js";
import { CORE_DEPTH_ABOVE, HOTSPOT_MARK } from "./constants.js";
import type { Model } from "./model.js";
import type { Depth } from "./state.js";

// The depths, in the order D steps through them.
export const DEPTHS: readonly Depth[] = Object.freeze([
  "components",
  "core",
  "files",
]);

const views = new WeakMap<Model, ReadonlySet<number>>();

// The production files Core depth draws, in rank order; worked out once per model.
export function coreView(model: Model): ReadonlySet<number> {
  const known = views.get(model);
  if (known !== undefined) return known;
  const files = model.map.files;
  const view = new Set<number>();
  const topped = new Set<number>(); // the components whose top file is in
  // model.production is in rank order, so a component's first file there is its top file
  for (const f of model.production) {
    const file = files[f];
    if (
      (file[F.flags] & (FLAG_CORE | FLAG_ENTRY)) !== 0 ||
      file[F.hotspot] > HOTSPOT_MARK
    ) {
      view.add(f);
    }
    if (!topped.has(file[F.component])) {
      topped.add(file[F.component]);
      view.add(f);
    }
  }
  views.set(model, view);
  return view;
}

export function defaultDepth(model: Model): Depth {
  return model.production.length > CORE_DEPTH_ABOVE ? "core" : "files";
}

// The depth after d: Components, then Core, then Files, then Components again.
export function nextDepth(d: Depth): Depth {
  return DEPTHS[(DEPTHS.indexOf(d) + 1) % DEPTHS.length];
}

// What the stat band says at Core depth: the share of the production files that carries at least
// half of what the code depends on, its numbers written as en-US writes them (1,204).
export function coverageLine(map: MapData): string {
  const { files, ofFiles } = map.coreSet;
  if (ofFiles === 0) return "No production files on this map.";
  const whole = (n: number) => n.toLocaleString("en-US");
  return `${whole(files)} of ${whole(ofFiles)} production files (${Math.round((100 * files) / ofFiles)}%) carry at least half of what the code depends on`;
}

// Whether a depth draws a file, the show toggles aside: Files every file of the map, Core the
// core view's, Components none.
export function fileShownAt(model: Model, depth: Depth, file: number): boolean {
  if (depth === "files") return model.onMap(file);
  return depth === "core" && coreView(model).has(file);
}
