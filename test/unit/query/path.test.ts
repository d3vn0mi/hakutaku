import { expect, it } from "vitest";
import type { ImportKind } from "../../../src/model/index.js";
import {
  type QueryCtx,
  type QueryOut,
  queryPath,
} from "../../../src/query/index.js";
import { openStore, type Store } from "../../../src/store/index.js";
import type { ToolError } from "../../../src/tools/errors.js";
import type { Checked, PathAnswer } from "../../../src/tools/types.js";
import { emptyContent, miniStore } from "../../helpers/mini-store.js";
import { openTiny, TINY_CTX } from "../../helpers/tiny.js";

const answer = (out: QueryOut<PathAnswer>): PathAnswer => {
  if (!out.ok) throw new Error(`an error: ${JSON.stringify(out.error)}`);
  return out.answer;
};
const error = (out: QueryOut<PathAnswer>): ToolError => {
  if (out.ok) throw new Error(`an answer: ${JSON.stringify(out.answer)}`);
  return out.error;
};

type Args = Partial<Checked<"code_path">> &
  Pick<Checked<"code_path">, "from" | "to">;

const s = openTiny();
const p = (a: Args, store: Store = s, q: QueryCtx = TINY_CTX) =>
  queryPath(store, { repo: q.repo, via: "imports", ...a }, q);

it("finds the shortest import path, each hop with its line", () => {
  const a = answer(p({ from: "lib/orbit.test.ts", to: "lib/consts.ts" }));
  expect(Object.keys(a)).toEqual([
    "from",
    "to",
    "via",
    "builtCommit",
    "stale",
    "found",
    "hops",
    "view",
  ]);
  expect(a.hops).toEqual([
    {
      from: "tiny:lib/orbit.test.ts",
      to: "tiny:lib/orbit.ts",
      kind: "static",
      line: 1,
      text: 'import { Orbit } from "./orbit";',
    },
    {
      from: "tiny:lib/orbit.ts",
      to: "tiny:lib/units.ts",
      kind: "static",
      line: 1,
      text: 'import { toAu } from "./units";',
    },
    {
      from: "tiny:lib/units.ts",
      to: "tiny:lib/consts.ts",
      kind: "static",
      line: 1,
    },
  ]);
  expect(a.view).toBe("#lib~orbit.test.ts");
});

it("answers found false through a cycle, and refuses unknown endpoints", () => {
  expect(answer(p({ from: "lib/consts.ts", to: "app/main.ts" }))).toMatchObject(
    { found: false, hops: [] },
  );
  expect(error(p({ from: "lib/consts.ts", to: "lib/nope.ts" }))).toMatchObject({
    code: "not_found",
    field: "to",
  });
  expect(answer(p({ from: "lib/units.ts", to: "lib/units.ts" }))).toMatchObject(
    { found: true, hops: [] },
  );
});

it("follows calls between definitions", () => {
  expect(
    answer(
      p({ from: "app/main.ts#main", to: "lib/units.ts#toAu", via: "calls" }),
    ).hops,
  ).toEqual([
    {
      from: "tiny:app/main.ts#main",
      to: "tiny:lib/orbit.ts#solve",
      kind: "bound",
      line: 6,
      text: "solve(1);",
    },
    {
      from: "tiny:lib/orbit.ts#solve",
      to: "tiny:lib/units.ts#toAu",
      kind: "bound",
      line: 6,
      text: "return toAu(e);",
    },
  ]);
  expect(
    error(p({ from: "app/main.ts", to: "lib/units.ts#toAu", via: "calls" })),
  ).toMatchObject({
    field: "from",
    hint: "via calls takes definitions; pass path#name",
  });
});

