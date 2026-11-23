// A file's colour and size under the Structure lens: the larger its share of the top PageRank,
// the brighter and larger its dot; tests are faint and small.
import { expect, it } from "vitest";
import { F } from "../../../../src/query/view/constants.js";
import {
  fileColor,
  fileSize,
  INK,
} from "../../../../src/viewer/app/map/colors.js";
import { buildModel } from "../../../../src/viewer/app/model.js";
import { tinyModel } from "./helpers.js";
import { syntheticMap } from "./synthetic-map.js";

it("brightens a file by its share of the top PageRank", () => {
  // file i has pagerank 1 / (i + 1): shares 1, 1/12 and 1/13 either side of 0.08, and 1/66 and
  // 1/67 either side of 0.015
  const s = buildModel(syntheticMap(200));
  expect(
    [0, 11, 12, 65, 66].map((i) =>
      fileColor(s, s.production[i], "structure", false),
    ),
  ).toEqual([INK.hi, INK.hi, INK.mid, INK.mid, INK.lo]);
});

it("keeps a share of exactly 0.08 or 0.015 at the dimmer ink", () => {
  const map = syntheticMap(3);
  map.files[1][F.pagerank] = 0.08;
  map.files[2][F.pagerank] = 0.015;
  const s = buildModel(map);
  expect(s.maxPagerank).toBe(1);
  expect([1, 2].map((f) => fileColor(s, f, "structure", false))).toEqual([
    INK.mid,
    INK.lo,
  ]);
});

it("grows a file with the square root of its share", () => {
  const s = buildModel(syntheticMap(200));
  expect(fileSize(s, s.production[0], "structure")).toBeCloseTo(11.2, 12);
  expect(fileSize(s, s.production[3], "structure")).toBeCloseTo(
    2.2 + 9 * Math.sqrt(1 / 4),
    12,
  );
});

it("draws a test faint and small", () => {
  const m = tinyModel();
  expect([
    fileColor(m, 2, "structure", false),
    fileSize(m, 2, "structure"),
  ]).toEqual([INK.faint, 1.6]);
});

it("gives a map with no production file no NaN", () => {
  const e = buildModel(syntheticMap(0, { tests: 2 }));
  expect([
    fileColor(e, e.tests[0], "structure", false),
    fileSize(e, e.tests[0], "structure"),
  ]).toEqual([INK.faint, 1.6]);
  // a production file whose map has a top PageRank of 0 is lo, at the smallest size
  const z = syntheticMap(2);
  for (const f of z.files) f[F.pagerank] = 0;
  const m = buildModel(z);
  expect([
    fileColor(m, 0, "structure", false),
    fileSize(m, 0, "structure"),
  ]).toEqual([INK.lo, 2.2]);
});
