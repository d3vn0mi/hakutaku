import { describe, expect, it } from "vitest";
import type { DefKind, Lang } from "../../../src/model/index.js";
import {
  blindSpots,
  type CallLink,
  calleesOf,
  callersOf,
  type LinkLabel,
  type QueryCtx,
  type QueryOut,
  queryCallers,
  referrersOf,
  storeIndex,
  strongest,
  weakest,
} from "../../../src/query/index.js";
import {
  type Coverage,
  openStore,
  type Store,
} from "../../../src/store/index.js";
import type { ToolError } from "../../../src/tools/errors.js";
import type { CallersAnswer, Checked } from "../../../src/tools/types.js";
import { emptyContent, miniStore } from "../../helpers/mini-store.js";
import {
  openTiny,
  TINY_CTX,
  type TinyOptions,
  tinyContent,
} from "../../helpers/tiny.js";

const answer = (out: QueryOut<CallersAnswer>): CallersAnswer => {
  if (!out.ok) throw new Error(`an error: ${JSON.stringify(out.error)}`);
  return out.answer;
};
const error = (out: QueryOut<CallersAnswer>): ToolError => {
  if (out.ok) throw new Error(`an answer: ${JSON.stringify(out.answer)}`);
  return out.error;
};

type Args = Partial<Checked<"code_callers">> & { symbol: string };

const s = openTiny();
const c = (a: Args, store: Store = s, q = TINY_CTX) =>
  queryCallers(
    store,
    {
      repo: "tiny",
      labels: ["bound", "scoped"],
      scope: "direct",
      include_tests: true,
      depth: 1,
      limit: 50,
      ...a,
    },
    q,
  );

const BLIND =
  '1 dynamic import with a computed path is not followed; ask with labels ["unscoped"] to see name matches';

it("labels a method's callers, grouped by the calling definition", () => {
  const want = {
    id: "tiny:lib/orbit.ts#Orbit.position",
    builtCommit: "0123456789ab",
    stale: false,
    labels: ["bound", "scoped"],
    scope: "direct",
    depth: 1,
    counts: {
      files: 2,
      callers: 2,
      sites: 3,
      bound: 1,
      scoped: 2,
      unscoped: 0,
    },
    callers: [
      {
        id: "tiny:lib/render.ts#draw",
        file: "tiny:lib/render.ts",
        test: false,
        hop: 1,
        sites: [
          {
            line: 6,
            col: 18,
            label: "scoped",
            text: "const p = body.position(t);",
          },
        ],
      },
      {
        id: "tiny:lib/orbit.test.ts#<module>",
        file: "tiny:lib/orbit.test.ts",
        test: true,
        hop: 1,
        sites: [
          {
            line: 4,
            col: 10,
            label: "bound",
            text: "expect(o.position(0)).toEqual([1, 0]);",
          },
          {
            line: 5,
            col: 10,
            label: "scoped",
            collision: true,
            text: "expect(c.position(1)[0]).toBeCloseTo(-1);",
          },
        ],
      },
    ],
    blindSpots: [BLIND],
    view: "#lib~orbit.ts--Orbit.position",
  };
  expect(
    JSON.stringify(answer(c({ symbol: "lib/orbit.ts#Orbit.position" }))),
  ).toBe(JSON.stringify(want));
});

it("returns unscoped matches only when asked, without text where no source is stored", () => {
  const a = answer(
    c({ symbol: "lib/orbit.ts#Orbit.position", labels: ["unscoped"] }),
  );
  expect(a.callers).toEqual([
    {
      id: "tiny:lib/loader.ts#load",
      file: "tiny:lib/loader.ts",
      test: false,
      hop: 1,
      sites: [{ line: 4, col: 12, label: "unscoped" }],
    },
  ]);
  expect(a.counts).toEqual({
    files: 1,
    callers: 1,
    sites: 1,
    bound: 0,
    scoped: 0,
    unscoped: 1,
  });
  expect(a.blindSpots).toEqual([
    "1 dynamic import with a computed path is not followed; the unscoped matches include calls made through them",
  ]);
});

