// hakutaku's TypeScript resolver, over hand-made path sets: no snapshot and no engine.
import { expect, it } from "vitest";
import { RESOLVE_EXTENSIONS } from "../../../src/export/configs.js";
import {
  resolveTsImport,
  type TsResolution,
} from "../../../src/extract/resolve/ts.js";

const ctx = {
  paths: new Set([
    "web/src/orbits/units.ts",
    "web/src/sky/index.ts",
    "web/src/orbits/kepler.ts",
    "lib/core/src/index.ts",
  ]),
  aliases: { "@obs/web/*": ["web/src/*"] },
  workspaces: new Map([["@obs/core", "lib/core/src/index.ts"]]),
};
it.each<[string, string, TsResolution]>([
  ["web/src/orbits/kepler.ts", "./units", { file: "web/src/orbits/units.ts" }],
  [
    "web/src/orbits/kepler.ts",
    "./units.js",
    { file: "web/src/orbits/units.ts" },
  ],
  ["web/src/orbits/kepler.ts", "../sky", { file: "web/src/sky/index.ts" }],
  [
    "web/src/sky/index.ts",
    "@obs/web/orbits/kepler",
    { file: "web/src/orbits/kepler.ts" },
  ],
  ["web/src/sky/index.ts", "@obs/core", { file: "lib/core/src/index.ts" }],
  ["web/src/sky/index.ts", "fs/promises", { ecosystem: "node", name: "fs" }],
  ["web/src/sky/index.ts", "node:path", { ecosystem: "node", name: "path" }],
  [
    "web/src/sky/index.ts",
    "@types/node",
    { ecosystem: "npm", name: "@types/node" },
  ],
  [
    "web/src/sky/index.ts",
    "react/jsx-runtime",
    { ecosystem: "npm", name: "react" },
  ],
  ["web/src/sky/index.ts", "./missing", null],
])("resolves %s → %s", (from, spec, want) =>
  expect(resolveTsImport(from, spec, ctx)).toEqual(want),
);

// A context over the given paths, with no aliases and no workspaces unless given.
const over = (
  paths: string[],
  aliases: Record<string, string[]> = {},
  workspaces: Array<[string, string]> = [],
) => ({ paths: new Set(paths), aliases, workspaces: new Map(workspaces) });

it("tries a relative specifier as written before its TypeScript twins", () => {
  const both = over(["web/units.js", "web/units.ts"]);
  expect(resolveTsImport("web/kepler.ts", "./units.js", both)).toEqual({
    file: "web/units.js",
  });
});

it.each<[string, string[], string]>([
  // the import's extension, the files present, the one taken: TypeScript's own order
  ["x.js", ["x.ts", "x.tsx", "x.d.ts"], "x.ts"],
  ["x.js", ["x.tsx", "x.d.ts"], "x.tsx"],
  ["x.js", ["x.d.ts"], "x.d.ts"],
  ["x.jsx", ["x.tsx", "x.ts", "x.d.ts"], "x.tsx"],
  ["x.jsx", ["x.ts", "x.d.ts"], "x.ts"],
  ["x.jsx", ["x.d.ts"], "x.d.ts"],
  ["x.mjs", ["x.mts", "x.d.mts"], "x.mts"],
  ["x.mjs", ["x.d.mts", "x.mjs.ts"], "x.d.mts"],
  ["x.cjs", ["x.cts", "x.d.cts"], "x.cts"],
  ["x.cjs", ["x.d.cts", "x.cjs.ts"], "x.d.cts"],
])(
  "swaps ./%s for its TypeScript twin in TypeScript's order, among %j: %s",
  (spec, files, want) => {
    const at = over(files.map((f) => `web/${f}`));
    expect(resolveTsImport("web/a.ts", `./${spec}`, at)).toEqual({
      file: `web/${want}`,
    });
  },
);

it("adds each extension of the generated config's list in its order, then /index with each", () => {
  expect(RESOLVE_EXTENSIONS).toEqual([
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".d.ts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
  ]);
  // with every candidate present, each step takes the first of the list left
  const all = [
    ...RESOLVE_EXTENSIONS.map((e) => `web/sky${e}`),
    ...RESOLVE_EXTENSIONS.map((e) => `web/sky/index${e}`),
  ];
  for (let i = 0; i < all.length; i++) {
    expect(resolveTsImport("web/a.ts", "./sky", over(all.slice(i)))).toEqual({
      file: all[i],
    });
  }
  // a twin comes before the extensions: sky.js swaps to sky.ts, not sky.js.ts
  expect(
    resolveTsImport(
      "web/a.ts",
      "./sky.js",
      over(["web/sky.js.ts", "web/sky.ts"]),
    ),
  ).toEqual({ file: "web/sky.ts" });
});

