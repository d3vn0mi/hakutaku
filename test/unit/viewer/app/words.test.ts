// Counting words: one thing in the singular, any other number in the plural, and whole numbers
// grouped as en-US writes them.
import { expect, it } from "vitest";
import { count, noun, whole } from "../../../../src/viewer/app/words.js";

it("counts one thing in the singular and any other number in the plural", () => {
  expect([
    count(0, "file"),
    count(1, "file"),
    count(2, "file"),
    count(1, "change"),
    count(1, "importer"),
    count(3, "importer"),
  ]).toEqual([
    "0 files",
    "1 file",
    "2 files",
    "1 change",
    "1 importer",
    "3 importers",
  ]);
});

it("takes the plural it is given", () => {
  expect([
    count(1, "library", "libraries"),
    count(0, "library", "libraries"),
    count(2, "library", "libraries"),
  ]).toEqual(["1 library", "0 libraries", "2 libraries"]);
});

it("gives the word alone, for a number written apart from it", () => {
  expect([
    noun(1, "test"),
    noun(0, "test"),
    noun(2, "entry point"),
    noun(1, "library", "libraries"),
    noun(3, "library", "libraries"),
  ]).toEqual(["test", "tests", "entry points", "library", "libraries"]);
});

it("groups the digits of a whole number as en-US writes them", () => {
  expect([whole(999), whole(1204), whole(20_000), whole(0)]).toEqual([
    "999",
    "1,204",
    "20,000",
    "0",
  ]);
  expect(count(1204, "line")).toBe("1,204 lines");
});