it("widens scoped matches with scope transitive", () => {
  const a = answer(
    c({ symbol: "lib/orbit.ts#Orbit.position", scope: "transitive" }),
  );
  expect(a.callers.map((x) => x.id)).toEqual([
    "tiny:lib/render.ts#draw",
    "tiny:lib/loader.ts#load",
    "tiny:lib/orbit.test.ts#<module>",
  ]);
  expect(a.callers[1].sites).toEqual([{ line: 4, col: 12, label: "scoped" }]);
  expect(a.counts).toEqual({
    files: 3,
    callers: 3,
    sites: 4,
    bound: 1,
    scoped: 3,
    unscoped: 0,
  });
});

it("filters by label and by tests", () => {
  expect(
    answer(c({ symbol: "lib/orbit.ts#Orbit.position", labels: ["bound"] }))
      .counts,
  ).toEqual({
    files: 1,
    callers: 1,
    sites: 1,
    bound: 1,
    scoped: 0,
    unscoped: 0,
  });
  expect(
    answer(
      c({ symbol: "lib/orbit.ts#Orbit.position", include_tests: false }),
    ).callers.map((x) => x.id),
  ).toEqual(["tiny:lib/render.ts#draw"]);
});

it("walks depth 2, listing each caller once at its first hop", () => {
  const a = answer(c({ symbol: "solve", depth: 2 }));
  expect(a.callers.map((x) => [x.id, x.hop])).toEqual([
    ["tiny:lib/orbit.ts#Orbit.position", 1],
    ["tiny:lib/render.ts#draw", 1],
    ["tiny:app/main.ts#main", 1],
    ["tiny:lib/orbit.test.ts#<module>", 2],
  ]);
  expect(a.callers[3].sites.map((x) => x.label)).toEqual(["bound", "scoped"]);
  expect(a.counts).toEqual({
    files: 4,
    callers: 4,
    sites: 5,
    bound: 4,
    scoped: 1,
    unscoped: 0,
  });
});

it("refuses files and the reference label", () => {
  expect(error(c({ symbol: "lib/orbit.ts" }))).toMatchObject({
    code: "invalid_argument",
    field: "symbol",
    hint: "code_deps with direction in lists a file's importers",
  });
  expect(error(c({ symbol: "solve", labels: ["reference"] }))).toMatchObject({
    field: "labels",
    hint: "code_references lists them",
  });
});

it("orders labels bound, reference, scoped, unscoped", () => {
  const order: LinkLabel[] = ["bound", "reference", "scoped", "unscoped"];
  for (const [i, a] of order.entries()) {
    for (const [j, b] of order.entries()) {
      expect([weakest(a, b), strongest(a, b)]).toEqual([
        order[Math.max(i, j)],
        order[Math.min(i, j)],
      ]);
    }
  }
});

it("says which argument is wrong, before resolving the symbol", () => {
  expect(error(c({ symbol: "nope", labels: ["bound", "reference"] }))).toEqual({
    code: "invalid_argument",
    message: "labels cannot include reference: references are not calls",
    field: "labels",
    hint: "code_references lists them",
  });
  expect(error(c({ symbol: "nope" }))).toMatchObject({
    code: "not_found",
    field: "symbol",
  });
});

it("words each refusal", () => {
  const refusal = (symbol: string) => {
    const e = error(c({ symbol }));
    return [e.code, e.message, e.field, e.hint];
  };
  expect(refusal("lib/orbit.ts")).toEqual([
    "invalid_argument",
    "symbol is a file; code_callers takes a definition",
    "symbol",
    "code_deps with direction in lists a file's importers",
  ]);
  expect(refusal("lib/")).toEqual([
    "invalid_argument",
    "symbol is a component; code_callers takes a definition",
    "symbol",
    "code_overview describes repos and components",
  ]);
  expect(refusal("tiny:")).toEqual([
    "invalid_argument",
    "symbol is a repo; code_callers takes a definition",
    "symbol",
    "code_overview describes repos and components",
  ]);
  expect(refusal("tiny:npm:react")).toEqual([
    "invalid_argument",
    "symbol is a library; code_callers takes a definition",
    "symbol",
    "code_references lists a library's importers",
  ]);
});