it("reaches a library through the imports that lead to it", () => {
  expect(answer(p({ from: "app/main.ts", to: "tiny:node:fs" }))).toEqual({
    from: "tiny:app/main.ts",
    to: "tiny:node:fs",
    via: "imports",
    builtCommit: "0123456789ab",
    stale: false,
    found: true,
    hops: [
      {
        from: "tiny:app/main.ts",
        to: "tiny:node:fs",
        kind: "static",
        line: 3,
        text: 'import { readFileSync } from "node:fs";',
      },
    ],
    view: "#app~main.ts",
  });
  expect(answer(p({ from: "app/main.ts", to: "tiny:npm:react" })).hops).toEqual(
    [
      {
        from: "tiny:app/main.ts",
        to: "tiny:lib/render.ts",
        kind: "static",
        line: 2,
        text: 'import { draw } from "../lib/render";',
      },
      {
        from: "tiny:lib/render.ts",
        to: "tiny:npm:react",
        kind: "static",
        line: 3,
        text: 'import { memo } from "react";',
      },
    ],
  );
  expect(
    answer(p({ from: "lib/orbit.test.ts", to: "tiny:npm:react" })),
  ).toMatchObject({ found: false, hops: [] });
});

it("answers a call path's from, to, via and view, and found false when no call leads there", () => {
  const a = answer(
    p({ from: "lib/orbit.ts#solve", to: "lib/units.ts#toAu", via: "calls" }),
  );
  expect(JSON.stringify(a)).toBe(
    JSON.stringify({
      from: "tiny:lib/orbit.ts#solve",
      to: "tiny:lib/units.ts#toAu",
      via: "calls",
      builtCommit: "0123456789ab",
      stale: false,
      found: true,
      hops: [
        {
          from: "tiny:lib/orbit.ts#solve",
          to: "tiny:lib/units.ts#toAu",
          kind: "bound",
          line: 6,
          text: "return toAu(e);",
        },
      ],
      view: "#lib~orbit.ts--solve",
    }),
  );
  expect(
    answer(
      p({ from: "lib/units.ts#toAu", to: "app/main.ts#main", via: "calls" }),
    ),
  ).toMatchObject({ found: false, hops: [] });
  expect(
    answer(
      p({ from: "lib/orbit.ts#solve", to: "lib/orbit.ts#solve", via: "calls" }),
    ),
  ).toMatchObject({ found: true, hops: [] });
});

it("drops every text with snippets off", () => {
  const off = { ...TINY_CTX, snippets: false };
  const imports = answer(
    p({ from: "lib/orbit.test.ts", to: "lib/consts.ts" }, s, off),
  );
  const calls = answer(
    p(
      { from: "app/main.ts#main", to: "lib/units.ts#toAu", via: "calls" },
      s,
      off,
    ),
  );
  expect(imports.hops).toHaveLength(3);
  expect(calls.hops).toHaveLength(2);
  expect(JSON.stringify([imports, calls])).not.toContain('"text"');
});

