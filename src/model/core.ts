// The core set (§5.6): the files that carry at least a share of what the code depends on.
import { rankOrder } from "./pagerank.js";

/** The shortest run of nodes in rankOrder whose scores add up to at least `share` of their
 *  total, then each component's top-ranked node, so that no component drops out. The total
 *  is summed in index order, the run in rank order. Throws a RangeError when the two arrays
 *  differ in length. */
export function coreSet(
  scores: readonly number[],
  componentOf: readonly number[],
  share = 0.5,
): boolean[] {
  const n = scores.length;
  if (componentOf.length !== n) {
    throw new RangeError(
      `${n} scores but ${componentOf.length} components of a node`,
    );
  }
  const rank = rankOrder(scores);
  const order = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) order[rank[i] - 1] = i;

  let total = 0;
  for (let i = 0; i < n; i++) total += scores[i];
  const target = share * total;
  const core = new Array<boolean>(n).fill(false);
  let sum = 0;
  for (let k = 0; k < n && sum < target; k++) {
    core[order[k]] = true;
    sum += scores[order[k]];
  }

  const topped = new Set<number>();
  for (const i of order) {
    if (topped.has(componentOf[i])) continue;
    topped.add(componentOf[i]);
    core[i] = true;
  }
  return core;
}