it("lists the labels asked for once each, in label order", () => {
  const position = "lib/orbit.ts#Orbit.position";
  const a = answer(
    c({ symbol: position, labels: ["unscoped", "bound", "unscoped"] }),
  );
  expect(a.labels).toEqual(["bound", "unscoped"]);
  expect(a.counts).toEqual({
    files: 2,
    callers: 2,
    sites: 2,
    bound: 1,
    scoped: 0,
    unscoped: 1,
  });
  const none = answer(c({ symbol: position, labels: [] }));
  expect([none.labels, none.callers, none.counts]).toEqual([
    [],
    [],
    { files: 0, callers: 0, sites: 0, bound: 0, scoped: 0, unscoped: 0 },
  ]);
});

it("gives a later hop the weakest label on its path", () => {
  const position = "lib/orbit.ts#Orbit.position";
  const a = answer(c({ symbol: position, depth: 2 }));
  expect(a.callers.at(-1)).toEqual({
    id: "tiny:app/main.ts#main",
    file: "tiny:app/main.ts",
    test: false,
    hop: 2,
    sites: [{ line: 8, col: 3, label: "scoped", text: "draw(o, 2);" }],
  });
  // draw calls position only by a scoped site, so no bound path goes on through it
  expect(
    answer(c({ symbol: position, depth: 2, labels: ["bound"] })).callers.map(
      (x) => x.id,
    ),
  ).toEqual(["tiny:lib/orbit.test.ts#<module>"]);
});

it("drops every text when snippets are off", () => {
  const a = answer(
    c({ symbol: "solve", depth: 2 }, s, { ...TINY_CTX, snippets: false }),
  );
  expect(a.counts.sites).toBe(5);
  expect(JSON.stringify(a)).not.toContain('"text"');
});

describe("the call links of the tiny store", () => {
  const ix = storeIndex(s);
  const brief = (links: CallLink[]) =>
    links.map((l) => [
      ix.idOfDef(l.callerDefId),
      l.line,
      l.col,
      ix.idOfDef(l.calleeDefId),
      l.label,
      l.collision,
    ]);
  const position = 11; // lib/orbit.ts#Orbit.position

  it("reads the stored links into a definition, by site", () => {
    expect(
      callersOf(s, position, { unscoped: false, scope: "direct" })[0],
    ).toEqual({
      siteId: 5,
      fileId: 8,
      line: 4,
      col: 10,
      callerDefId: 8,
      calleeDefId: position,
      label: "bound",
      collision: false,
    });
    const orbit = "tiny:lib/orbit.ts#Orbit.position";
    const test = "tiny:lib/orbit.test.ts#<module>";
    expect(
      brief(callersOf(s, position, { unscoped: true, scope: "transitive" })),
    ).toEqual([
      ["tiny:lib/loader.ts#load", 4, 12, orbit, "scoped", false],
      [test, 4, 10, orbit, "bound", false],
      [test, 5, 10, orbit, "scoped", true],
      ["tiny:lib/render.ts#draw", 6, 18, orbit, "scoped", false],
    ]);
  });

  it("reads the stored links out of a definition, by site, then callee", () => {
    expect(brief(calleesOf(s, 1))).toEqual([
      [
        "tiny:app/main.ts#main",
        6,
        3,
        "tiny:lib/orbit.ts#solve",
        "bound",
        false,
      ],
      [
        "tiny:app/main.ts#main",
        8,
        3,
        "tiny:lib/render.ts#draw",
        "bound",
        false,
      ],
    ]);
    const test = "tiny:lib/orbit.test.ts#<module>";
    expect(brief(calleesOf(s, 8))).toEqual([
      [test, 4, 10, "tiny:lib/orbit.ts#Orbit.position", "bound", false],
      [test, 5, 10, "tiny:lib/camera.ts#Camera.position", "bound", false],
      [test, 5, 10, "tiny:lib/orbit.ts#Orbit.position", "scoped", true],
    ]);
    expect(calleesOf(s, 2)).toEqual([]);
  });

  it("reads the uses that are not calls, in row order", () => {
    expect(referrersOf(s, 10)).toEqual([
      { refId: 1, fileId: 2, line: 7, col: 17, callerDefId: 1, role: "read" },
      { refId: 2, fileId: 8, line: 3, col: 15, callerDefId: 8, role: "read" },
    ]);
    expect(referrersOf(s, 13)).toEqual([]);
  });
});