it("words each refusal, and checks from before to", () => {
  const refusal = (a: Args) => {
    const e = error(p(a));
    return [e.code, e.message, e.field, e.hint];
  };
  const viaImports = "via imports takes files; pass via calls for definitions";
  const viaCalls = "via calls takes definitions; pass path#name";
  const other = "code_path takes files or definitions";
  expect(refusal({ from: "lib/orbit.ts#solve", to: "lib/units.ts" })).toEqual([
    "invalid_argument",
    "from is a definition; code_path takes a file via imports",
    "from",
    viaImports,
  ]);
  expect(refusal({ from: "lib/orbit.ts", to: "lib/units.ts#toAu" })).toEqual([
    "invalid_argument",
    "to is a definition; code_path takes a file or a library via imports",
    "to",
    viaImports,
  ]);
  expect(refusal({ from: "lib/", to: "lib/units.ts" })).toEqual([
    "invalid_argument",
    "from is a component; code_path takes a file via imports",
    "from",
    other,
  ]);
  expect(refusal({ from: "tiny:npm:react", to: "lib/units.ts" })).toEqual([
    "invalid_argument",
    "from is a library; code_path takes a file via imports",
    "from",
    other,
  ]);
  expect(refusal({ from: "lib/orbit.ts", to: "tiny:" })).toEqual([
    "invalid_argument",
    "to is a repo; code_path takes a file or a library via imports",
    "to",
    other,
  ]);
  expect(
    refusal({ from: "app/main.ts#main", to: "lib/units.ts", via: "calls" }),
  ).toEqual([
    "invalid_argument",
    "to is a file; code_path takes a definition via calls",
    "to",
    viaCalls,
  ]);
  expect(
    refusal({ from: "app/main.ts#main", to: "tiny:npm:react", via: "calls" }),
  ).toEqual([
    "invalid_argument",
    "to is a library; code_path takes a definition via calls",
    "to",
    other,
  ]);
  expect(
    refusal({ from: "lib/", to: "app/main.ts#main", via: "calls" }),
  ).toEqual([
    "invalid_argument",
    "from is a component; code_path takes a definition via calls",
    "from",
    other,
  ]);
  // from is checked whole before to is resolved, and a kind is checked before the same node
  expect(refusal({ from: "lib/", to: "lib/nope.ts" })[2]).toBe("from");
  expect(error(p({ from: "lib/nope.ts", to: "lib/" }))).toMatchObject({
    code: "not_found",
    field: "from",
  });
  expect(refusal({ from: "lib/", to: "lib/" })[1]).toBe(
    "from is a component; code_path takes a file via imports",
  );
  expect(
    error(p({ from: "other:lib/orbit.ts", to: "lib/units.ts" })),
  ).toMatchObject({ code: "invalid_argument", field: "from" });
});

// The diamond store. s.ts imports z.ts on line 1, a.ts as a type on line 2 and again on line 4,
// and a module it could not resolve on line 3; a.ts and z.ts both import t.ts.
const P_CTX: QueryCtx = Object.freeze({
  repo: "p",
  builtCommit: "fedcba987654",
  stale: false,
  snippets: true,
});

function diamondStore(): Store {
  const c = emptyContent("p");
  const paths = ["a.ts", "s.ts", "t.ts", "z.ts"];
  const file = (path: string) => paths.indexOf(path) + 1;
  c.files = paths.map((path, i) => ({
    id: i + 1,
    path,
    lang: "typescript",
    kind: "code",
    component_id: null,
    lines: 4,
    bytes: 40,
    blob_sha: "c".repeat(40),
    mode: "100644",
    link_target: null,
    entry: 0,
    has_source: 0,
  }));
  // importing file, imported file (null: unresolved), kind, line, specifier
  const imports: [string, string | null, ImportKind, number, string][] = [
    ["a.ts", "t.ts", "static", 1, "./t"],
    ["s.ts", "z.ts", "static", 1, "./z"],
    ["s.ts", "a.ts", "type-only", 2, "./a"],
    ["s.ts", null, "static", 3, "./gone"],
    ["s.ts", "a.ts", "static", 4, "./a"],
    ["z.ts", "t.ts", "static", 1, "./t"],
  ];
  c.imports = imports.map(([src, dst, kind, line, specifier], i) => ({
    id: i + 1,
    src_file_id: file(src),
    dst_file_id: dst === null ? null : file(dst),
    dst_external_id: null,
    kind,
    line,
    specifier,
    resolved: dst === null ? 0 : 1,
    producer: "dependency-cruiser",
  }));
  const store = openStore(miniStore(c));
  if ("code" in store) throw new Error(`the diamond store: ${store.reason}`);
  return store;
}

it("expands imports in the order of the node they lead to, then line", () => {
  const ps = diamondStore();
  expect(answer(p({ from: "s.ts", to: "t.ts" }, ps, P_CTX)).hops).toEqual([
    { from: "p:s.ts", to: "p:a.ts", kind: "type-only", line: 2 },
    { from: "p:a.ts", to: "p:t.ts", kind: "static", line: 1 },
  ]);
  expect(answer(p({ from: "t.ts", to: "s.ts" }, ps, P_CTX))).toMatchObject({
    found: false,
    hops: [],
  });
});

