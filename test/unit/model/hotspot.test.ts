import { expect, it } from "vitest";
import { hotspots } from "../../../src/model/hotspot.js";

it("scales hotspots so the top one is 1", () => {
  // √(0.5/0.5 × 1/4) = 0.5 and √(0.3/0.5 × 4/4) ≈ 0.7746, so the first is 0.5 / 0.7746 ≈ 0.65
  expect(hotspots([0.5, 0.3, 0.2], [1, 4, 0])).toEqual([0.65, 1, 0]);
  expect(hotspots([0.5, 0.5], [0, 0])).toEqual([0, 0]);
});

it("gives every node 0 when none has both a score and a churn above 0", () =>
  expect(hotspots([0.5, 0], [0, 3])).toEqual([0, 0]));

it("answers no files with no hotspots, and refuses arrays of different lengths", () => {
  expect(hotspots([], [])).toEqual([]);
  expect(() => hotspots([0.5, 0.5], [1])).toThrow(RangeError);
});
