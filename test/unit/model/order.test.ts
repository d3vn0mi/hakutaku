import { expect, it } from "vitest";
import { comparePaths } from "../../../src/model/order.js";

it("orders by UTF-16 code units", () =>
  expect(["a/b", "a-b", "Z", "a"].sort(comparePaths)).toEqual([
    "Z",
    "a",
    "a-b",
    "a/b",
  ]));
