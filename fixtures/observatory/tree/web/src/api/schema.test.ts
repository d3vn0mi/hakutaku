import { describe, expect, it } from "vitest";
import { parseRecords, recordProblems } from "./schema";

const MARS = { name: "Mars", a: 1.524, e: 0.0934, period: 686.98, m0: 19.4, epoch: "2000-01-01T12:00:00Z" };

describe("schema", () => {
  it("accepts a record of elements", () => {
    expect(recordProblems(MARS)).toEqual([]);
  });

  it("names each bad field", () => {
    expect(recordProblems({ ...MARS, e: 1.2, epoch: "soon" })).toEqual([
      "e: not elliptical",
      "epoch: not a date",
    ]);
  });

  it("refuses a response that is not a list, or holds a bad record", () => {
    expect(() => parseRecords({})).toThrow("not a list");
    expect(() => parseRecords([MARS, { name: "" }])).toThrow(/^record 1: /);
  });
});
