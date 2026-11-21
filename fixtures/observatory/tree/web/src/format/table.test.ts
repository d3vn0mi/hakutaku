import { expect, it } from "vitest";
import { formatTable } from "./table";

it("pads each column to its widest cell, numbers on the right", () => {
  const table = formatTable(
    ["name", "magnitude"],
    [
      ["Sirius", "-1.46"],
      ["Vega", "0.03"],
    ],
  );
  expect(table.split("\n")).toEqual([
    "name    magnitude",
    "------  ---------",
    "Sirius      -1.46",
    "Vega         0.03",
  ]);
});
