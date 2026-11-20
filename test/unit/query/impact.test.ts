import { expect, it } from "vitest";
import type { DefKind, FileKind } from "../../../src/model/index.js";
import {
  type QueryCtx,
  type QueryOut,
  queryImpact,
} from "../../../src/query/index.js";
import { openStore, type Store } from "../../../src/store/index.js";
import type { ToolError } from "../../../src/tools/errors.js";
import type { Checked, ImpactAnswer } from "../../../src/tools/types.js";
import { emptyContent, miniStore } from "../../helpers/mini-store.js";
import { openTiny, TINY_CTX } from "../../helpers/tiny.js";

const answer = (out: QueryOut<ImpactAnswer>): ImpactAnswer => {
  if (!out.ok) throw new Error(`an error: ${JSON.stringify(out.error)}`);
  return out.answer;
};
const error = (out: QueryOut<ImpactAnswer>): ToolError => {
  if (out.ok) throw new Error(`an answer: ${JSON.stringify(out.answer)}`);
  return out.error;
};

type Args = Partial<Checked<"code_impact">> & { target: string };

const s = openTiny();
const im = (a: Args, store: Store = s, q: QueryCtx = TINY_CTX) =>
  queryImpact(
    store,
    { repo: q.repo, depth: 2, include_tests: true, limit: 50, ...a },
    q,
  );

it("follows importers from a file", () => {
  const a = answer(im({ target: "lib/units.ts" }));
  expect(Object.keys(a)).toEqual([
    "id",
    "builtCommit",
    "stale",
    "depth",
    "byHop",
    "counts",
    "blindSpots",
  ]);
  expect(a.byHop).toEqual([
    {
      hop: 1,
      definitions: [],
      files: ["tiny:lib/orbit.ts", "tiny:lib/consts.ts"],
      tests: [],
    },
    {
      hop: 2,
      definitions: [],
      files: ["tiny:lib/render.ts", "tiny:app/main.ts"],
      tests: ["tiny:lib/orbit.test.ts"],
    },
  ]);
  expect(a.counts).toEqual({ definitions: 0, files: 4, tests: 1 });
  expect(a.blindSpots).toEqual([
    "1 dynamic import with a computed path is not followed",
  ]);
});

it("ends at a cycle and at depth 3", () => {
  expect(answer(im({ target: "lib/units.ts", depth: 3 })).byHop[2]).toEqual({
    hop: 3,
    definitions: [],
    files: ["tiny:lib/loader.ts"],
    tests: [],
  });
});

it("follows callers and referrers from a definition", () => {
  expect(answer(im({ target: "lib/orbit.ts#solve" })).byHop).toEqual([
    {
      hop: 1,
      definitions: [
        { id: "tiny:lib/orbit.ts#Orbit.position", label: "bound" },
        { id: "tiny:lib/render.ts#draw", label: "bound" },
        { id: "tiny:app/main.ts#main", label: "bound" },
      ],
      files: ["tiny:lib/render.ts", "tiny:app/main.ts"],
      tests: [],
    },
    {
      hop: 2,
      definitions: [],
      files: [],
      tests: ["tiny:lib/orbit.test.ts"],
    },
  ]);
  expect(answer(im({ target: "lib/orbit.ts#Orbit", depth: 1 })).byHop).toEqual([
    {
      hop: 1,
      definitions: [{ id: "tiny:app/main.ts#main", label: "reference" }],
      files: ["tiny:app/main.ts"],
      tests: ["tiny:lib/orbit.test.ts"],
    },
  ]);
});

it("reports a bound caller of a scoped caller as scoped", () => {
  expect(
    answer(im({ target: "lib/orbit.ts#Orbit.position" })).byHop.map(
      (h) => h.definitions,
    ),
  ).toEqual([
    [{ id: "tiny:lib/render.ts#draw", label: "scoped" }],
    [{ id: "tiny:app/main.ts#main", label: "scoped" }],
  ]);
});

it("keeps the contract's key order, and a reference weakens every link beyond it", () => {
  expect(JSON.stringify(answer(im({ target: "lib/body.ts#Body" })))).toBe(
    JSON.stringify({
      id: "tiny:lib/body.ts#Body",
      builtCommit: "0123456789ab",
      stale: false,
      depth: 2,
      byHop: [
        {
          hop: 1,
          definitions: [{ id: "tiny:lib/render.ts#draw", label: "reference" }],
          files: ["tiny:lib/render.ts"],
          tests: [],
        },
        {
          hop: 2,
          definitions: [{ id: "tiny:app/main.ts#main", label: "reference" }],
          files: ["tiny:app/main.ts"],
          tests: [],
        },
      ],
      counts: { definitions: 2, files: 2, tests: 0 },
      // a definition's blind spots are those of code_callers asked without labels
      blindSpots: [
        '1 dynamic import with a computed path is not followed; ask with labels ["unscoped"] to see name matches',
      ],
    }),
  );
});