// The calls store: k/ holds two callers of core reached at once by one site, a test caller
// and a third hop; m/ holds two definitions named pos and the sites that call the name.
const C_CTX: QueryCtx = Object.freeze({
  repo: "c",
  builtCommit: "fedcba987654",
  stale: false,
  snippets: true,
});

function callStore(): Store {
  const c = emptyContent("c");
  const paths = [
    "k/0.test.ts",
    "k/a.ts",
    "k/b.ts",
    "k/core.ts",
    "k/r.ts",
    "k/top.ts",
    "m/mid.ts",
    "m/p.ts",
    "m/q.ts",
    "m/u1.ts",
    "m/u2.ts",
    "m/w.ts",
  ];
  const file = (path: string) => paths.indexOf(path) + 1;
  c.components = ["k/", "m/"].map((path, i) => ({
    id: i + 1,
    path,
    kind: "folder",
    parent_id: null,
    files: paths.filter((p) => p.startsWith(path) && !p.includes(".test."))
      .length,
    tests: paths.filter((p) => p.startsWith(path) && p.includes(".test."))
      .length,
    lines: 9,
  }));
  c.files = paths.map((path, i) => ({
    id: i + 1,
    path,
    lang: "typescript",
    kind: path.includes(".test.") ? "test" : "code",
    component_id: path.startsWith("k/") ? 1 : 2,
    lines: 9,
    bytes: 90,
    blob_sha: "c".repeat(40),
    mode: "100644",
    link_target: null,
    entry: 0,
    has_source: 0,
  }));
  // path, qualname, kind, start line, start col, end line, parent; in row order
  const defs: [string, string, DefKind | "module", number, number, number][] = [
    ["k/0.test.ts", "check", "function", 1, 1, 2],
    ["k/0.test.ts", "suite", "function", 3, 1, 5],
    ["k/a.ts", "A", "class", 1, 1, 3],
    ["k/a.ts", "A.go", "method", 2, 3, 2],
    ["k/b.ts", "B", "class", 1, 1, 3],
    ["k/b.ts", "B.go", "method", 2, 3, 2],
    ["k/core.ts", "core", "function", 1, 1, 1],
    ["k/r.ts", "run", "function", 1, 1, 3],
    ["k/top.ts", "top", "function", 1, 1, 3],
    ["m/p.ts", "P", "class", 1, 1, 6],
    ["m/p.ts", "P.pos", "method", 2, 3, 5],
    ["m/p.ts", "near", "function", 7, 1, 9],
    ["m/q.ts", "Q", "class", 1, 1, 3],
    ["m/q.ts", "Q.pos", "method", 2, 3, 2],
    ["m/u1.ts", "<module>", "module", 1, 1, 4],
    ["m/u2.ts", "<module>", "module", 1, 1, 2],
    ["m/w.ts", "<module>", "module", 1, 1, 1],
  ];
  const def = (path: string, qualname: string) =>
    defs.findIndex(([p, q]) => p === path && q === qualname) + 1;
  c.definitions = defs.map(([path, qualname, kind, line, col, end], i) => {
    const dot = qualname.lastIndexOf(".");
    return {
      id: i + 1,
      file_id: file(path),
      qualname,
      ordinal: 1,
      name: qualname.slice(dot + 1),
      kind,
      start_line: line,
      start_col: col,
      end_line: end,
      end_col: 2,
      exported: 1,
      parent_id: dot < 0 ? null : def(path, qualname.slice(0, dot)),
      scip_symbol: null,
      signature: null,
      producer: "ast-grep",
    };
  });
  // source, imported file, line, specifier; in row order
  const imports: [string, string, number, string][] = [
    ["k/a.ts", "k/core.ts", 1, "./core"],
    ["k/b.ts", "k/core.ts", 1, "./core"],
    ["k/r.ts", "k/a.ts", 1, "./a"],
    ["k/r.ts", "k/b.ts", 1, "./b"],
    ["k/top.ts", "k/r.ts", 1, "./r"],
    ["m/mid.ts", "m/p.ts", 1, "./p"],
    ["m/p.ts", "m/u2.ts", 1, "./u2"],
    ["m/q.ts", "m/u2.ts", 1, "./u2"],
    ["m/u1.ts", "m/mid.ts", 1, "./mid"],
    ["m/u1.ts", "m/q.ts", 1, "./q"],
    ["m/u2.ts", "m/mid.ts", 1, "./mid"],
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
  // path, line, col, enclosing qualname, callee; in row order
  const sites: [string, number, number, string, string][] = [
    ["k/0.test.ts", 2, 3, "check", "core"],
    ["k/0.test.ts", 4, 3, "suite", "check"],
    ["k/a.ts", 2, 5, "A.go", "core"],
    ["k/b.ts", 2, 5, "B.go", "core"],
    ["k/r.ts", 2, 3, "run", "go"],
    ["k/top.ts", 2, 3, "top", "run"],
    ["m/p.ts", 3, 5, "P.pos", "pos"], // P.pos calls itself
    ["m/p.ts", 4, 5, "P.pos", "pos"],
    ["m/p.ts", 8, 3, "near", "pos"], // in the defining file
    ["m/u1.ts", 2, 1, "<module>", "pos"],
    ["m/u1.ts", 3, 1, "<module>", "pos"], // bound to Q.pos
    ["m/u1.ts", 4, 1, "<module>", "pos"], // scoped to Q.pos
    ["m/u2.ts", 2, 1, "<module>", "pos"],
    ["m/w.ts", 1, 1, "<module>", "pos"], // no import reaches m/p.ts
  ];
  const site = (path: string, line: number) =>
    sites.findIndex(([p, l]) => p === path && l === line) + 1;
  c.call_sites = sites.map(([path, line, col, enclosing, callee], i) => ({
    id: i + 1,
    file_id: file(path),
    line,
    col,
    enclosing_def_id: def(path, enclosing),
    callee_name: callee,
    receiver_text: null,
    producer: "ast-grep",
  }));
  // site, definition, label, collision; in row order
  const targets: [number, number, "bound" | "scoped", 0 | 1][] = [
    [site("k/0.test.ts", 2), def("k/core.ts", "core"), "bound", 0],
    [site("k/0.test.ts", 4), def("k/0.test.ts", "check"), "bound", 0],
    [site("k/a.ts", 2), def("k/core.ts", "core"), "bound", 0],
    [site("k/b.ts", 2), def("k/core.ts", "core"), "bound", 0],
    [site("k/r.ts", 2), def("k/a.ts", "A.go"), "scoped", 1],
    [site("k/r.ts", 2), def("k/b.ts", "B.go"), "bound", 0],
    [site("k/top.ts", 2), def("k/r.ts", "run"), "bound", 0],
    [site("m/p.ts", 3), def("m/p.ts", "P.pos"), "bound", 0],
    [site("m/u1.ts", 3), def("m/q.ts", "Q.pos"), "bound", 0],
    [site("m/u1.ts", 4), def("m/q.ts", "Q.pos"), "scoped", 0],
  ];
  c.call_targets = targets.map(([site_id, def_id, label, collision]) => ({
    site_id,
    def_id,
    label,
    collision,
  }));
  const store = openStore(miniStore(c));
  if ("code" in store) throw new Error(`the calls store: ${store.reason}`);
  return store;
}

describe("the calls store", () => {
  const cs = callStore();
  const ix = storeIndex(cs);
  const brief = (links: CallLink[]) =>
    links.map((l) => [
      `${ix.idOfDef(l.callerDefId)}@${l.line}`,
      l.label,
      l.collision,
    ]);
  const pos = 11; // m/p.ts#P.pos

  it("derives scoped links through any chain of imports, with collisions seen the same way", () => {
    // m/u1.ts reaches m/p.ts and m/q.ts, so it sees both definitions named pos; m/u2.ts reaches
    // m/p.ts only, though m/p.ts and m/q.ts both reach it. A site bound to Q.pos is never
    // derived; one scoped to Q.pos still is.
    expect(
      brief(callersOf(cs, pos, { unscoped: false, scope: "transitive" })),
    ).toEqual([
      ["c:m/u1.ts#<module>@2", "scoped", true],
      ["c:m/u1.ts#<module>@4", "scoped", true],
      ["c:m/u2.ts#<module>@2", "scoped", false],
    ]);
  });

  it("matches the remaining sites by name when asked, never sites inside the definition", () => {
    expect(
      brief(callersOf(cs, pos, { unscoped: true, scope: "transitive" })),
    ).toEqual([
      ["c:m/p.ts#near@8", "unscoped", false],
      ["c:m/u1.ts#<module>@2", "scoped", true],
      ["c:m/u1.ts#<module>@4", "scoped", true],
      ["c:m/u2.ts#<module>@2", "scoped", false],
      ["c:m/w.ts#<module>@1", "unscoped", false],
    ]);
    expect(
      brief(callersOf(cs, pos, { unscoped: true, scope: "direct" })),
    ).toEqual([
      ["c:m/p.ts#near@8", "unscoped", false],
      ["c:m/u1.ts#<module>@2", "unscoped", false],
      ["c:m/u1.ts#<module>@4", "unscoped", false],
      ["c:m/u2.ts#<module>@2", "unscoped", false],
      ["c:m/w.ts#<module>@1", "unscoped", false],
    ]);
    expect(callersOf(cs, pos, { unscoped: false, scope: "direct" })).toEqual(
      [],
    );
    expect(brief(calleesOf(cs, pos))).toEqual([
      ["c:m/p.ts#P.pos@3", "bound", false],
    ]);
  });

  it("lists a site reached through two callers once, with its strongest label, and walks on from neither tests nor deeper than asked", () => {
    const a = answer(c({ repo: "c", symbol: "core", depth: 3 }, cs, C_CTX));
    expect(a.callers).toEqual([
      {
        id: "c:k/a.ts#A.go",
        file: "c:k/a.ts",
        test: false,
        hop: 1,
        sites: [{ line: 2, col: 5, label: "bound" }],
      },
      {
        id: "c:k/b.ts#B.go",
        file: "c:k/b.ts",
        test: false,
        hop: 1,
        sites: [{ line: 2, col: 5, label: "bound" }],
      },
      {
        id: "c:k/0.test.ts#check",
        file: "c:k/0.test.ts",
        test: true,
        hop: 1,
        sites: [{ line: 2, col: 3, label: "bound" }],
      },
      {
        id: "c:k/r.ts#run",
        file: "c:k/r.ts",
        test: false,
        hop: 2,
        sites: [{ line: 2, col: 3, label: "bound" }],
      },
      {
        id: "c:k/top.ts#top",
        file: "c:k/top.ts",
        test: false,
        hop: 3,
        sites: [{ line: 2, col: 3, label: "bound" }],
      },
    ]);
    expect(a.counts).toEqual({
      files: 5,
      callers: 5,
      sites: 5,
      bound: 5,
      scoped: 0,
      unscoped: 0,
    });
    expect(brief(calleesOf(cs, 8))).toEqual([
      ["c:k/r.ts#run@2", "scoped", true],
      ["c:k/r.ts#run@2", "bound", false],
    ]);
    expect(
      answer(c({ repo: "c", symbol: "core", depth: 2 }, cs, C_CTX)).callers.map(
        (x) => x.id,
      ),
    ).toEqual([
      "c:k/a.ts#A.go",
      "c:k/b.ts#B.go",
      "c:k/0.test.ts#check",
      "c:k/r.ts#run",
    ]);
  });
});

describe("blind spots", () => {
  const variant = (coverage: Partial<Coverage>, opts: TinyOptions = {}) => {
    const content = tinyContent(opts);
    const [meta] = content.meta;
    if (meta === undefined) throw new Error("tinyContent has no meta row");
    const path = miniStore({
      ...content,
      meta: [{ ...meta, coverage: { ...meta.coverage, ...coverage } }],
    });
    const store = openStore(path);
    if ("code" in store) throw new Error(`the variant: ${store.reason}`);
    return store;
  };
  const NOT_FOLLOWED = "1 dynamic import with a computed path is not followed";

  it("words the computed imports for a file, without labels and with unscoped", () => {
    expect(blindSpots(s, "typescript", { fileTarget: true })).toEqual([
      NOT_FOLLOWED,
    ]);
    expect(
      blindSpots(s, "typescript", { labels: ["unscoped"], fileTarget: true }),
    ).toEqual([NOT_FOLLOWED]);
    expect(blindSpots(s, "javascript", {})).toEqual([BLIND]);
    const two = variant({ computedImports: 2 });
    expect(blindSpots(two, "typescript", { labels: ["unscoped"] })).toEqual([
      "2 dynamic imports with a computed path are not followed; the unscoped matches include calls made through them",
    ]);
    expect(
      blindSpots(variant({ computedImports: 0 }), "typescript", {}),
    ).toEqual([]);
  });

  it("names the compiler tier that did not run, first", () => {
    const quick = openTiny({ detail: "quick" });
    expect(blindSpots(quick, "typescript", {})).toEqual([
      "no compiler ran for TypeScript in this build (quick detail), so no site is bound",
      BLIND,
    ]);
    expect(blindSpots(quick, "javascript", { fileTarget: true })).toEqual([
      "no compiler ran for JavaScript in this build (quick detail), so no site is bound",
      NOT_FOLLOWED,
    ]);
  });

  it("adds Python's resolver and the unmatched bound uses, in order", () => {
    expect(blindSpots(s, "python", {})).toEqual([
      "no compiler ran for Python in this build (below deep detail), so no site is bound",
    ]);
    const odd = variant(
      { pythonResolver: "hakutaku-resolver", unmatchedBoundUses: 3 },
      { tiers: { "scip-typescript": "ran", "scip-python": "ran" } },
    );
    expect(blindSpots(odd, "python", {})).toEqual([
      "Python imports come from hakutaku's own resolver, because grimp did not run",
      "compiler-bound uses that match no outline definition are counted in coverage only (3)",
    ]);
    expect(blindSpots(odd, "typescript", { labels: ["bound"] })).toEqual([
      BLIND,
      "compiler-bound uses that match no outline definition are counted in coverage only (3)",
    ]);
  });

  it("says what other languages get", () => {
    const odd = variant({
      pythonResolver: "hakutaku-resolver",
      unmatchedBoundUses: 3,
    });
    const langs: (Lang | null)[] = ["go", "shell", null];
    expect(langs.map((lang) => blindSpots(odd, lang, {}))).toEqual([
      ["hakutaku extracts no callers for go"],
      [
        "shell callers are name matches in the file and the files that source it",
      ],
      [],
    ]);
  });
});