it("looks only for an index when the specifier names a directory", () => {
  const at = over([
    "web/src.ts",
    "web/src/index.ts",
    "web/src/orbits.ts",
    "web/src/orbits/index.ts",
    "index.ts",
  ]);
  expect(resolveTsImport("web/src/a.ts", ".", at)).toEqual({
    file: "web/src/index.ts",
  });
  expect(resolveTsImport("web/src/a.ts", "./", at)).toEqual({
    file: "web/src/index.ts",
  });
  expect(resolveTsImport("web/src/sky/a.ts", "..", at)).toEqual({
    file: "web/src/index.ts",
  });
  expect(resolveTsImport("web/src/a.ts", "./orbits/", at)).toEqual({
    file: "web/src/orbits/index.ts",
  });
  expect(resolveTsImport("web/src/a.ts", "./orbits", at)).toEqual({
    file: "web/src/orbits.ts",
  });
  // from a file at the repo top
  expect(resolveTsImport("main.ts", ".", at)).toEqual({ file: "index.ts" });
  expect(resolveTsImport("main.ts", "./web/src", at)).toEqual({
    file: "web/src.ts",
  });
});

it("answers null for a relative specifier that leaves the repo or matches nothing", () => {
  const at = over(["web/a.ts", "x.ts"]);
  expect(resolveTsImport("web/a.ts", "../../x", at)).toBeNull();
  expect(resolveTsImport("web/a.ts", "../..", at)).toBeNull();
  expect(resolveTsImport("main.ts", "..", at)).toBeNull();
  expect(resolveTsImport("web/a.ts", "./missing", at)).toBeNull();
  expect(resolveTsImport("web/a.ts", "./missing.js", at)).toBeNull();
  // never a path outside the repo, even one the path list holds
  const outside = over(["../x", "../x.ts", "../index.ts"]);
  expect(resolveTsImport("web/a.ts", "../../x", outside)).toBeNull();
  expect(resolveTsImport("main.ts", "..", outside)).toBeNull();
});

it("takes an exact alias over a pattern, and the pattern with the longest prefix", () => {
  const at = over(
    [
      "lib/web/sky.ts",
      "web/src/sky.ts",
      "web/src/sky/index.ts",
      "web/src/orbits/kepler.ts",
    ],
    {
      "@obs/*": ["lib/*"],
      "@obs/web/*": ["web/src/*"],
      "@obs/web/sky": ["web/src/sky/index.ts"],
    },
  );
  expect(resolveTsImport("a.ts", "@obs/web/sky", at)).toEqual({
    file: "web/src/sky/index.ts",
  });
  expect(resolveTsImport("a.ts", "@obs/web/orbits/kepler", at)).toEqual({
    file: "web/src/orbits/kepler.ts",
  });
  expect(resolveTsImport("a.ts", "@obs/web/sky.js", at)).toEqual({
    file: "web/src/sky.ts",
  });
  // a suffix after the * must match too
  const suffixed = over(["web/src/sky.ts"], { "~/*.js": ["web/src/*.ts"] });
  expect(resolveTsImport("a.ts", "~/sky.js", suffixed)).toEqual({
    file: "web/src/sky.ts",
  });
});

it("tries an alias's targets in order, skipping a key or target with more than one *", () => {
  // x/sky/*.ts is a legal file name, which a two-* target would reach with its first *
  // replaced; @two/sky/ fits @two/*/*'s first two parts
  const at = over(["x/sky/*.ts", "web/src/sky.ts", "web/lib/sky.ts"], {
    "@obs/*": ["x/*/*", "missing/*", "web/src/*", "web/lib/*"],
    "@two/*/*": ["web/src/*"],
  });
  expect(resolveTsImport("a.ts", "@obs/sky", at)).toEqual({
    file: "web/src/sky.ts",
  });
  expect(resolveTsImport("a.ts", "@two/a/sky", at)).toEqual({
    ecosystem: "npm",
    name: "@two/a",
  });
  expect(resolveTsImport("a.ts", "@two/sky/", at)).toEqual({
    ecosystem: "npm",
    name: "@two/sky",
  });
  // an exact key's target is taken as written, so a * in it matches no file
  const exact = over(["web/src/sky.ts", "web/src/index.ts"], {
    "@sky": ["web/src/*"],
  });
  expect(resolveTsImport("a.ts", "@sky", exact)).toBeNull();
});

