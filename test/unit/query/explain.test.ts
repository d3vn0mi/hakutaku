import { describe, expect, it } from "vitest";
import {
  comparePaths,
  type DefKind,
  type FileKind,
  type ImportKind,
} from "../../../src/model/index.js";
import {
  compilerTier,
  displayLang,
  explainLabel,
  type QueryCtx,
  type QueryOut,
  queryExplain,
  storeIndex,
} from "../../../src/query/index.js";
import { openStore, type Store } from "../../../src/store/index.js";
import type { ToolError } from "../../../src/tools/errors.js";
import type {
  ExplainDefinitionAnswer,
  ExplainFileAnswer,
} from "../../../src/tools/types.js";
import { emptyContent, miniStore } from "../../helpers/mini-store.js";
import { openTiny, TINY_CTX } from "../../helpers/tiny.js";

type Explained = ExplainFileAnswer | ExplainDefinitionAnswer;

const answer = (out: QueryOut<Explained>): Explained => {
  if (!out.ok) throw new Error(`an error: ${JSON.stringify(out.error)}`);
  return out.answer;
};
const error = (out: QueryOut<Explained>): ToolError => {
  if (out.ok) throw new Error(`an answer: ${JSON.stringify(out.answer)}`);
  return out.error;
};
const asDef = (out: QueryOut<Explained>): ExplainDefinitionAnswer =>
  answer(out) as ExplainDefinitionAnswer;
const asFile = (out: QueryOut<Explained>): ExplainFileAnswer =>
  answer(out) as ExplainFileAnswer;

const s = openTiny();
const x = (t: string, store = s) =>
  queryExplain(store, { repo: "tiny", target: t }, TINY_CTX);

const FILE_COMMON = {
  component: "lib",
  lines: 16,
  entryPoint: false,
  inImportCycle: false,
  metrics: {
    dependentsRank: 1,
    importedBy: 3,
    imports: 1,
    commits90d: 5,
    hotspot: 1,
  },
  importedBy: {
    total: 3,
    top: ["tiny:lib/render.ts", "tiny:app/main.ts", "tiny:lib/orbit.test.ts"],
  },
  imports: { total: 1, top: ["tiny:lib/units.ts"] },
  changesTogetherWith: [
    { id: "tiny:lib/orbit.test.ts", commits: 4 },
    { id: "tiny:lib/render.ts", commits: 2 },
  ],
};

it("explains a file with the contract's fields in order", () => {
  const want = {
    id: "tiny:lib/orbit.ts",
    kind: "file",
    builtCommit: "0123456789ab",
    stale: false,
    ...FILE_COMMON,
    definitions: {
      total: 3,
      top: [
        {
          id: "tiny:lib/orbit.ts#solve",
          kind: "function",
          line: 3,
          exported: true,
          usedByFiles: 2,
          mentionedByTests: false,
        },
        {
          id: "tiny:lib/orbit.ts#Orbit",
          kind: "class",
          line: 10,
          exported: true,
          usedByFiles: 1,
          mentionedByTests: true,
        },
        {
          id: "tiny:lib/orbit.ts#Orbit.position",
          kind: "method",
          line: 12,
          exported: true,
          usedByFiles: 1,
          mentionedByTests: true,
        },
      ],
    },
    view: "#lib~orbit.ts",
  };
  expect(JSON.stringify(answer(x("lib/orbit.ts")))).toBe(JSON.stringify(want));
});

it("explains a definition with the contract's fields in order", () => {
  const want = {
    id: "tiny:lib/orbit.ts#Orbit.position",
    kind: "method",
    builtCommit: "0123456789ab",
    stale: false,
    definedIn: "tiny:lib/orbit.ts",
    line: 12,
    usedByFiles: 1,
    mentionedByTests: true,
    label: "scoped",
    note: "includes files that use the name inside files importing its module, without a compiler binding; code_callers labels each use",
    ...FILE_COMMON,
    view: "#lib~orbit.ts--Orbit.position",
  };
  expect(JSON.stringify(answer(x("lib/orbit.ts#Orbit.position")))).toBe(
    JSON.stringify(want),
  );
});

