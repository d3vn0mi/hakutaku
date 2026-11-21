import { expect, it } from "vitest";
import type { ImportKind } from "../../../src/model/index.js";
import {
  importBlindSpots,
  type QueryCtx,
  type QueryOut,
  queryDeps,
} from "../../../src/query/index.js";
import { openStore, type Store } from "../../../src/store/index.js";
import type { ToolError } from "../../../src/tools/errors.js";
import type { Checked, DepsAnswer } from "../../../src/tools/types.js";
import { emptyContent, miniStore } from "../../helpers/mini-store.js";
import { openTiny, openTinyResolved, TINY_CTX } from "../../helpers/tiny.js";

const answer = (out: QueryOut<DepsAnswer>): DepsAnswer => {
  if (!out.ok) throw new Error(`an error: ${JSON.stringify(out.error)}`);
  return out.answer;
};
const error = (out: QueryOut<DepsAnswer>): ToolError => {
  if (out.ok) throw new Error(`an answer: ${JSON.stringify(out.answer)}`);
  return out.error;
};

type Args = Partial<Checked<"code_deps">> &
  Pick<Checked<"code_deps">, "file" | "direction">;

const s = openTiny();
const d = (a: Args, store: Store = s, q: QueryCtx = TINY_CTX) =>
  queryDeps(store, { repo: q.repo, transitive: false, limit: 100, ...a }, q);

it("lists a file's imports with their lines and text", () => {
  const a = answer(d({ file: "app/main.ts", direction: "out" }));
  expect(Object.keys(a)).toEqual([
    "id",
    "builtCommit",
    "stale",
    "direction",
    "edges",
    "blindSpots",
    "view",
  ]);
  expect(a.edges).toEqual([
    {
      id: "tiny:lib/orbit.ts",
      kind: "static",
      line: 1,
      specifier: "../lib/orbit",
      text: 'import { Orbit, solve } from "../lib/orbit";',
    },
    {
      id: "tiny:lib/render.ts",
      kind: "static",
      line: 2,
      specifier: "../lib/render",
      text: 'import { draw } from "../lib/render";',
    },
    {
      id: "tiny:node:fs",
      kind: "static",
      line: 3,
      specifier: "node:fs",
      text: 'import { readFileSync } from "node:fs";',
    },
  ]);
  expect(a.view).toBe("#app~main.ts");
});

it("lists importers with the importer's line", () => {
  expect(
    answer(d({ file: "lib/orbit.ts", direction: "in" })).edges.map((e) => [
      e.id,
      e.line,
      e.specifier,
    ]),
  ).toEqual([
    ["tiny:lib/render.ts", 1, "./orbit"],
    ["tiny:app/main.ts", 1, "../lib/orbit"],
    ["tiny:lib/orbit.test.ts", 1, "./orbit"],
  ]);
});

it("follows imports transitively, once each, through a cycle", () => {
  expect(
    answer(
      d({ file: "lib/render.ts", direction: "out", transitive: true }),
    ).edges.map((e) => [e.id, e.hop, e.kind]),
  ).toEqual([
    ["tiny:lib/orbit.ts", 1, "static"],
    ["tiny:lib/body.ts", 1, "type-only"],
    ["tiny:npm:react", 1, "static"],
    ["tiny:lib/units.ts", 2, "static"],
    ["tiny:lib/consts.ts", 3, "static"],
  ]);
});

it("filters by kind and skips unresolved imports", () => {
  expect(
    answer(
      d({ file: "lib/render.ts", direction: "out", kinds: ["type-only"] }),
    ).edges.map((e) => e.id),
  ).toEqual(["tiny:lib/body.ts"]);
  expect(
    answer(d({ file: "lib/loader.ts", direction: "out" })).edges.map(
      (e) => e.id,
    ),
  ).toEqual(["tiny:app/main.ts"]);
});

it("refuses a definition", () => {
  expect(
    error(d({ file: "lib/orbit.ts#solve", direction: "out" })),
  ).toMatchObject({
    code: "invalid_argument",
    field: "file",
    hint: "pass the file that defines it",
  });
});

