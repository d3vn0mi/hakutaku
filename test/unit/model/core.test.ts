import { expect, it } from "vitest";
import { coreSet } from "../../../src/model/core.js";

it("adds each component's top file to the prefix", () => {
  expect(coreSet([0.4, 0.3, 0.2, 0.1], [0, 0, 1, 1])).toEqual([
    true,
    true,
    true,
    false,
  ]);
  // the prefix is {0, 1}; component 1's only file is last in rank order and still joins
  expect(coreSet([0.4, 0.3, 0.2, 0.1], [0, 0, 0, 1])).toEqual([
    true,
    true,
    false,
    true,
  ]);
});

it("takes the shortest prefix in rank order that reaches the share", () => {
  // equal scores rank by index; 0.25 + 0.25 is exactly half, so two files are enough
  expect(coreSet([0.25, 0.25, 0.25, 0.25], [0, 0, 0, 0])).toEqual([
    true,
    true,
    false,
    false,
  ]);
  expect(coreSet([0.25, 0.25, 0.25, 0.25], [0, 0, 0, 0], 0.75)).toEqual([
    true,
    true,
    true,
    false,
  ]);
});

it("answers no files with no core, and refuses arrays of different lengths", () => {
  expect(coreSet([], [])).toEqual([]);
  expect(() => coreSet([0.5, 0.5], [0])).toThrow(RangeError);
});
