import { expect, it } from "vitest";
import { exportSky } from "./export-sky";

it("prints the brightest stars as CSV", () => {
  const out: string[] = [];
  expect(exportSky(["--csv", "--limit", "2"], (line) => out.push(line))).toBe(0);
  expect(out.join("\n").split("\n")).toEqual([
    "name,ra,dec,magnitude",
    "Sirius,06h 45m 09s,-16d 42m 58s,-1.46 mag",
    "Canopus,06h 23m 57s,-52d 41m 46s,-0.74 mag",
  ]);
});

it("refuses an unknown argument, with the usage", () => {
  const out: string[] = [];
  expect(exportSky(["--json"], (line) => out.push(line))).toBe(2);
  expect(out[0]).toContain('unknown argument "--json"');
  expect(out[0]).toContain("usage: export-sky");
});