it("labels and notes each case", () => {
  expect(answer(x("lib/orbit.ts#solve"))).toMatchObject({
    label: "bound",
    note: "every counted file has a compiler-bound use; code_callers lists each use with its line",
  });
  expect(answer(x("app/main.ts#main"))).toMatchObject({
    label: "bound",
    note: "no other production file uses it",
  });
  const below =
    "no other production file uses it by name in files that import its module; no compiler ran for Python in this build (below deep detail), so check code_callers' unscoped matches";
  expect(answer(x("py/pkg/util.py#helper"))).toMatchObject({
    label: "scoped",
    note: below,
  });
  expect(
    asDef(x("app/main.ts#main", openTiny({ detail: "quick" }))).note,
  ).toContain("for TypeScript in this build (quick detail)");
  const fellBack = openTiny({
    tiers: {
      "ast-grep": "ran",
      "dependency-cruiser": "ran",
      grimp: "ran",
      "scip-typescript": "fallback",
    },
  });
  expect(asDef(x("app/main.ts#main", fellBack)).note).toContain(
    "(scip-typescript fell back)",
  );
  expect(asDef(x("scripts/sync-#main")).note).toContain(
    "for shell in this build (no compiler tier for this language)",
  );
});

it("explains a test file, and module scope as its file", () => {
  expect(answer(x("lib/orbit.test.ts"))).toMatchObject({
    kind: "test-file",
    metrics: { dependentsRank: null, hotspot: 0 },
  });
  expect(answer(x("lib/orbit.test.ts#<module>")).id).toBe(
    "tiny:lib/orbit.test.ts",
  );
});

it("refuses components, libraries, the repo and non-code files", () => {
  expect(error(x("tiny:lib/"))).toMatchObject({
    code: "invalid_argument",
    field: "target",
    hint: "code_overview describes repos and components",
  });
  expect(error(x("tiny:npm:react")).hint).toBe(
    "code_references lists a library's importers",
  );
  expect(error(x("README.md")).message).toBe(
    "target is a doc file; code_explain takes a code file or a definition",
  );
  expect(error(x("tiny:"))).toMatchObject({
    code: "invalid_argument",
    field: "target",
    hint: "code_overview describes repos and components",
  });
});

it("carries the file's component, entry point and cycle flags", () => {
  expect(answer(x("lib/units.ts"))).toMatchObject({
    component: "lib",
    entryPoint: false,
    inImportCycle: true,
  });
  expect(answer(x("app/main.ts"))).toMatchObject({
    kind: "file",
    component: "app",
    entryPoint: true,
    inImportCycle: false,
  });
  expect(answer(x("scripts/sync-#main"))).toMatchObject({
    definedIn: "tiny:scripts/sync-",
    component: "scripts",
    entryPoint: true,
    view: "#scripts~sync%2D--main",
  });
});

// A store of repo "x" for the lists' caps and orders. a/h.ts is imported by b/i0.ts …
// b/i8.ts (ranked 19 down to 11; b/i0.ts twice) and by the test support b/support.ts; it
// imports a/d0.ts … a/d8.ts (ranked 1 to 9), a library and a path that resolves to nothing; it
// changes together with c/p0.ts … c/p6.ts; and it defines nine definitions besides its module
// row. notes.txt is an "other" file.
const X_CTX: QueryCtx = Object.freeze({
  repo: "x",
  builtCommit: "fedcba987654",
  stale: false,
  snippets: true,
});
const range = (n: number) => Array.from({ length: n }, (_, k) => k);