it("stops a definition's walk at depth", () => {
  expect(answer(im({ target: "lib/units.ts#toAu", depth: 1 })).byHop).toEqual([
    {
      hop: 1,
      definitions: [{ id: "tiny:lib/orbit.ts#solve", label: "bound" }],
      files: ["tiny:lib/orbit.ts"],
      tests: [],
    },
  ]);
});

it("leaves tests out without include_tests, and lists no empty hop", () => {
  const file = answer(im({ target: "lib/units.ts", include_tests: false }));
  expect(file.byHop.map((h) => h.tests)).toEqual([[], []]);
  expect(file.counts).toEqual({ definitions: 0, files: 4, tests: 0 });
  const solve = answer(
    im({ target: "lib/orbit.ts#solve", include_tests: false }),
  );
  expect(solve.byHop.map((h) => h.hop)).toEqual([1]);
  expect(solve.counts).toEqual({ definitions: 3, files: 2, tests: 0 });
  const orbit = answer(im({ target: "lib/orbit.ts#Orbit", depth: 3 }));
  expect(orbit.depth).toBe(3);
  expect(orbit.byHop.map((h) => h.hop)).toEqual([1]);
});

it("refuses libraries, components and the repo, and passes resolution errors on", () => {
  const refusal = (target: string) => {
    const e = error(im({ target }));
    return [e.code, e.message, e.field, e.hint];
  };
  expect(refusal("tiny:npm:react")).toEqual([
    "invalid_argument",
    "target is a library; code_impact takes a file or a definition",
    "target",
    "code_references lists a library's importers",
  ]);
  expect(refusal("lib/")).toEqual([
    "invalid_argument",
    "target is a component; code_impact takes a file or a definition",
    "target",
    "code_overview describes repos and components",
  ]);
  expect(refusal("tiny:")).toEqual([
    "invalid_argument",
    "target is a repo; code_impact takes a file or a definition",
    "target",
    "code_overview describes repos and components",
  ]);
  expect(error(im({ target: "nope" }))).toMatchObject({
    code: "not_found",
    field: "target",
  });
});

// The impact store. t.ts defines T. a.ts (A, then D, which calls A), b.ts (B, which uses T),
// p.ts (whose top-level code calls T) and c.ts (C, which calls A and B) are ranked against their
// path order. k.json, a config file, imports t.ts; z.ts imports k.json, and holds R, which uses
// p.ts's module row, and X, which calls the test support S. u.test.ts imports s.support.ts and
// calls A; v.test.ts calls B; w.test.ts imports and calls both A and T.
const I_CTX: QueryCtx = Object.freeze({
  repo: "i",
  builtCommit: "fedcba987654",
  stale: false,
  snippets: true,
});

