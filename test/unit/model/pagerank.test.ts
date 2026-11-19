import { expect, it } from "vitest";
import { type Edge, pagerank, rankOrder } from "../../../src/model/pagerank.js";

it("ranks the end of a chain highest and sums to 1", () => {
  const pr = pagerank(3, [
    [0, 1],
    [1, 2],
  ]);
  expect(pr[2]).toBeGreaterThan(pr[1]);
  expect(pr[1]).toBeGreaterThan(pr[0]);
  expect(Math.abs(pr.reduce((a, b) => a + b, 0) - 1)).toBeLessThan(1e-12);
});

it("spreads a dangling node's mass and is repeatable", () => {
  const edges: Edge[] = [
    [0, 1],
    [2, 1],
    [3, 0],
  ];
  expect(pagerank(4, edges)).toEqual(pagerank(4, edges));
  // Node 1 imports nothing, so each round its mass goes to all four nodes alike, and every
  // node gets the same base c. With d = 0.85: p2 = p3 = c, p0 = c + d·p3 = 1.85c,
  // p1 = c + d·(p0 + p2) = c + 0.85 × 2.85c = 3.4225c, and the sum 7.2725c is 1.
  const c = 1 / 7.2725;
  expect(pagerank(4, edges)).toEqual(
    [1.85 * c, 3.4225 * c, c, c].map((p) => expect.closeTo(p, 9)),
  );
});

it("orders ties by index", () =>
  expect(rankOrder([0.2, 0.5, 0.2])).toEqual([2, 1, 3]));

// 60 nodes and 300 distinct edges from a fixed Lehmer sequence, with no self-edge.
function graph(n: number, m: number): Edge[] {
  const seen = new Set<number>();
  const edges: Edge[] = [];
  let x = 1;
  const next = (): number => {
    x = (x * 48271) % 2147483647;
    return x % n;
  };
  while (edges.length < m) {
    const from = next();
    const to = next();
    if (from !== to && !seen.has(from * n + to)) {
      seen.add(from * n + to);
      edges.push([from, to]);
    }
  }
  return edges;
}

it("gives the same scores whatever order the edges come in", () => {
  const edges = graph(60, 300);
  const scores = pagerank(60, edges);
  expect(pagerank(60, edges.toReversed())).toEqual(scores);
  // a stride of 7 through the 300 edges visits each once
  expect(
    pagerank(
      60,
      edges.map((_, i) => edges[(i * 7) % 300]),
    ),
  ).toEqual(scores);
});

it("answers an empty graph with no scores", () => {
  expect(pagerank(0, [])).toEqual([]);
  expect(rankOrder([])).toEqual([]);
});

it.each<[Edge]>([[[0, 2]], [[-1, 0]], [[0.5, 1]]])(
  "refuses %j, an edge that names no node of two",
  (edge) => expect(() => pagerank(2, [edge])).toThrow(RangeError),
);
