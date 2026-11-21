import { expect, it } from "vitest";
import { legendFor } from "./legend";

it("lists each body in its colour, then the data source", () => {
  const legend = legendFor(["Mars", "Vega"]);
  expect(legend.map((e) => e.label)).toEqual([
    "Mars",
    "Vega",
    "Positions: ephemeris.example.org",
  ]);
  expect(legend[0]?.color).toBe("#c1440e");
});
