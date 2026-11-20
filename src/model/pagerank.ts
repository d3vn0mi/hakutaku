// PageRank over import edges, and the rank order it gives.
//
// Nodes are the indexes 0..n−1 of a list sorted by comparePaths, so "ties by path" is "ties
// by index". An edge runs from the importer to the imported file, so the most depended-on
// files rank highest. The caller removes duplicate edges.
//
// Every sum runs in index order, and a node's incoming shares are added in ascending order of
// their source, whatever order the edges come in, so the scores are the same bits on every
// machine.

/** An import edge between two node indexes: from the importer to the imported. */
export type Edge = readonly [from: number, to: number];

const DAMPING = 0.85;
const TOLERANCE = 1e-10; // stop once the L1 change of a round is below this
const MAX_ROUNDS = 100;

/** Each node's neighbours in ascending index, in compressed rows: node i's are
 *  list[start[i]] to list[start[i + 1] − 1]. "out" lists the nodes each one imports; "in"
 *  lists the nodes that import it. Throws a RangeError for an edge that names no node. */
export function adjacency(
  n: number,
  edges: readonly Edge[],
  side: "out" | "in",
): { start: Int32Array; list: Int32Array } {
  const isNode = (i: number): boolean => Number.isInteger(i) && i >= 0 && i < n;
  const start = new Int32Array(n + 1);
  for (const [from, to] of edges) {
    if (!isNode(from) || !isNode(to)) {
      throw new RangeError(`edge [${from}, ${to}] names no node of ${n}`);
    }
    start[(side === "out" ? from : to) + 1]++;
  }
  for (let i = 0; i < n; i++) start[i + 1] += start[i];
  const fill = start.slice(0, n);
  const list = new Int32Array(edges.length);
  for (const [from, to] of edges) {
    if (side === "out") list[fill[from]++] = to;
    else list[fill[to]++] = from;
  }
  // a typed array sorts by number
  for (let i = 0; i < n; i++) list.subarray(start[i], start[i + 1]).sort();
  return { start, list };
}

/** PageRank with damping 0.85, a dangling node's mass spread evenly over all nodes, and
 *  rounds until the L1 change is below 1e-10, at most 100. The scores sum to 1. */
export function pagerank(n: number, edges: readonly Edge[]): number[] {
  const { start, list } = adjacency(n, edges, "in");
  if (n === 0) return [];
  const outDegree = new Int32Array(n);
  for (const [from] of edges) outDegree[from]++;
  let rank = new Float64Array(n).fill(1 / n);
  let next = new Float64Array(n);
  const share = new Float64Array(n); // what each node passes along each of its edges
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let dangling = 0;
    for (let u = 0; u < n; u++) {
      if (outDegree[u] === 0) dangling += rank[u];
      else share[u] = rank[u] / outDegree[u];
    }
    const base = (1 - DAMPING + DAMPING * dangling) / n;
    let change = 0;
    for (let v = 0; v < n; v++) {
      let sum = 0;
      for (let k = start[v]; k < start[v + 1]; k++) sum += share[list[k]];
      next[v] = base + DAMPING * sum;
      change += Math.abs(next[v] - rank[v]);
    }
    [rank, next] = [next, rank];
    if (change < TOLERANCE) break;
  }
  return Array.from(rank);
}

/** Each node's rank: 1 for the highest score, then down; equal scores rank by index. */
export function rankOrder(scores: readonly number[]): number[] {
  const order = scores
    .map((_, i) => i)
    .sort((a, b) =>
      scores[a] > scores[b] ? -1 : scores[a] < scores[b] ? 1 : a - b,
    );
  const rank = new Array<number>(scores.length).fill(0);
  for (let k = 0; k < order.length; k++) rank[order[k]] = k + 1;
  return rank;
}
