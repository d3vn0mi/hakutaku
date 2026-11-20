import { expect, it } from "vitest";
import {
  type QueryCtx,
  type QueryOut,
  queryReferences,
} from "../../../src/query/index.js";
import { openStore, type Store } from "../../../src/store/index.js";
import type { ToolError } from "../../../src/tools/errors.js";
import type {
  LibraryReferencesAnswer,
  ReferencesAnswer,
} from "../../../src/tools/types.js";
import { emptyContent, miniStore } from "../../helpers/mini-store.js";
import { openTiny, TINY_CTX } from "../../helpers/tiny.js";

type Referenced = ReferencesAnswer | LibraryReferencesAnswer;

const answer = (out: QueryOut<Referenced>): Referenced => {
  if (!out.ok) throw new Error(`an error: ${JSON.stringify(out.error)}`);
  return out.answer;
};
const asDef = (out: QueryOut<Referenced>): ReferencesAnswer =>
  answer(out) as ReferencesAnswer;
const error = (out: QueryOut<Referenced>): ToolError => {
  if (out.ok) throw new Error(`an answer: ${JSON.stringify(out.answer)}`);
  return out.error;
};

const s = openTiny();
const ref = (sym: string, q: QueryCtx = TINY_CTX, store: Store = s) =>
  queryReferences(store, { repo: q.repo, symbol: sym, limit: 100 }, q);

it("lists uses that are not calls", () => {
  const a = asDef(ref("lib/orbit.ts#Orbit"));
  expect(Object.keys(a)).toEqual([
    "id",
    "builtCommit",
    "stale",
    "references",
    "view",
  ]);
  expect(a.references).toEqual([
    {
      in: "tiny:app/main.ts#main",
      file: "tiny:app/main.ts",
      line: 7,
      col: 17,
      role: "read",
      test: false,
      text: "const o = new Orbit();",
    },
    {
      in: "tiny:lib/orbit.test.ts#<module>",
      file: "tiny:lib/orbit.test.ts",
      line: 3,
      col: 15,
      role: "read",
      test: true,
      text: "const o = new Orbit(); const c = new Camera();",
    },
  ]);
});

it("answers a library with its importers", () => {
  expect(JSON.stringify(answer(ref("tiny:npm:react")))).toBe(
    JSON.stringify({
      id: "tiny:npm:react",
      kind: "library",
      builtCommit: "0123456789ab",
      stale: false,
      importedBy: { total: 1, top: ["tiny:lib/render.ts"] },
      view: "#npm:react",
    }),
  );
});

it("drops every text when snippets are off", () => {
  expect(
    JSON.stringify(
      answer(ref("lib/orbit.ts#Orbit", { ...TINY_CTX, snippets: false })),
    ),
  ).not.toContain('"text"');
});

it("words each refusal, and passes resolution errors on", () => {
  const refusal = (symbol: string) => {
    const e = error(ref(symbol));
    return [e.code, e.message, e.field, e.hint];
  };
  expect(refusal("lib/orbit.ts")).toEqual([
    "invalid_argument",
    "symbol is a file; code_references takes a definition or a library",
    "symbol",
    "code_deps with direction in lists a file's importers",
  ]);
  expect(refusal("lib/")).toEqual([
    "invalid_argument",
    "symbol is a component; code_references takes a definition or a library",
    "symbol",
    "code_overview describes repos and components",
  ]);
  expect(refusal("tiny:")).toEqual([
    "invalid_argument",
    "symbol is a repo; code_references takes a definition or a library",
    "symbol",
    "code_overview describes repos and components",
  ]);
  expect(error(ref("nope"))).toMatchObject({
    code: "not_found",
    field: "symbol",
  });
});

it("keeps each use's role, and answers a definition nobody uses", () => {
  expect(asDef(ref("lib/body.ts#Body")).references).toEqual([
    {
      in: "tiny:lib/render.ts#draw",
      file: "tiny:lib/render.ts",
      line: 5,
      col: 28,
      role: "type",
      test: false,
      text: "export function draw(body: Body, t: number) {",
    },
  ]);
  expect(asDef(ref("lib/units.ts#toAu"))).toEqual({
    id: "tiny:lib/units.ts#toAu",
    builtCommit: "0123456789ab",
    stale: false,
    references: [],
    view: "#lib~units.ts--toAu",
  });
});

