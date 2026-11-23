// The filters and the list view's order. No DOM here: Node tests import it.
// - A filter holds only when it is set, and a file passes when every filter that is set holds:
//   its language, its component, an entry point, in an import cycle, changed in the last N days
//   (a file the history never touched, or whose change reads as later than the build, changed in
//   no window), or a hotspot above a threshold.
// - The map dims the files that do not pass, and moves and hides none; the list view lists only
//   the files that pass: the production files by rank, then, while tests are shown, the test files
//   by path.
import { F, FILE_KINDS, FLAG_ENTRY } from "../../query/view/constants.js";
import type { Model } from "./model.js";
import type { Filters } from "./state.js";
import { count } from "./words.js";

const CODE = FILE_KINDS.indexOf("code");
const TEST = FILE_KINDS.indexOf("test");
const TEST_SUPPORT = FILE_KINDS.indexOf("test-support");

export function passes(model: Model, file: number, f: Filters): boolean {
  const x = model.map.files[file];
  const days = x[F.changedDaysAgo];
  return (
    (f.lang === null || x[F.lang] === f.lang) &&
    (f.component === null || x[F.component] === f.component) &&
    (!f.entriesOnly || (x[F.flags] & FLAG_ENTRY) !== 0) &&
    (!f.inCycle || x[F.cycle] !== 0) &&
    (f.changedWithin === null || (days >= 0 && days < f.changedWithin)) &&
    (f.hotspotAbove === null || x[F.hotspot] > f.hotspotAbove)
  );
}

export function listFiles(
  model: Model,
  f: Filters,
  showTests: boolean,
): number[] {
  const out = model.production.filter((file) => passes(model, file, f));
  if (showTests) {
    for (const file of model.tests) if (passes(model, file, f)) out.push(file);
  }
  return out;
}

// What a row of the list view is called, read aloud as it reads on screen: a production file's
// path, rank and importers ("src/core/graph.ts, rank 1, 3 importers", one in the singular), a
// test file's path and that it is a test, and any other file's path alone.
export function listLabel(model: Model, file: number): string {
  const x = model.map.files[file];
  const kind = x[F.kind];
  if (kind === TEST || kind === TEST_SUPPORT) return `${x[F.path]}, test`;
  if (kind !== CODE) return x[F.path];
  return `${x[F.path]}, rank ${x[F.rank]}, ${count(model.importers[file].length, "importer")}`;
}

// Each language's code files, by its place in the map's languages: what the language filter
// counts beside each name, as the language hubs are sized by their code files.
export function languageCounts(model: Model): number[] {
  const counts = new Array<number>(model.map.langs.length).fill(0);
  for (const file of model.production) {
    const lang = model.map.files[file][F.lang];
    if (lang >= 0 && lang < counts.length) counts[lang]++;
  }
  return counts;
}