it("follows importers transitively, and never lists the file it starts from", () => {
  const edges = answer(
    d({ file: "lib/units.ts", direction: "in", transitive: true }),
  ).edges;
  expect(edges.map((e) => [e.id, e.hop, e.line])).toEqual([
    ["tiny:lib/orbit.ts", 1, 1],
    ["tiny:lib/consts.ts", 1, 1],
    ["tiny:lib/render.ts", 2, 1],
    ["tiny:app/main.ts", 2, 1],
    ["tiny:lib/orbit.test.ts", 2, 1],
    ["tiny:lib/loader.ts", 3, 1],
  ]);
  // the text is the importing file's line; lib/consts.ts has no stored source
  expect(JSON.stringify(edges.slice(0, 2))).toBe(
    JSON.stringify([
      {
        id: "tiny:lib/orbit.ts",
        kind: "static",
        line: 1,
        hop: 1,
        specifier: "./units",
        text: 'import { toAu } from "./units";',
      },
      {
        id: "tiny:lib/consts.ts",
        kind: "side-effect",
        line: 1,
        hop: 1,
        specifier: "./units",
      },
    ]),
  );
  // kinds filters importers too: units.ts imports consts.ts statically, so the walk stops
  expect(
    answer(
      d({
        file: "lib/units.ts",
        direction: "in",
        transitive: true,
        kinds: ["side-effect"],
      }),
    ).edges.map((e) => [e.id, e.hop]),
  ).toEqual([["tiny:lib/consts.ts", 1]]);
});

it("drops every text with snippets off, and an empty kinds list allows no edge", () => {
  expect(
    JSON.stringify(
      answer(
        d({ file: "app/main.ts", direction: "out" }, s, {
          ...TINY_CTX,
          snippets: false,
        }),
      ),
    ),
  ).not.toContain('"text"');
  expect(
    answer(d({ file: "app/main.ts", direction: "out", kinds: [] })).edges,
  ).toEqual([]);
});

it("words each refusal, and passes resolution errors on", () => {
  const refusal = (file: string) => {
    const e = error(d({ file, direction: "out" }));
    return [e.code, e.message, e.field, e.hint];
  };
  expect(refusal("lib/orbit.ts#solve")).toEqual([
    "invalid_argument",
    "file is a definition; code_deps takes a file",
    "file",
    "pass the file that defines it",
  ]);
  expect(refusal("tiny:npm:react")).toEqual([
    "invalid_argument",
    "file is a library; code_deps takes a file",
    "file",
    "code_references lists a library's importers",
  ]);
  expect(refusal("lib/")).toEqual([
    "invalid_argument",
    "file is a component; code_deps takes a file",
    "file",
    "code_overview describes repos and components",
  ]);
  expect(refusal("tiny:")).toEqual([
    "invalid_argument",
    "file is a repo; code_deps takes a file",
    "file",
    "code_overview describes repos and components",
  ]);
  expect(error(d({ file: "nope", direction: "in" }))).toMatchObject({
    code: "not_found",
    field: "file",
  });
});

// The fan store. s.ts imports y.ts, a.ts twice (a type-only row, then a static one), b.ts, x.ts
// and two externals, each on its own line; a.ts and b.ts both import c.ts, which imports s.ts.
// b.ts and a.ts are ranked against their path order; x.ts and y.ts have no rank.
const D_CTX: QueryCtx = Object.freeze({
  repo: "d",
  builtCommit: "fedcba987654",
  stale: false,
  snippets: true,
});