it("falls through to workspaces and npm when no alias target resolves", () => {
  const at = over(
    ["web/src/sky.ts", "lib/core/src/index.ts"],
    { "@obs/web/*": ["web/src/*"], "@obs/*": ["nowhere/*"] },
    [["@obs/core", "lib/core/src/index.ts"]],
  );
  expect(resolveTsImport("a.ts", "@obs/web/missing", at)).toEqual({
    ecosystem: "npm",
    name: "@obs/web",
  });
  // the longest prefix, @obs/*, takes @obs/core; its target finds nothing; the workspace does
  expect(resolveTsImport("a.ts", "@obs/core", at)).toEqual({
    file: "lib/core/src/index.ts",
  });
});

it("resolves a workspace by its exact name only, and only to a repo file", () => {
  const at = over(["lib/core/src/index.ts"], {}, [
    ["@obs/core", "lib/core/src/index.ts"],
    ["sky-kit", "lib/sky-kit/src/index.ts"],
  ]);
  expect(resolveTsImport("a.ts", "@obs/core", at)).toEqual({
    file: "lib/core/src/index.ts",
  });
  expect(resolveTsImport("a.ts", "@obs/core/orbits", at)).toEqual({
    ecosystem: "npm",
    name: "@obs/core",
  });
  expect(resolveTsImport("a.ts", "sky-kit", at)).toEqual({
    ecosystem: "npm",
    name: "sky-kit",
  });
});

it.each<[string, TsResolution]>([
  ["fs", { ecosystem: "node", name: "fs" }],
  ["fs/promises", { ecosystem: "node", name: "fs" }],
  ["node:fs/promises", { ecosystem: "node", name: "fs" }],
  ["node:test", { ecosystem: "node", name: "test" }],
  ["node:sqlite", { ecosystem: "node", name: "sqlite" }],
  ["test", { ecosystem: "npm", name: "test" }],
  ["sqlite", { ecosystem: "npm", name: "sqlite" }],
  ["node:", null],
])("names %j by Node's built-ins, by top-level name: %j", (spec, want) =>
  expect(resolveTsImport("a.ts", spec, over([]))).toEqual(want),
);

it.each<[string, TsResolution]>([
  ["@scope/name/deep/x.js", { ecosystem: "npm", name: "@scope/name" }],
  ["lodash/fp", { ecosystem: "npm", name: "lodash" }],
  ["lodash.get", { ecosystem: "npm", name: "lodash.get" }],
  ["@scope", null],
  ["@/components/sky", null],
  ["/srv/observatory/sky.js", null],
  ["#internal/sky", null],
  ["file:./sky.js", null],
  ["https://example.org/sky.js", null],
  ["data:text/javascript,export default 1", null],
  ["", null],
])(
  "names %j as an npm package by scope and name or first segment, or nothing: %j",
  (spec, want) => expect(resolveTsImport("a.ts", spec, over([]))).toEqual(want),
);

// Names dependency-cruiser's enhanced-resolve reads as a query (?) or a fragment (#): this
// resolver matches paths as they are written.
const ODD = [
  "sky#1",
  "orbit?2",
  "sky map",
  "50%",
  "x:y",
  "~moon",
  "étoile",
  "trail-",
  "a--b",
];

it.each(ODD)("resolves ./%s to its own file, as it is written", (name) => {
  const at = over([
    ...ODD.map((n) => `web/${n}.ts`),
    "web/sky.ts",
    "web/orbit.ts",
  ]);
  expect(resolveTsImport("web/main.ts", `./${name}`, at)).toEqual({
    file: `web/${name}.ts`,
  });
});

it("takes a file under node_modules as its npm package, never as a repo file", () => {
  const at = over(
    [
      "web/node_modules/@scope/pkg/index.js",
      "node_modules/react/index.js",
      "node_modules/react/node_modules/scheduler/index.js",
    ],
    { "~react": ["node_modules/react/index.js"] },
  );
  expect(
    resolveTsImport("web/a.ts", "./node_modules/@scope/pkg/index.js", at),
  ).toEqual({ ecosystem: "npm", name: "@scope/pkg" });
  expect(
    resolveTsImport(
      "a.ts",
      "./node_modules/react/node_modules/scheduler/index.js",
      at,
    ),
  ).toEqual({ ecosystem: "npm", name: "scheduler" });
  expect(resolveTsImport("a.ts", "~react", at)).toEqual({
    ecosystem: "npm",
    name: "react",
  });
});