function listsStore(): Store {
  const c = emptyContent("x");
  const files: { path: string; kind: FileKind; rank: number | null }[] = [
    ...range(9).map((k) => ({
      path: `a/d${k}.ts`,
      kind: "code" as const,
      rank: k + 1,
    })),
    { path: "a/h.ts", kind: "code", rank: 30 },
    ...range(9).map((k) => ({
      path: `b/i${k}.ts`,
      kind: "code" as const,
      rank: 19 - k,
    })),
    { path: "b/support.ts", kind: "test-support", rank: null },
    ...range(7).map((k) => ({
      path: `c/p${k}.ts`,
      kind: "code" as const,
      rank: 20 + k,
    })),
    { path: "notes.txt", kind: "other", rank: null },
  ];
  files.sort((a, b) => comparePaths(a.path, b.path));
  const id = (path: string) => files.findIndex((f) => f.path === path) + 1;
  const components = ["a/", "b/", "c/"];
  const componentOf = (path: string) =>
    components.indexOf(path.slice(0, path.indexOf("/") + 1)) + 1;
  c.components = components.map((path, i) => ({
    id: i + 1,
    path,
    kind: "folder",
    parent_id: null,
    files: files.filter((f) => f.kind === "code" && f.path.startsWith(path))
      .length,
    tests: files.filter(
      (f) => f.kind === "test-support" && f.path.startsWith(path),
    ).length,
    lines: 0,
  }));
  c.files = files.map((f, i) => ({
    id: i + 1,
    path: f.path,
    lang: f.kind === "other" ? null : "typescript",
    kind: f.kind,
    component_id: f.kind === "other" ? null : componentOf(f.path),
    lines: 12,
    bytes: 360,
    blob_sha: "c".repeat(40),
    mode: "100644",
    link_target: null,
    entry: 0,
    has_source: 0,
  }));
  const hub = id("a/h.ts");
  c.file_metrics = files.flatMap((f, i) =>
    f.kind === "other"
      ? []
      : [
          {
            file_id: i + 1,
            pagerank: f.rank === null ? null : 0.01,
            dependents_rank: f.rank,
            fan_in: i + 1 === hub ? 10 : 0,
            fan_out: i + 1 === hub ? 9 : 1,
            churn_90d: i + 1 === hub ? 3 : 0,
            hotspot: f.rank === null ? null : i + 1 === hub ? 0.5 : 0,
            cycle_id: null,
            core: 0,
            last_change: null,
          },
        ],
  );
  // qualname, kind, line, column, used by files; <module> first, as the row order has it
  const defs: [string, DefKind | "module", number, number, number][] = [
    ["<module>", "module", 1, 1, 0],
    ["f1", "function", 2, 1, 1],
    ["f2", "function", 3, 1, 4],
    ["e3", "function", 4, 1, 4],
    ["b", "constant", 5, 1, 2],
    ["a", "constant", 5, 10, 2],
    ["f6", "function", 6, 1, 0],
    ["f7", "function", 7, 1, 0],
    ["f8", "function", 8, 1, 0],
    ["f9", "function", 9, 1, 0],
  ];
  c.definitions = defs.map(([qualname, kind, line, col], i) => ({
    id: i + 1,
    file_id: hub,
    qualname,
    ordinal: 1,
    name: qualname,
    kind,
    start_line: line,
    start_col: col,
    end_line: line,
    end_col: col + 1,
    exported: 1,
    parent_id: null,
    scip_symbol: null,
    signature: null,
    producer: "ast-grep",
  }));
  // b is used by 2 files, only 1 of them through a compiler-bound use
  c.def_metrics = defs.flatMap(([qualname, kind, , , used], i) =>
    kind === "module"
      ? []
      : [
          {
            def_id: i + 1,
            used_by_files: used,
            used_by_files_bound: qualname === "b" ? 1 : used,
            mentioned_by_tests: 0,
          },
        ],
  );
  c.externals = [{ id: 1, ecosystem: "npm", name: "left-pad", files: 1 }];
  type Row = [number, number | null, number | null, ImportKind, number];
  // source, imported file, imported library, kind, line
  const imports: Row[] = [
    ...range(9).map((k): Row => [hub, id(`a/d${k}.ts`), null, "static", k + 1]),
    [hub, null, 1, "static", 10],
    [hub, null, null, "static", 11],
    ...range(9).map((k): Row => [id(`b/i${k}.ts`), hub, null, "static", 1]),
    [id("b/i0.ts"), hub, null, "type-only", 2],
    [id("b/support.ts"), hub, null, "static", 1],
  ];
  imports.sort((a, b) => a[0] - b[0] || a[4] - b[4]);
  c.imports = imports.map(([src, dst, ext, kind, line], i) => ({
    id: i + 1,
    src_file_id: src,
    dst_file_id: dst,
    dst_external_id: ext,
    kind,
    line,
    specifier: dst === null && ext === null ? "./missing" : "./x",
    resolved: dst !== null || ext !== null ? 1 : 0,
    producer: "dependency-cruiser",
  }));
  c.cochange = [5, 3, 3, 9, 2, 2, 7].map((commits, k) => ({
    file_id: hub,
    partner_file_id: id(`c/p${k}.ts`),
    commits,
  }));
  const store = openStore(miniStore(c));
  if ("code" in store) throw new Error(`the lists store: ${store.reason}`);
  return store;
}