// The ranks store: ten files z/f0.ts … z/f9.ts, ranked against their path order, and a test
// that sorts first by path; each imports left-pad, z/f9.ts twice; three of them use thing.
const R_CTX: QueryCtx = Object.freeze({
  repo: "r",
  builtCommit: "fedcba987654",
  stale: false,
  snippets: true,
});

function rankStore(): Store {
  const c = emptyContent("r");
  const fs = Array.from({ length: 10 }, (_, k) => `z/f${k}.ts`);
  const paths = ["a/x.test.ts", "z/def.ts", ...fs];
  const file = (path: string) => paths.indexOf(path) + 1;
  c.components = ["a/", "z/"].map((path, i) => ({
    id: i + 1,
    path,
    kind: "folder",
    parent_id: null,
    files: i === 0 ? 0 : 11,
    tests: i === 0 ? 1 : 0,
    lines: 9,
  }));
  c.files = paths.map((path, i) => ({
    id: i + 1,
    path,
    lang: "typescript",
    kind: i === 0 ? "test" : "code",
    component_id: i === 0 ? 1 : 2,
    lines: 9,
    bytes: 90,
    blob_sha: "c".repeat(40),
    mode: "100644",
    link_target: null,
    entry: 0,
    has_source: 0,
  }));
  c.file_metrics = fs.map((path, k) => ({
    file_id: file(path),
    pagerank: 0.01,
    dependents_rank: 10 - k,
    fan_in: 0,
    fan_out: 1,
    churn_90d: 0,
    hotspot: 0,
    cycle_id: null,
    core: 0,
    last_change: null,
  }));
  const defs: [string, string, "function" | "module"][] = [
    ["a/x.test.ts", "<module>", "module"],
    ["z/def.ts", "thing", "function"],
    ["z/f0.ts", "<module>", "module"],
    ["z/f9.ts", "<module>", "module"],
  ];
  c.definitions = defs.map(([path, qualname, kind], i) => ({
    id: i + 1,
    file_id: file(path),
    qualname,
    ordinal: 1,
    name: qualname,
    kind,
    start_line: 1,
    start_col: 1,
    end_line: 9,
    end_col: 2,
    exported: 1,
    parent_id: null,
    scip_symbol: null,
    signature: null,
    producer: "ast-grep",
  }));
  c.externals = [{ id: 1, ecosystem: "npm", name: "left-pad", files: 11 }];
  const importers: [string, number][] = [
    ["a/x.test.ts", 1],
    ...fs.map((path): [string, number] => [path, 1]),
    ["z/f9.ts", 2],
  ];
  c.imports = importers.map(([path, line], i) => ({
    id: i + 1,
    src_file_id: file(path),
    dst_file_id: null,
    dst_external_id: 1,
    kind: "static",
    line,
    specifier: "left-pad",
    resolved: 1,
    producer: "dependency-cruiser",
  }));
  c.refs = [
    {
      id: 1,
      file_id: file("a/x.test.ts"),
      line: 2,
      col: 1,
      enclosing_def_id: 1,
      def_id: 2,
      role: "read",
      producer: "scip-typescript",
    },
    {
      id: 2,
      file_id: file("z/f0.ts"),
      line: 2,
      col: 1,
      enclosing_def_id: 3,
      def_id: 2,
      role: "write",
      producer: "scip-typescript",
    },
    {
      id: 3,
      file_id: file("z/f9.ts"),
      line: 3,
      col: 1,
      enclosing_def_id: 4,
      def_id: 2,
      role: "import",
      producer: "scip-typescript",
    },
  ];
  const store = openStore(miniStore(c));
  if ("code" in store) throw new Error(`the ranks store: ${store.reason}`);
  return store;
}

it("orders uses and importers by rank, tests last, and caps a library's importers at 8", () => {
  const rs = rankStore();
  expect(
    asDef(ref("z/def.ts#thing", R_CTX, rs)).references.map((r) => [
      r.in,
      r.role,
      r.test,
    ]),
  ).toEqual([
    ["r:z/f9.ts#<module>", "import", false],
    ["r:z/f0.ts#<module>", "write", false],
    ["r:a/x.test.ts#<module>", "read", true],
  ]);
  expect(answer(ref("r:npm:left-pad", R_CTX, rs))).toEqual({
    id: "r:npm:left-pad",
    kind: "library",
    builtCommit: "fedcba987654",
    stale: false,
    importedBy: {
      total: 11,
      top: [9, 8, 7, 6, 5, 4, 3, 2].map((k) => `r:z/f${k}.ts`),
    },
    view: "#npm:left-pad",
  });
});
