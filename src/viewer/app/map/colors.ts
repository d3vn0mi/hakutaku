// The map's inks, and each file's colour and size under the Structure lens: the larger a file's
// share of the top PageRank, the brighter and larger its dot. Tests are faint and small. No DOM
// here: Node tests import it.
import { F, FILE_KINDS } from "../../../query/view/constants.js";
import type { Model } from "../model.js";
import type { Lens } from "../state.js";

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

const CODE = FILE_KINDS.indexOf("code");
const TEST_SIZE = 1.6;

// value / max, or 0 when max is 0, so an empty map gives no NaN.
const share = (value: number, max: number) => (max > 0 ? value / max : 0);

export function fileColor(
  model: Model,
  file: number,
  _lens: Lens,
  _entriesOn: boolean,
): string {
  const f = model.map.files[file];
  if (f[F.kind] !== CODE) return INK.faint;
  const p = share(f[F.pagerank], model.maxPagerank);
  return p > 0.08 ? INK.hi : p > 0.015 ? INK.mid : INK.lo;
}

export function fileSize(model: Model, file: number, _lens: Lens): number {
  const f = model.map.files[file];
  if (f[F.kind] !== CODE) return TEST_SIZE;
  return 2.2 + 9 * Math.sqrt(share(f[F.pagerank], model.maxPagerank));
}