// The callee store. s.ts#F calls H (in b.ts) on line 2, and G (in a.ts) on lines 3 (scoped), 5
// and 7 (both bound); G calls T scoped, and H calls T bound.
const C_CTX: QueryCtx = Object.freeze({
  repo: "c",
  builtCommit: "fedcba987654",
  stale: false,
  snippets: true,
});

function calleeStore(): Store {
  const c = emptyContent("c");
  const sources = new Map([
    ["a.ts", ["export function G() {", "  T();", "}"]],
    [
      "s.ts",
      [
        "export function F() {",
        "  H();",
        "  g.G();",
        "",
        "  G();",
        "",
        "  G(1);",
        "}",
      ],
    ],
  ]);
  const paths = ["a.ts", "b.ts", "s.ts", "t.ts"];
  const file = (path: string) => paths.indexOf(path) + 1;
  c.files = paths.map((path, i) => ({
    id: i + 1,
    path,
    lang: "typescript",
    kind: "code",
    component_id: null,
    lines: 8,
    bytes: 80,
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
  // file, qualname, start line, end line
  const defs: [string, string, number, number][] = [
    ["a.ts", "G", 1, 3],
    ["b.ts", "H", 1, 3],
    ["s.ts", "F", 1, 8],
    ["t.ts", "T", 1, 2],
  ];
  c.definitions = defs.map(([path, qualname, start, end], i) => ({
    id: i + 1,
    file_id: file(path),
    qualname,
    ordinal: 1,
    name: qualname,
    kind: "function",
    start_line: start,
    start_col: 1,
    end_line: end,
    end_col: 2,
    exported: 1,
    parent_id: null,
    scip_symbol: null,
    signature: null,
    producer: "ast-grep",
  }));
  // file, line, enclosing definition, callee
  const sites: [string, number, number, string][] = [
    ["a.ts", 2, 1, "T"],
    ["b.ts", 2, 2, "T"],
    ["s.ts", 2, 3, "H"],
    ["s.ts", 3, 3, "G"],
    ["s.ts", 5, 3, "G"],
    ["s.ts", 7, 3, "G"],
  ];
  c.call_sites = sites.map(([path, line, enclosing, callee], i) => ({
    id: i + 1,
    file_id: file(path),
    line,
    col: 3,
    enclosing_def_id: enclosing,
    callee_name: callee,
    receiver_text: null,
    producer: "ast-grep",
  }));
  // site, definition, label
  const targets: [number, number, "bound" | "scoped"][] = [
    [1, 4, "scoped"],
    [2, 4, "bound"],
    [3, 2, "bound"],
    [4, 1, "scoped"],
    [5, 1, "bound"],
    [6, 1, "bound"],
  ];
  c.call_targets = targets.map(([site_id, def_id, label]) => ({
    site_id,
    def_id,
    label,
    collision: 0,
  }));
  const store = openStore(miniStore(c));
  if ("code" in store) throw new Error(`the callee store: ${store.reason}`);
  return store;
}

it("takes each callee once, by its strongest call and that call's first line, in definition order", () => {
  const cs = calleeStore();
  expect(
    answer(p({ from: "s.ts#F", to: "t.ts#T", via: "calls" }, cs, C_CTX)).hops,
  ).toEqual([
    { from: "c:s.ts#F", to: "c:a.ts#G", kind: "bound", line: 5, text: "G();" },
    { from: "c:a.ts#G", to: "c:t.ts#T", kind: "scoped", line: 2, text: "T();" },
  ]);
  expect(
    answer(p({ from: "t.ts#T", to: "s.ts#F", via: "calls" }, cs, C_CTX)),
  ).toMatchObject({ found: false, hops: [] });
});

// The callee-order store. Each of s.ts#F and s.ts#E calls two definitions that both call t.ts#T,
// so the order callees are expanded in decides which one the path goes through. F calls b.ts#A
// (line 2) before a.ts#Z (line 3); both start on line 1, so only the file path puts Z first. E
// calls a.ts#A (line 7, starting on line 5) before a.ts#Z (line 8, starting on line 1); they
// share a file, so only the start line puts Z first. Z calls T bound, and each A calls it scoped.
function calleeOrderStore(): Store {
  const c = emptyContent("c");
  const paths = ["a.ts", "b.ts", "s.ts", "t.ts"];
  const file = (path: string) => paths.indexOf(path) + 1;
  c.files = paths.map((path, i) => ({
    id: i + 1,
    path,
    lang: "typescript",
    kind: "code",
    component_id: null,
    lines: 9,
    bytes: 90,
    blob_sha: "c".repeat(40),
    mode: "100644",
    link_target: null,
    entry: 0,
    has_source: 0,
  }));
  // file, qualname, start line, end line
  const defs: [string, string, number, number][] = [
    ["a.ts", "Z", 1, 3],
    ["a.ts", "A", 5, 7],
    ["b.ts", "A", 1, 3],
    ["s.ts", "F", 1, 4],
    ["s.ts", "E", 6, 9],
    ["t.ts", "T", 1, 2],
  ];
  c.definitions = defs.map(([path, qualname, start, end], i) => ({
    id: i + 1,
    file_id: file(path),
    qualname,
    ordinal: 1,
    name: qualname,
    kind: "function",
    start_line: start,
    start_col: 1,
    end_line: end,
    end_col: 2,
    exported: 1,
    parent_id: null,
    scip_symbol: null,
    signature: null,
    producer: "ast-grep",
  }));
  // file, line, enclosing definition, callee name, callee definition, label
  const sites: [string, number, number, string, number, "bound" | "scoped"][] =
    [
      ["a.ts", 2, 1, "T", 6, "bound"],
      ["a.ts", 6, 2, "T", 6, "scoped"],
      ["b.ts", 2, 3, "T", 6, "scoped"],
      ["s.ts", 2, 4, "A", 3, "bound"],
      ["s.ts", 3, 4, "Z", 1, "bound"],
      ["s.ts", 7, 5, "A", 2, "bound"],
      ["s.ts", 8, 5, "Z", 1, "bound"],
    ];
  c.call_sites = sites.map(([path, line, enclosing, callee], i) => ({
    id: i + 1,
    file_id: file(path),
    line,
    col: 3,
    enclosing_def_id: enclosing,
    callee_name: callee,
    receiver_text: null,
    producer: "ast-grep",
  }));
  c.call_targets = sites.map(([, , , , def_id, label], i) => ({
    site_id: i + 1,
    def_id,
    label,
    collision: 0,
  }));
  const store = openStore(miniStore(c));
  if ("code" in store)
    throw new Error(`the callee-order store: ${store.reason}`);
  return store;
}

it("expands callees by file path, then start line, before qualname and call order", () => {
  const cs = calleeOrderStore();
  expect(
    answer(p({ from: "s.ts#F", to: "t.ts#T", via: "calls" }, cs, C_CTX)).hops,
  ).toEqual([
    { from: "c:s.ts#F", to: "c:a.ts#Z", kind: "bound", line: 3 },
    { from: "c:a.ts#Z", to: "c:t.ts#T", kind: "bound", line: 2 },
  ]);
  expect(
    answer(p({ from: "s.ts#E", to: "t.ts#T", via: "calls" }, cs, C_CTX)).hops,
  ).toEqual([
    { from: "c:s.ts#E", to: "c:a.ts#Z", kind: "bound", line: 8 },
    { from: "c:a.ts#Z", to: "c:t.ts#T", kind: "bound", line: 2 },
  ]);
});
