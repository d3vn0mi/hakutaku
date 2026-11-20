// Hotspots: what the code depends on most, crossed with what changes most.

/** √(score ÷ max score × churn ÷ max churn) for each node, divided by the largest such
 *  value so that the top hotspot is 1, and rounded to two decimals with
 *  Math.round(x × 100) / 100. All 0 when no node has both a score and a churn above 0, as
 *  when the largest churn is 0. Throws a RangeError when the two arrays differ in length. */
export function hotspots(
  scores: readonly number[],
  churn: readonly number[],
): number[] {
  const n = scores.length;
  if (churn.length !== n) {
    throw new RangeError(`${n} scores but ${churn.length} churn counts`);
  }
  const hot = new Array<number>(n).fill(0);
  let maxScore = 0;
  let maxChurn = 0;
  for (let i = 0; i < n; i++) {
    if (scores[i] > maxScore) maxScore = scores[i];
    if (churn[i] > maxChurn) maxChurn = churn[i];
  }
  if (maxScore === 0 || maxChurn === 0) return hot;

  const raw = new Array<number>(n).fill(0);
  let top = 0;
  for (let i = 0; i < n; i++) {
    raw[i] = Math.sqrt((scores[i] / maxScore) * (churn[i] / maxChurn));
    if (raw[i] > top) top = raw[i];
  }
  if (top === 0) return hot;
  for (let i = 0; i < n; i++) hot[i] = Math.round((raw[i] / top) * 100) / 100;
  return hot;
}
