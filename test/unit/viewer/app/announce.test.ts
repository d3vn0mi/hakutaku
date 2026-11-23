// What the live region says for each selection: its kind, its name, and where it stands.
import { beforeAll, expect, it } from "vitest";
import { F, FILE_KINDS } from "../../../../src/query/view/constants.js";
import type { MapData } from "../../../../src/query/view/types.js";
import { announcement } from "../../../../src/viewer/app/announce.js";
import { buildModel, type Model } from "../../../../src/viewer/app/model.js";
import { tinyModel } from "./helpers.js";

let m: Model;
beforeAll(() => {
  m = tinyModel();
});

it("names a production file with its rank among the code files", () => {
  expect(announcement(m, { kind: "file", file: 3 }, "component")).toBe(
    "Selected file src/core/graph.ts, rank 1 of 3.",
  );
  expect(announcement(m, { kind: "file", file: 1 }, "folder")).toBe(
    "Selected file src/cli/main.ts, rank 3 of 3.",
  );
});

it("names a test file, and a file off the map, without a rank", () => {
  expect(announcement(m, { kind: "file", file: 2 }, "component")).toBe(
    "Selected test file src/core/graph.test.ts.",
  );
  expect(announcement(m, { kind: "file", file: 0 }, "component")).toBe(
    "Selected file package.json.",
  );
  // a file only tests import is drawn among the tests, and named as one
  const map: MapData = structuredClone(m.map);
  map.files[2][F.kind] = FILE_KINDS.indexOf("test-support");
  expect(
    announcement(buildModel(map), { kind: "file", file: 2 }, "component"),
  ).toBe("Selected test file src/core/graph.test.ts.");
});

it("names a definition with its file and line", () => {
  expect(
    announcement(m, { kind: "definition", file: 3, def: 2 }, "component"),
  ).toBe("Selected definition Graph.add in src/core/graph.ts, line 9.");
  expect(
    announcement(m, { kind: "definition", file: 3, def: 4 }, "component"),
  ).toBe("Selected definition helper in src/core/graph.ts, line 35.");
});

it("names a component, or a group of another grouping, with its code files", () => {
  expect(
    announcement(m, { kind: "component", component: 1 }, "component"),
  ).toBe("Selected component src/core, 2 code files.");
  expect(
    announcement(m, { kind: "component", component: 0 }, "component"),
  ).toBe("Selected component src/cli, 1 code file.");
  expect(announcement(m, { kind: "group", key: "src" }, "folder")).toBe(
    "Selected folder src, 3 code files.",
  );
  expect(
    announcement(m, { kind: "group", key: "TypeScript" }, "language"),
  ).toBe("Selected language TypeScript, 3 code files.");
  expect(announcement(m, { kind: "group", key: "(none)" }, "component")).toBe(
    "Selected component (none), 0 code files.",
  );
});

it("names a library with its ecosystem and its importers", () => {
  expect(announcement(m, { kind: "library", external: 1 }, "component")).toBe(
    "Selected library npm:kleur, imported by 1 file.",
  );
  expect(announcement(m, { kind: "library", external: 0 }, "component")).toBe(
    "Selected library node:fs, imported by 1 file.",
  );
});

it("says nothing when nothing is selected", () => {
  expect(announcement(m, null, "component")).toBe("");
});