function fanStore(): Store {
  const c = emptyContent("d");
  const paths = ["a.ts", "b.ts", "c.ts", "s.ts", "x.ts", "y.ts"];
  const file = (path: string) => paths.indexOf(path) + 1;
  const sources = new Map([
    [
      "b.ts",
      ["export const b = 1;", "", "", "", "", "", 'export * from "./c.js";'],
    ],
    [
      "s.ts",
      [
        'import { y } from "./y";',
        'import type { A } from "./a";',
        'import alpha from "alpha";',
        'import { a } from "./a";',
        'import { b } from "./b";',
        'import { x } from "./x";',
        'import { readFileSync } from "node:fs";',
      ],
    ],
  ]);
  c.files = paths.map((path, i) => ({
    id: i + 1,
    path,
    lang: "typescript",
    kind: "code",
    component_id: null,
    lines: 7,
    bytes: 70,
    blob_sha: "c".repeat(40),
    mode: "100644",
    link_target: null,
    entry: 0,
    has_source: sources.has(path) ? 1 : 0,
  }));
  c.sources = [...sources].map(([path, lines]) => ({
    file_id: file(path),
    text: lines.join("\n"),
  }));
  const ranks: [string, number][] = [
    ["a.ts", 2],
    ["b.ts", 1],
    ["c.ts", 3],
    ["s.ts", 4],
  ];
  c.file_metrics = ranks.map(([path, rank]) => ({
    file_id: file(path),
    pagerank: 0.1,
    dependents_rank: rank,
    fan_in: 1,
    fan_out: 1,
    churn_90d: 0,
    hotspot: 0,
    cycle_id: null,
    core: 0,
    last_change: null,
  }));
  c.externals = [
    { id: 1, ecosystem: "node", name: "fs", files: 1 },
    { id: 2, ecosystem: "npm", name: "alpha", files: 1 },
  ];
  // importing file, imported file or external, kind, line, specifier
  const imports: [string, string | number, ImportKind, number, string][] = [
    ["a.ts", "c.ts", "static", 1, "./c"],
    ["b.ts", "c.ts", "re-export", 7, "./c.js"],
    ["c.ts", "s.ts", "static", 1, "./s"],
    ["s.ts", "y.ts", "static", 1, "./y"],
    ["s.ts", "a.ts", "type-only", 2, "./a"],
    ["s.ts", 2, "static", 3, "alpha"],
    ["s.ts", "a.ts", "static", 4, "./a"],
    ["s.ts", "b.ts", "static", 5, "./b"],
    ["s.ts", "x.ts", "static", 6, "./x"],
    ["s.ts", 1, "static", 7, "node:fs"],
  ];
  c.imports = imports.map(([src, dst, kind, line, specifier], i) => ({
    id: i + 1,
    src_file_id: file(src),
    dst_file_id: typeof dst === "string" ? file(dst) : null,
    dst_external_id: typeof dst === "number" ? dst : null,
    kind,
    line,
    specifier,
    resolved: 1,
    producer: "dependency-cruiser",
  }));
  const store = openStore(miniStore(c));
  if ("code" in store) throw new Error(`the fan store: ${store.reason}`);
  return store;
}

const ds = fanStore();

it("orders edges by rank, files without a rank, then externals, one per import row", () => {
  expect(
    answer(d({ file: "s.ts", direction: "out" }, ds, D_CTX)).edges.map((e) => [
      e.id,
      e.line,
      e.kind,
    ]),
  ).toEqual([
    ["d:b.ts", 5, "static"],
    ["d:a.ts", 2, "type-only"],
    ["d:a.ts", 4, "static"],
    ["d:x.ts", 6, "static"],
    ["d:y.ts", 1, "static"],
    ["d:node:fs", 7, "static"],
    ["d:npm:alpha", 3, "static"],
  ]);
});

