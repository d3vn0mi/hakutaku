import { expect, it } from "vitest";
import { closingChain, tarjan } from "../../../src/model/cycles.js";

it("finds a two-node and a three-node cycle and nothing else", () =>
  expect(
    tarjan(6, [
      [0, 1],
      [1, 0],
      [2, 3],
      [3, 4],
      [4, 2],
      [4, 5],
    ]),
  ).toEqual([
    [0, 1],
    [2, 3, 4],
  ]));

it("keeps a self-import as a cycle", () =>
  expect(tarjan(2, [[1, 1]])).toEqual([[1]]));

it("handles a 100,000-node cycle without overflowing the stack", () => {
  const n = 100_000;
  const edges = Array.from({ length: n }, (_, i) => [i, (i + 1) % n] as const);
  expect(tarjan(n, edges)[0].length).toBe(n);
});

it("picks the shortest closing chain", () =>
  expect(
    closingChain(
      [0, 1, 2, 3],
      [
        [0, 1],
        [1, 2],
        [2, 0],
        [0, 3],
        [3, 0],
      ],
    ),
  ).toEqual([0, 3]));

it("sorts each set and the list of sets as numbers, whatever order they are found in", () =>
  // {10, 11} closes before {9, 12}; a sort by strings would put 12 before 9, and [10, 11]
  // before [9, 12]
  expect(
    tarjan(13, [
      [9, 10],
      [10, 11],
      [11, 10],
      [9, 12],
      [12, 9],
    ]),
  ).toEqual([
    [9, 12],
    [10, 11],
  ]));

it("answers a graph without a cycle with no sets", () => {
  expect(tarjan(0, [])).toEqual([]);
  expect(
    tarjan(3, [
      [0, 1],
      [1, 2],
    ]),
  ).toEqual([]);
});

it("refuses an edge that names no node", () =>
  expect(() => tarjan(2, [[0, 2]])).toThrow(RangeError));

it("closes a self-import on its own node", () =>
  expect(closingChain([1], [[1, 1]])).toEqual([1]));

it("keeps the closing chain inside the set", () =>
  // 0 → 5 → 0 is shorter, but 5 is not in the set
  expect(
    closingChain(
      [0, 1, 2],
      [
        [0, 1],
        [1, 2],
        [2, 0],
        [0, 5],
        [5, 0],
      ],
    ),
  ).toEqual([0, 1, 2]));

it("takes the lower neighbour when two closing chains are as short", () =>
  // 9 and 10 both close in two steps; 9 is the lower index, though its edge comes second
  expect(
    closingChain(
      [0, 9, 10],
      [
        [0, 10],
        [10, 0],
        [0, 9],
        [9, 0],
      ],
    ),
  ).toEqual([0, 9]));

it("gives no closing chain for an empty set or one that does not close", () => {
  expect(closingChain([], [])).toEqual([]);
  expect(closingChain([0, 1], [[0, 1]])).toEqual([]);
});
