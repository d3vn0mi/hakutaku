// Import cycles: Tarjan's strongly connected components, and each cycle's shortest
// closing chain.
//
// Nodes are indexes into a list sorted by comparePaths. Tarjan's algorithm runs as a loop
// over an explicit path, never as recursion: a deep import graph would overflow the stack.
import { adjacency, type Edge } from "./pagerank.js";

/** The strongly connected sets of two or more nodes, and each single node with an edge to
 *  itself. Each set is in ascending order, and the sets are in order of their first node.
 *  Throws a RangeError for an edge that names no node. */
export function tarjan(n: number, edges: readonly Edge[]): number[][] {
  const { start, list } = adjacency(n, edges, "out");
  const selfEdge = new Uint8Array(n);
  for (const [from, to] of edges) if (from === to) selfEdge[from] = 1;

  const index = new Int32Array(n).fill(-1); // order of discovery; −1 is not yet seen
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack = new Int32Array(n); // seen nodes not yet in a set
  let stackSize = 0;
  const path = new Int32Array(n); // the depth-first path, in place of the call stack
  let depth = 0;
  const cursor = new Int32Array(n); // each node's next edge in list
  let seen = 0;
  const sets: number[][] = [];

  const enter = (v: number): void => {
    index[v] = seen;
    low[v] = seen;
    seen++;
    stack[stackSize++] = v;
    onStack[v] = 1;
    cursor[v] = start[v];
    path[depth++] = v;
  };

  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    enter(root);
    while (depth > 0) {
      const v = path[depth - 1];
      if (cursor[v] < start[v + 1]) {
        const w = list[cursor[v]++];
        if (index[w] === -1) enter(w);
        else if (onStack[w] === 1 && index[w] < low[v]) low[v] = index[w];
        continue;
      }
      depth--;
      if (depth > 0) {
        const parent = path[depth - 1];
        if (low[v] < low[parent]) low[parent] = low[v];
      }
      if (low[v] !== index[v]) continue;
      const set: number[] = [];
      let w: number;
      do {
        w = stack[--stackSize];
        onStack[w] = 0;
        set.push(w);
      } while (w !== v);
      if (set.length > 1 || selfEdge[v] === 1) {
        sets.push(set.sort((a, b) => a - b));
      }
    }
  }
  return sets.sort((a, b) => a[0] - b[0]);
}

/** The shortest cycle through set[0] inside the set: a breadth-first search from set[0], over
 *  the edges between the set's nodes, neighbours in ascending index, that stops at the first
 *  edge back to set[0]. Returns the chain's nodes from set[0] on, without repeating it; [] for
 *  an empty set, or when no cycle inside the set passes through set[0]. */
export function closingChain(
  set: readonly number[],
  edges: readonly Edge[],
): number[] {
  if (set.length === 0) return [];
  const first = set[0];
  const inSet = new Set(set);
  const next = new Map<number, number[]>();
  for (const [from, to] of edges) {
    if (!inSet.has(from) || !inSet.has(to)) continue;
    const targets = next.get(from);
    if (targets) targets.push(to);
    else next.set(from, [to]);
  }
  for (const targets of next.values()) targets.sort((a, b) => a - b);

  const parent = new Map<number, number>(); // how the search first reached each node
  const queue = [first];
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head];
    for (const v of next.get(u) ?? []) {
      if (v === first) {
        const chain = [u];
        let w = u;
        while (w !== first) {
          w = parent.get(w) ?? first;
          chain.push(w);
        }
        return chain.reverse();
      }
      if (!parent.has(v)) {
        parent.set(v, u);
        queue.push(v);
      }
    }
  }
  return [];
}