describe("the lists of an answer", () => {
  const ls = listsStore();
  const hub = asFile(queryExplain(ls, { repo: "x", target: "a/h.ts" }, X_CTX));

  it("lists distinct importers and repo imports by rank, 8 of each", () => {
    expect(hub.metrics).toEqual({
      dependentsRank: 30,
      importedBy: 10,
      imports: 9,
      commits90d: 3,
      hotspot: 0.5,
    });
    expect(hub.importedBy).toEqual({
      total: 10,
      top: [8, 7, 6, 5, 4, 3, 2, 1].map((k) => `x:b/i${k}.ts`),
    });
    expect(hub.imports).toEqual({
      total: 9,
      top: range(8).map((k) => `x:a/d${k}.ts`),
    });
  });

  it("keeps 6 co-change partners, by commits and then path", () =>
    expect(hub.changesTogetherWith).toEqual([
      { id: "x:c/p3.ts", commits: 9 },
      { id: "x:c/p6.ts", commits: 7 },
      { id: "x:c/p0.ts", commits: 5 },
      { id: "x:c/p1.ts", commits: 3 },
      { id: "x:c/p2.ts", commits: 3 },
      { id: "x:c/p4.ts", commits: 2 },
    ]));

  it("keeps 8 definitions by users, line and qualname, without the module row", () => {
    expect(hub.definitions.total).toBe(9);
    expect(hub.definitions.top.map((d) => d.id)).toEqual(
      ["f2", "e3", "a", "b", "f1", "f6", "f7", "f8"].map(
        (q) => `x:a/h.ts#${q}`,
      ),
    );
  });

  it("labels a definition scoped when one counted file has no bound use", () => {
    const def = (target: string) =>
      asDef(queryExplain(ls, { repo: "x", target }, X_CTX));
    expect(def("a/h.ts#b")).toMatchObject({
      usedByFiles: 2,
      label: "scoped",
      note: "includes files that use the name inside files importing its module, without a compiler binding; code_callers labels each use",
    });
    expect(def("a/h.ts#a")).toMatchObject({
      usedByFiles: 2,
      label: "bound",
      note: "every counted file has a compiler-bound use; code_callers lists each use with its line",
    });
  });

  it("explains test support as a test file", () =>
    expect(
      answer(queryExplain(ls, { repo: "x", target: "b/support.ts" }, X_CTX)),
    ).toMatchObject({
      kind: "test-file",
      component: "b",
      metrics: {
        dependentsRank: null,
        importedBy: 0,
        imports: 1,
        commits90d: 0,
        hotspot: 0,
      },
      importedBy: { total: 0, top: [] },
      imports: { total: 1, top: ["x:a/h.ts"] },
      changesTogetherWith: [],
      definitions: { total: 0, top: [] },
    }));

  it("words each refusal", () => {
    const refusal = (target: string) =>
      error(queryExplain(ls, { repo: "x", target }, X_CTX));
    const takes = "code_explain takes a code file or a definition";
    expect(refusal("x:a/")).toEqual({
      code: "invalid_argument",
      message: `target is a component; ${takes}`,
      field: "target",
      hint: "code_overview describes repos and components",
    });
    expect(refusal("x:")).toEqual({
      code: "invalid_argument",
      message: `target is a repo; ${takes}`,
      field: "target",
      hint: "code_overview describes repos and components",
    });
    expect(refusal("x:npm:left-pad")).toEqual({
      code: "invalid_argument",
      message: `target is a library; ${takes}`,
      field: "target",
      hint: "code_references lists a library's importers",
    });
    expect(refusal("notes.txt")).toEqual({
      code: "invalid_argument",
      message: `target is an other file; ${takes}`,
      field: "target",
      hint: "code_snippet shows its lines; code_search_text searches it",
    });
    expect(error(x("package.json")).message).toBe(
      `target is a config file; ${takes}`,
    );
    expect(refusal("a/nope.ts")).toMatchObject({
      code: "not_found",
      field: "target",
    });
  });
});