it("keeps the first edge that reaches a node, in the answer's order", () => {
  const out = answer(
    d({ file: "s.ts", direction: "out", transitive: true }, ds, D_CTX),
  ).edges;
  expect(out.map((e) => [e.id, e.hop, e.line, e.kind])).toEqual([
    ["d:b.ts", 1, 5, "static"],
    ["d:a.ts", 1, 2, "type-only"],
    ["d:x.ts", 1, 6, "static"],
    ["d:y.ts", 1, 1, "static"],
    ["d:node:fs", 1, 7, "static"],
    ["d:npm:alpha", 1, 3, "static"],
    ["d:c.ts", 2, 7, "re-export"],
  ]);
  // b.ts ranks before a.ts, so c.ts is reached through b.ts's line 7, not a.ts's line 1
  expect(JSON.stringify(out.at(-1))).toBe(
    JSON.stringify({
      id: "d:c.ts",
      kind: "re-export",
      line: 7,
      hop: 2,
      specifier: "./c.js",
      text: 'export * from "./c.js";',
    }),
  );
  expect(
    answer(
      d(
        { file: "s.ts", direction: "out", transitive: true, kinds: ["static"] },
        ds,
        D_CTX,
      ),
    ).edges.map((e) => [e.id, e.hop, e.line]),
  ).toEqual([
    ["d:b.ts", 1, 5],
    ["d:a.ts", 1, 4],
    ["d:x.ts", 1, 6],
    ["d:y.ts", 1, 1],
    ["d:node:fs", 1, 7],
    ["d:npm:alpha", 1, 3],
    ["d:c.ts", 2, 1],
  ]);
  expect(
    answer(
      d({ file: "c.ts", direction: "in", transitive: true }, ds, D_CTX),
    ).edges.map((e) => [e.id, e.hop, e.line]),
  ).toEqual([
    ["d:b.ts", 1, 7],
    ["d:a.ts", 1, 1],
    ["d:s.ts", 2, 5],
  ]);
});

const COMPUTED = "1 dynamic import with a computed path is not followed";
const DENIED = "1 denylisted file is left out of the map, with its imports";
const UNRESOLVED_ONE =
  "1 relative import did not resolve to a file and is not an edge";

it("names the computed imports a TypeScript or JavaScript file's edges miss, either way", () => {
  expect(
    answer(d({ file: "app/main.ts", direction: "out" })).blindSpots,
  ).toEqual([COMPUTED, DENIED]);
  expect(
    answer(d({ file: "lib/units.ts", direction: "in", transitive: true }))
      .blindSpots,
  ).toEqual([COMPUTED, DENIED]);
  expect(importBlindSpots(s, "javascript")).toEqual([COMPUTED, DENIED]);
  // a Python or shell file has no computed-import line
  expect(
    answer(d({ file: "py/pkg/util.py", direction: "in" })).blindSpots,
  ).toEqual([DENIED]);
  expect(
    answer(d({ file: "scripts/sync-", direction: "out" })).blindSpots,
  ).toEqual([DENIED]);
  const two = openTiny({ coverage: { computedImports: 2 } });
  expect(
    answer(d({ file: "app/main.ts", direction: "out" }, two)).blindSpots,
  ).toEqual([
    "2 dynamic imports with a computed path are not followed",
    DENIED,
  ]);
});

it("names the relative imports that did not resolve, for any file", () => {
  const one = openTiny({ coverage: { unresolvedImports: 1, denied: 0 } });
  const three = openTiny({ coverage: { unresolvedImports: 3, denied: 0 } });
  expect(
    answer(d({ file: "app/main.ts", direction: "out" }, one)).blindSpots,
  ).toEqual([COMPUTED, UNRESOLVED_ONE]);
  expect(
    answer(d({ file: "scripts/sync-", direction: "in" }, three)).blindSpots,
  ).toEqual(["3 relative imports did not resolve to a file and are not edges"]);
});

it("names how a Python file's imports were read, when grimp did not read them", () => {
  const own = openTiny({
    coverage: { pythonResolver: "hakutaku-resolver", denied: 0 },
  });
  const none = openTiny({ coverage: { pythonResolver: "none", denied: 0 } });
  const py = { file: "py/pkg/__init__.py", direction: "out" } as const;
  expect(answer(d(py, own)).blindSpots).toEqual([
    "Python imports come from hakutaku's own resolver, because grimp did not run",
  ]);
  expect(answer(d(py, none)).blindSpots).toEqual([
    "Python imports were not read in this build",
  ]);
  // only a Python file's answer says so
  expect(
    answer(d({ file: "app/main.ts", direction: "out" }, none)).blindSpots,
  ).toEqual([COMPUTED]);
});