function impactStore(): Store {
  const c = emptyContent("i");
  // path, kind, dependents rank; ids 1.. in this (path) order
  const files: [string, FileKind, number | null][] = [
    ["a.ts", "code", 3],
    ["b.ts", "code", 1],
    ["c.ts", "code", 4],
    ["k.json", "config", null],
    ["p.ts", "code", 2],
    ["s.support.ts", "test-support", null],
    ["t.ts", "code", 5],
    ["u.test.ts", "test", null],
    ["v.test.ts", "test", null],
    ["w.test.ts", "test", null],
    ["z.ts", "code", 6],
  ];
  const file = (path: string) => files.findIndex(([p]) => p === path) + 1;
  c.files = files.map(([path, kind], i) => ({
    id: i + 1,
    path,
    lang: kind === "config" ? null : "typescript",
    kind,
    component_id: null,
    lines: 9,
    bytes: 90,
    blob_sha: "c".repeat(40),
    mode: "100644",
    link_target: null,
    entry: 0,
    has_source: 0,
  }));
  c.file_metrics = files.flatMap(([path, , rank]) =>
    rank === null
      ? []
      : [
          {
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
          },
        ],
  );
  // file, qualname, kind, start line; ids 1.. in this (file, line) order
  const defs: [string, string, DefKind | "module", number][] = [
    ["a.ts", "A", "function", 1],
    ["a.ts", "D", "function", 5],
    ["b.ts", "B", "function", 1],
    ["c.ts", "C", "function", 1],
    ["p.ts", "<module>", "module", 1],
    ["s.support.ts", "S", "function", 1],
    ["t.ts", "T", "function", 1],
    ["u.test.ts", "<module>", "module", 1],
    ["v.test.ts", "<module>", "module", 1],
    ["w.test.ts", "<module>", "module", 1],
    ["z.ts", "R", "function", 1],
    ["z.ts", "X", "function", 5],
  ];
  const def = (path: string, qualname: string) =>
    defs.findIndex(([p, q]) => p === path && q === qualname) + 1;
  c.definitions = defs.map(([path, qualname, kind, line], i) => ({
    id: i + 1,
    file_id: file(path),
    qualname,
    ordinal: 1,
    name: qualname,
    kind,
    start_line: line,
    start_col: 1,
    end_line: line + 3,
    end_col: 2,
    exported: 1,
    parent_id: null,
    scip_symbol: null,
    signature: null,
    producer: "ast-grep",
  }));
  // importing file, imported file, line, specifier
  const imports: [string, string, number, string][] = [
    ["a.ts", "t.ts", 1, "./t"],
    ["b.ts", "t.ts", 1, "./t"],
    ["c.ts", "a.ts", 1, "./a"],
    ["k.json", "t.ts", 1, "./t.ts"],
    ["p.ts", "t.ts", 1, "./t"],
    ["s.support.ts", "t.ts", 1, "./t"],
    ["u.test.ts", "s.support.ts", 1, "./s.support"],
    ["w.test.ts", "a.ts", 1, "./a"],
    ["w.test.ts", "t.ts", 2, "./t"],
    ["z.ts", "k.json", 1, "./k.json"],
  ];
  c.imports = imports.map(([src, dst, line, specifier], i) => ({
    id: i + 1,
    src_file_id: file(src),
    dst_file_id: file(dst),
    dst_external_id: null,
    kind: "static",
    line,
    specifier,
    resolved: 1,
    producer: "dependency-cruiser",
  }));
  // calling file, line, enclosing definition, callee's file and qualname, label
  const calls: [string, number, string, string, string, "bound" | "scoped"][] =
    [
      ["a.ts", 2, "A", "t.ts", "T", "bound"],
      ["a.ts", 6, "D", "a.ts", "A", "bound"],
      ["c.ts", 2, "C", "a.ts", "A", "bound"],
      ["c.ts", 3, "C", "b.ts", "B", "bound"],
      ["p.ts", 2, "<module>", "t.ts", "T", "bound"],
      ["s.support.ts", 2, "S", "t.ts", "T", "scoped"],
      ["u.test.ts", 2, "<module>", "a.ts", "A", "bound"],
      ["v.test.ts", 2, "<module>", "b.ts", "B", "bound"],
      ["w.test.ts", 2, "<module>", "a.ts", "A", "bound"],
      ["w.test.ts", 3, "<module>", "t.ts", "T", "bound"],
      ["z.ts", 6, "X", "s.support.ts", "S", "bound"],
    ];
  c.call_sites = calls.map(([path, line, enclosing, , callee], i) => ({
    id: i + 1,
    file_id: file(path),
    line,
    col: 3,
    enclosing_def_id: def(path, enclosing),
    callee_name: callee,
    receiver_text: null,
    producer: "ast-grep",
  }));
  c.call_targets = calls.map(([, , , path, callee, label], i) => ({
    site_id: i + 1,
    def_id: def(path, callee),
    label,
    collision: 0,
  }));
  c.refs = [
    {
      id: 1,
      file_id: file("b.ts"),
      line: 2,
      col: 10,
      enclosing_def_id: def("b.ts", "B"),
      def_id: def("t.ts", "T"),
      role: "read",
      producer: "scip-typescript",
    },
    {
      id: 2,
      file_id: file("z.ts"),
      line: 2,
      col: 3,
      enclosing_def_id: def("z.ts", "R"),
      def_id: def("p.ts", "<module>"),
      role: "import",
      producer: "scip-typescript",
    },
  ];
  const store = openStore(miniStore(c));
  if ("code" in store) throw new Error(`the impact store: ${store.reason}`);
  return store;
}

const is = impactStore();

it("takes a hop's strongest path, and follows neither a module row nor a test", () => {
  const a = answer(im({ target: "t.ts#T", depth: 3 }, is, I_CTX));
  expect(a.byHop).toEqual([
    {
      hop: 1,
      definitions: [
        { id: "i:b.ts#B", label: "reference" },
        { id: "i:p.ts#<module>", label: "bound" },
        { id: "i:a.ts#A", label: "bound" },
      ],
      files: ["i:b.ts", "i:p.ts", "i:a.ts"],
      tests: ["i:s.support.ts", "i:w.test.ts"],
    },
    {
      hop: 2,
      // C is reached through B as a reference first, then through A as bound
      definitions: [
        { id: "i:a.ts#D", label: "bound" },
        { id: "i:c.ts#C", label: "bound" },
      ],
      files: ["i:c.ts"],
      // v.test.ts is reached first, through B; w.test.ts was listed at hop 1
      tests: ["i:u.test.ts", "i:v.test.ts"],
    },
  ]);
  expect(a.counts).toEqual({ definitions: 5, files: 4, tests: 4 });
});

it("lists every importer of a file, and follows only the production files", () => {
  expect(answer(im({ target: "t.ts", depth: 3 }, is, I_CTX)).byHop).toEqual([
    {
      hop: 1,
      definitions: [],
      files: ["i:b.ts", "i:p.ts", "i:a.ts", "i:k.json"],
      tests: ["i:s.support.ts", "i:w.test.ts"],
    },
    // w.test.ts imports a.ts too, but was listed at hop 1
    { hop: 2, definitions: [], files: ["i:c.ts"], tests: [] },
  ]);
});
