// Shared by the browser app's unit tests: the model of the tiny store's map, and the best time
// of a few runs of a function.
import { mapData } from "../../../../src/query/view/index.js";
import { openStore } from "../../../../src/store/index.js";
import { buildModel, type Model } from "../../../../src/viewer/app/model.js";
import { tinyStore } from "../tiny-store.js";

// The page's model of the tiny store's map. The map is plain data, so the store is closed once
// it is read.
export function tinyModel(): Model {
  const store = openStore(tinyStore());
  if ("code" in store) throw new Error(store.reason);
  try {
    return buildModel(mapData(store, { stale: false, snippets: true }));
  } finally {
    store.close();
  }
}

// The fastest of n runs of fn, in milliseconds: the run least disturbed by whatever else the
// machine is doing, and past the first run's compilation.
export function bestOf(n: number, fn: () => unknown): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}