it("counts the Python files with imports from hakutaku's own resolver, when grimp ran", () => {
  const py = { file: "py/pkg/__init__.py", direction: "out" } as const;
  const clean = { coverage: { denied: 0 } };
  // two imports of one file count once, and app/main.ts's imports are no Python file's
  const one = openTinyResolved({ python: 1, typescript: true }, clean);
  expect(answer(d(py, one)).blindSpots).toEqual([
    "1 Python file has imports that come from hakutaku's own resolver, not grimp",
  ]);
  const two = openTinyResolved(
    { python: 2 },
    { coverage: { unresolvedImports: 1, denied: 3 } },
  );
  expect(
    answer(d({ file: "py/pkg/util.py", direction: "in" }, two)).blindSpots,
  ).toEqual([
    UNRESOLVED_ONE,
    "2 Python files have imports that come from hakutaku's own resolver, not grimp",
    "3 denylisted files are left out of the map, with their imports",
  ]);
  // never on another language's answer
  expect(
    answer(d({ file: "app/main.ts", direction: "out" }, one)).blindSpots,
  ).toEqual([COMPUTED]);
  expect(importBlindSpots(one, "shell")).toEqual([]);
});

it("leaves that count out where grimp did not run, or no Python file has such imports", () => {
  const py = { file: "py/pkg/__init__.py", direction: "out" } as const;
  const own = openTinyResolved(
    { python: 2 },
    { coverage: { pythonResolver: "hakutaku-resolver", denied: 0 } },
  );
  expect(answer(d(py, own)).blindSpots).toEqual([
    "Python imports come from hakutaku's own resolver, because grimp did not run",
  ]);
  const none = openTinyResolved(
    { python: 2 },
    { coverage: { pythonResolver: "none", denied: 0 } },
  );
  expect(answer(d(py, none)).blindSpots).toEqual([
    "Python imports were not read in this build",
  ]);
  const scripts = openTinyResolved(
    { python: 0, typescript: true },
    { coverage: { denied: 0 } },
  );
  expect(answer(d(py, scripts)).blindSpots).toEqual([]);
});

it("names the denylisted files left out with their imports", () => {
  expect(
    answer(d({ file: "lib/orbit.ts", direction: "in" })).blindSpots,
  ).toEqual([COMPUTED, DENIED]);
  const four = openTiny({ coverage: { computedImports: 0, denied: 4 } });
  expect(
    answer(d({ file: "lib/orbit.ts", direction: "in" }, four)).blindSpots,
  ).toEqual(["4 denylisted files are left out of the map, with their imports"]);
});

it("keeps one order, computed, unresolved, Python, denylisted, and answers none when nothing applies", () => {
  const all = openTiny({
    coverage: {
      computedImports: 2,
      unresolvedImports: 1,
      pythonResolver: "none",
      denied: 3,
    },
  });
  const many = "3 denylisted files are left out of the map, with their imports";
  expect(
    answer(d({ file: "app/main.ts", direction: "out" }, all)).blindSpots,
  ).toEqual([
    "2 dynamic imports with a computed path are not followed",
    UNRESOLVED_ONE,
    many,
  ]);
  expect(
    answer(d({ file: "py/pkg/util.py", direction: "in" }, all)).blindSpots,
  ).toEqual([
    UNRESOLVED_ONE,
    "Python imports were not read in this build",
    many,
  ]);
  const clean = openTiny({ coverage: { computedImports: 0, denied: 0 } });
  for (const file of ["app/main.ts", "py/pkg/util.py", "scripts/sync-"]) {
    expect(answer(d({ file, direction: "out" }, clean)).blindSpots).toEqual([]);
  }
  expect(
    answer(d({ file: "s.ts", direction: "out" }, ds, D_CTX)).blindSpots,
  ).toEqual([]);
});