describe("compiler tiers", () => {
  it("names the languages a compiler tier covers, and only own keys", () => {
    expect(
      ["typescript", "javascript", "python", "shell", null].map(displayLang),
    ).toEqual(["TypeScript", "JavaScript", "Python", "shell", "unknown"]);
    expect(["constructor", "toString", "__proto__"].map(displayLang)).toEqual([
      "constructor",
      "toString",
      "__proto__",
    ]);
  });

  it("says whether a compiler ran, and why not", () => {
    const quick = openTiny({ detail: "quick" });
    const deep = openTiny({ detail: "deep" });
    const failed = openTiny({ tiers: { "scip-typescript": "failed" } });
    const python = openTiny({
      detail: "deep",
      tiers: { "scip-typescript": "ran", "scip-python": "ran" },
    });
    const not = (reason: string) => ({ ran: false, reason });
    expect(compilerTier(s, "typescript")).toEqual({ ran: true });
    expect(compilerTier(s, "javascript")).toEqual({ ran: true });
    expect(compilerTier(quick, "javascript")).toEqual(not("quick detail"));
    expect(compilerTier(failed, "typescript")).toEqual(
      not("scip-typescript fell back"),
    );
    // a tier that ran out of memory says so, with its repair, in place of "fell back"
    const capped =
      "reached the 3G memory cap; rebuild with a larger --memory-max";
    const outOfMemory = (tiers: Record<string, string>) =>
      openTiny({
        detail: "deep",
        tiers: { "scip-typescript": "failed", "scip-python": "failed" },
        outOfMemory: { memoryMax: "3G", tiers },
      });
    expect(
      compilerTier(outOfMemory({ "scip-typescript": capped }), "typescript"),
    ).toEqual(not(`scip-typescript ${capped}`));
    expect(
      compilerTier(outOfMemory({ "scip-python": capped }), "python"),
    ).toEqual(not(`scip-python ${capped}`));
    // another tier's reason is not this one's
    expect(
      compilerTier(outOfMemory({ "scip-python": capped }), "typescript"),
    ).toEqual(not("scip-typescript fell back"));
    expect(compilerTier(quick, "python")).toEqual(not("quick detail"));
    expect(compilerTier(s, "python")).toEqual(not("below deep detail"));
    expect(compilerTier(deep, "python")).toEqual(not("scip-python fell back"));
    expect(compilerTier(python, "python")).toEqual({ ran: true });
    expect(compilerTier(python, "shell")).toEqual(
      not("no compiler tier for this language"),
    );
    expect(compilerTier(s, null)).toEqual(
      not("no compiler tier for this language"),
    );
  });

  it("labels an unused definition bound once its compiler ran", () => {
    const python = openTiny({
      detail: "deep",
      tiers: { "scip-typescript": "ran", "scip-python": "ran" },
    });
    expect(answer(x("py/pkg/util.py#helper", python))).toMatchObject({
      label: "bound",
      note: "no other production file uses it",
    });
    const helper = storeIndex(s).defs.get(14);
    if (helper === undefined) throw new Error("tiny has no definition 14");
    expect(explainLabel(s, helper, null).note).toBe(
      "no other production file uses it by name in files that import its module; no compiler ran for unknown in this build (no compiler tier for this language), so check code_callers' unscoped matches",
    );
  });
});
