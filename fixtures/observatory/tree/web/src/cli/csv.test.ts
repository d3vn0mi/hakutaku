import { expect, it } from "vitest";
import { toCsv } from "./csv";

it("quotes only the cells that need it", () => {
  expect(toCsv(["name", "note"], [["Vega", 'the "summer" star, bright']])).toBe(
    'name,note\nVega,"the ""summer"" star, bright"',
  );
});
