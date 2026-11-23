// Link tokens and selections: every node's token selects it and nothing else, a token for a
// node the map does not hold is refused rather than guessed, tokens and IDs come back from every
// selection, the address keeps its path and query, and each selection climbs to its parent.
import { beforeAll, expect, it } from "vitest";
import { F } from "../../../../src/query/view/constants.js";
import type { MapData } from "../../../../src/query/view/types.js";
import { buildModel, type Model } from "../../../../src/viewer/app/model.js";
import {
  addressFor,
  idOf,
  parentOf,
  selFromToken,
  tokenOf,
} from "../../../../src/viewer/app/routing.js";
import type { Sel } from "../../../../src/viewer/app/state.js";
import { tinyModel } from "./helpers.js";

let m: Model;
beforeAll(() => {
  m = tinyModel();
});

// Every selection of a model: each file and definition, each component and each library.
const everySel = (model: Model): Sel[] => [
  ...model.map.files.map((_, file) => ({ kind: "file" as const, file })),
  ...model.map.defs.file.map((file, def) => ({
    kind: "definition" as const,
    file,
    def,
  })),
  ...model.map.components.map((_, component) => ({
    kind: "component" as const,
    component,
  })),
  ...model.map.externals.map((_, external) => ({
    kind: "library" as const,
    external,
  })),
];

// The tiny map with its files renamed, in the same order.
const renamed = (paths: string[]): Model => {
  const map: MapData = structuredClone(tinyModel().map);
  paths.forEach((path, i) => {
    map.files[i][F.path] = path;
  });
  return buildModel(map);
};

it("every node's token selects it", () => {
  expect(selFromToken(m, "")).toBeNull();
  expect(selFromToken(m, "package.json")).toEqual({ kind: "file", file: 0 });
  expect(selFromToken(m, "src~core~graph.ts")).toEqual({
    kind: "file",
    file: 3,
  });
  expect(selFromToken(m, "src~core~graph.ts--Graph.add")).toEqual({
    kind: "definition",
    file: 3,
    def: 2,
  });
  expect(selFromToken(m, "src~core~graph.ts--helper%282%29")).toEqual({
    kind: "definition",
    file: 3,
    def: 4,
  });
  expect(selFromToken(m, "src~core~")).toEqual({
    kind: "component",
    component: 1,
  });
  expect(selFromToken(m, "npm:kleur")).toEqual({
    kind: "library",
    external: 1,
  });
  expect(selFromToken(m, "node:fs")).toEqual({ kind: "library", external: 0 });
});

it("a module-scope token selects its file", () => {
  expect(selFromToken(m, "src~core~graph.test.ts--%3Cmodule%3E")).toEqual({
    kind: "file",
    file: 2,
  });
  // module scope has no second occurrence, and a file the map does not hold has none at all
  for (const t of [
    "src~core~graph.test.ts--%3Cmodule%3E%282%29",
    "src~core~nope.ts--%3Cmodule%3E",
  ])
    expect(selFromToken(m, t), t).toBe("unknown");
});

it("unknown tokens are reported, not guessed", () => {
  for (const t of [
    "src~core~nope.ts",
    "src~core~graph.ts--nope",
    "npm:left-pad",
    "src~",
    "src~core~graph.ts--helper%283%29",
    "%ZZ",
    "src~core~Graph.ts",
    "src~core~graph.ts--",
  ])
    expect(selFromToken(m, t), t).toBe("unknown");
  // a token is read exactly as it stands: never decoded as a whole, trimmed or case-folded
  for (const t of [
    "src%7Ecore%7Egraph.ts",
    "src/core/graph.ts",
    " src~core~graph.ts",
    "src~core~graph.ts ",
    "src~core~graph.ts#",
    "src~core",
    "npm:kleur~",
    "pypi:kleur",
    "NPM:kleur",
    "src~core~graph.ts--Graph.add--x",
    "src~core~graph.ts--graph.add",
    "src~core~graph.ts--helper%281%29",
  ])
    expect(selFromToken(m, t), t).toBe("unknown");
});

it("tokens and IDs round-trip for every node", () => {
  const sels: Sel[] = everySel(m);
  expect(sels).toHaveLength(5 + 6 + 2 + 2);
  for (const s of sels) {
    const token = tokenOf(m, s);
    if (token === null) throw new Error(`no token for ${JSON.stringify(s)}`);
    expect(selFromToken(m, token)).toEqual(s);
  }
  expect(idOf(m, { kind: "definition", file: 3, def: 4 })).toBe(
    "tiny:src/core/graph.ts#helper(2)",
  );
  expect([
    tokenOf(m, { kind: "group", key: "src" }),
    idOf(m, { kind: "group", key: "src" }),
  ]).toEqual([null, null]);
});

