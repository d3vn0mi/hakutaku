import { expect, it } from "vitest";
import { isDeepSubset } from "../../helpers/subset.js";

it("compares primitives with ===", () => {
  expect(isDeepSubset(1, 1)).toBe(true);
  expect(isDeepSubset("a", "a")).toBe(true);
  expect(isDeepSubset(null, null)).toBe(true);
  expect(isDeepSubset(true, true)).toBe(true);
  expect(isDeepSubset(1, "1")).toBe(false);
  expect(isDeepSubset(null, undefined)).toBe(false);
  expect(isDeepSubset(0, false)).toBe(false);
  expect(isDeepSubset(Number.NaN, Number.NaN)).toBe(false);
  expect(isDeepSubset(1, { a: 1 })).toBe(false);
});

it("takes every key an expected object names, and lets the actual one hold more", () => {
  expect(isDeepSubset({}, { a: 1 })).toBe(true);
  expect(isDeepSubset({ a: 1 }, { a: 1, b: 2 })).toBe(true);
  expect(isDeepSubset({ a: { b: 1 } }, { a: { b: 1, c: 2 }, d: 3 })).toBe(true);
  expect(isDeepSubset({ a: 1 }, { a: 2 })).toBe(false);
  expect(isDeepSubset({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  // a key whose value is undefined is still a key the actual object must have
  expect(isDeepSubset({ a: undefined }, {})).toBe(false);
  expect(isDeepSubset({ a: undefined }, { a: undefined })).toBe(true);
  // an inherited property is not a key of the actual object
  expect(isDeepSubset({ toString: Object.prototype.toString }, {})).toBe(false);
  expect(isDeepSubset({ a: 1 }, null)).toBe(false);
  expect(isDeepSubset({ a: 1 }, "a")).toBe(false);
  expect(isDeepSubset({}, [])).toBe(false);
});

it("takes arrays of the same length, element by element", () => {
  expect(isDeepSubset([], [])).toBe(true);
  expect(isDeepSubset([1, 2], [1, 2])).toBe(true);
  expect(isDeepSubset([{ a: 1 }], [{ a: 1, b: 2 }])).toBe(true);
  expect(isDeepSubset([1], [1, 2])).toBe(false);
  expect(isDeepSubset([1, 2], [1])).toBe(false);
  expect(isDeepSubset([1, 2], [2, 1])).toBe(false);
  expect(isDeepSubset([], {})).toBe(false);
  expect(isDeepSubset([{ a: 1 }], [{ b: 1 }])).toBe(false);
  expect(
    isDeepSubset(
      { callers: [{ id: "x", sites: [{ line: 3 }] }] },
      { callers: [{ id: "x", hop: 1, sites: [{ line: 3, label: "bound" }] }] },
    ),
  ).toBe(true);
});