it("names each kind of node by its ID and its token", () => {
  const named = (s: Sel) => [idOf(m, s), tokenOf(m, s)];
  expect(named(null)).toEqual([null, ""]);
  expect(named({ kind: "file", file: 3 })).toEqual([
    "tiny:src/core/graph.ts",
    "src~core~graph.ts",
  ]);
  expect(named({ kind: "definition", file: 3, def: 2 })).toEqual([
    "tiny:src/core/graph.ts#Graph.add",
    "src~core~graph.ts--Graph.add",
  ]);
  expect(named({ kind: "component", component: 0 })).toEqual([
    "tiny:src/cli/",
    "src~cli~",
  ]);
  expect(named({ kind: "library", external: 1 })).toEqual([
    "tiny:npm:kleur",
    "npm:kleur",
  ]);
});

it("the root component is ./, as its ID and its token say", () => {
  const map: MapData = structuredClone(tinyModel().map);
  map.components[0][0] = ".";
  const root = buildModel(map);
  const sel: Sel = { kind: "component", component: 0 };
  expect([idOf(root, sel), tokenOf(root, sel)]).toEqual(["tiny:./", ".~"]);
  expect(selFromToken(root, ".~")).toEqual(sel);
  expect(selFromToken(root, "~")).toBe("unknown");
});

it("hostile and odd paths round-trip through the token", () => {
  const odd = renamed([
    'a b/<x>"&.json',
    "src/c#d%e:f~g/main.ts",
    "src/core/tr-/inner--dash-.test.ts",
    "src/core/\u00fcber/\u00f1.ts",
    "src/core/emoji-\u{1f600}.ts",
  ]);
  for (const s of everySel(odd)) {
    const token = tokenOf(odd, s);
    if (token === null) throw new Error(`no token for ${JSON.stringify(s)}`);
    expect(token, token).toMatch(/^[A-Za-z0-9._~%:-]*$/);
    expect(selFromToken(odd, token), token).toEqual(s);
  }
  expect(tokenOf(odd, { kind: "file", file: 0 })).toBe(
    "a%20b~%3Cx%3E%22%26.json",
  );
  expect(idOf(odd, { kind: "file", file: 1 })).toBe(
    "tiny:src/c%23d%25e%3Af~g/main.ts",
  );
  expect(tokenOf(odd, { kind: "file", file: 2 })).toBe(
    "src~core~tr-~inner%2D-dash-.test.ts",
  );
});

it("addressFor keeps the path and the query", () => {
  expect(addressFor("http://127.0.0.1:5/?s=abc#old", "src~core~graph.ts")).toBe(
    "http://127.0.0.1:5/?s=abc#src~core~graph.ts",
  );
  expect(addressFor("http://127.0.0.1:5/?s=abc#old", "")).toBe(
    "http://127.0.0.1:5/?s=abc",
  );
  expect(addressFor("https://host.example/maps/r/#x", null)).toBe(
    "https://host.example/maps/r/",
  );
  expect(addressFor("file:///tmp/map.html", "npm:kleur")).toBe(
    "file:///tmp/map.html#npm:kleur",
  );
  // only the first "#" starts the fragment, and nothing else is rewritten
  expect(addressFor("http://127.0.0.1:5/a%20b/?s=x#y#z", "q")).toBe(
    "http://127.0.0.1:5/a%20b/?s=x#q",
  );
  expect(addressFor("http://127.0.0.1:5/", null)).toBe("http://127.0.0.1:5/");
});

it("each selection climbs to its parent", () => {
  const up = (s: Sel, g: "component" | "folder" | "language" = "component") =>
    parentOf(m, s, g);
  expect(up({ kind: "definition", file: 3, def: 2 })).toEqual({
    kind: "file",
    file: 3,
  });
  expect(up({ kind: "file", file: 3 })).toEqual({
    kind: "component",
    component: 1,
  });
  expect(up({ kind: "file", file: 2 })).toEqual({
    kind: "component",
    component: 1,
  });
  expect(up({ kind: "file", file: 3 }, "folder")).toEqual({
    kind: "group",
    key: "src",
  });
  expect(up({ kind: "file", file: 1 }, "language")).toEqual({
    kind: "group",
    key: "TypeScript",
  });
  // package.json's group holds no code file, so the map has no hub to climb to
  expect(up({ kind: "file", file: 0 })).toBeNull();
  expect(up({ kind: "file", file: 0 }, "folder")).toBeNull();
  expect(up({ kind: "file", file: 0 }, "language")).toBeNull();
  for (const s of [
    null,
    { kind: "component", component: 1 },
    { kind: "group", key: "src" },
    { kind: "library", external: 0 },
  ] as Sel[])
    expect(up(s), JSON.stringify(s)).toBeNull();
});

it("a code file with no component climbs to the hub of files without one", () => {
  const map: MapData = structuredClone(tinyModel().map);
  map.files[1][F.component] = -1; // src/cli/main.ts
  const loose = buildModel(map);
  expect(parentOf(loose, { kind: "file", file: 1 }, "component")).toEqual({
    kind: "group",
    key: "(none)",
  });
  // package.json now shares that hub
  expect(parentOf(loose, { kind: "file", file: 0 }, "component")).toEqual({
    kind: "group",
    key: "(none)",
  });
});
