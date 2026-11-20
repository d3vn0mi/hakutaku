import { expect, it } from "vitest";
import {
  type QueryCtx,
  type QueryOut,
  querySnippet,
} from "../../../src/query/index.js";
import {
  openStore,
  type Store,
  type StoreContent,
} from "../../../src/store/index.js";
import type { ToolError } from "../../../src/tools/errors.js";
import type { Checked, SnippetAnswer } from "../../../src/tools/types.js";
import { emptyContent, miniStore } from "../../helpers/mini-store.js";
import { openTiny, TINY_CTX } from "../../helpers/tiny.js";

const answer = (out: QueryOut<SnippetAnswer>): SnippetAnswer => {
  if (!out.ok) throw new Error(`an error: ${JSON.stringify(out.error)}`);
  return out.answer;
};
const error = (out: QueryOut<SnippetAnswer>): ToolError => {
  if (out.ok) throw new Error(`an answer: ${JSON.stringify(out.answer)}`);
  return out.error;
};

const s = openTiny();
const bare = openTiny({ noSource: true });
const OFF: QueryCtx = { ...TINY_CTX, snippets: false };

// The lines of src/keys.ts: two redactions on line 1, one on line 2, and a 300-character line.
const KEYS = [
  'const a = "«redacted:generic-api-key»", b = "«redacted:aws-access-key»";',
  '    const c = "«redacted:generic-api-key»";',
  "x".repeat(300),
];

// The long store, "tiny" as well: an empty file, src/keys.ts, a 300-line file with a
// definition of 150 lines and one of exactly 120, and a one-line file.
const long = opened(
  withSources(emptyContent("tiny"), [
    { path: "src/empty.ts", lines: [] },
    { path: "src/keys.ts", lines: KEYS },
    {
      path: "src/long.ts",
      lines: numbered(300),
      defs: [
        ["long", 10, 159],
        ["exact", 170, 289],
      ],
    },
    { path: "src/one.ts", lines: ["export const one = 1;"] },
  ]),
);

const sn = (
  a: Partial<Checked<"code_snippet">>,
  store: Store = s,
  q: QueryCtx = TINY_CTX,
) => querySnippet(store, { repo: q.repo, ...a }, q);

it("returns a definition's range, marked untrusted", () => {
  expect(JSON.stringify(answer(sn({ target: "lib/orbit.ts#solve" })))).toBe(
    JSON.stringify({
      id: "tiny:lib/orbit.ts#solve",
      file: "tiny:lib/orbit.ts",
      builtCommit: "0123456789ab",
      stale: false,
      from: 3,
      to: 8,
      lines: [
        "export function solve(m: number): number {",
        "  let e = m;",
        "  for (let i = 0; i < 8; i++) e = m + Math.sin(e);",
        "  return toAu(e);",
        "  // converges for e < 1",
        "}",
      ],
      truncated: false,
      redactions: 0,
      untrusted: true,
      view: "#lib~orbit.ts--solve",
    }),
  );
});

it("returns a file range and counts redactions", () => {
  expect(answer(sn({ file: "app/main.ts", from: 4, to: 6 }))).toMatchObject({
    from: 4,
    to: 6,
    redactions: 1,
  });
  expect(answer(sn({ file: "lib/render.ts" }))).toMatchObject({
    from: 1,
    to: 8,
    truncated: false,
  });
});

it("caps at 120 lines and points next past the cap", () => {
  // component src/ and one 300-line source file src/long.ts, built in the test
  const big = opened(withLongFile(emptyContent("tiny"), 300));
  expect(answer(sn({ file: "src/long.ts" }, big))).toMatchObject({
    from: 1,
    to: 120,
    truncated: true,
    next: { from: 121, to: 240 },
  });
});

it("refuses denylisted, unstored and malformed requests", () => {
  expect(error(sn({ file: ".env" }))).toMatchObject({ code: "denied_file" });
  expect(error(sn({ file: "lib/camera.ts" }))).toMatchObject({
    code: "no_source",
  });
  expect(error(sn({ file: "lib/render.ts" }, s, OFF))).toMatchObject({
    code: "no_source",
  });
  expect(error(sn({ file: "lib/render.ts", from: 50 }))).toMatchObject({
    field: "from",
    hint: "lib/render.ts has 8 lines",
  });
  expect(
    error(sn({ target: "lib/orbit.ts#solve", file: "lib/orbit.ts" })),
  ).toMatchObject({ field: "file" });
  expect(error(sn({ target: "lib/orbit.ts#solve", from: 1 }))).toMatchObject({
    field: "from",
  });
  expect(error(sn({}))).toMatchObject({ field: "target" });
});

it("words target and file, and checks them before the store", () => {
  const both = {
    code: "invalid_argument",
    message: "target and file cannot both be given",
    field: "file",
    hint: "pass target or file, not both",
  };
  const neither = {
    code: "invalid_argument",
    message: "target or file is required",
    field: "target",
    hint: "pass target, or file with from and to",
  };
  for (const store of [s, bare]) {
    expect(
      error(sn({ target: "lib/orbit.ts#solve", file: "lib/orbit.ts" }, store)),
    ).toEqual(both);
    expect(error(sn({ target: "nope", file: "nope" }, store, OFF))).toEqual(
      both,
    );
    expect(error(sn({ from: 1, to: 2 }, store))).toEqual(neither);
  }
});

it("words from and to beside a definition, before no_source", () => {
  const beside = {
    code: "invalid_argument",
    message: "from and to apply to a file, not to a definition",
    field: "from",
    hint: "from and to go with file",
  };
  expect(error(sn({ target: "lib/orbit.ts#solve", from: 1 }))).toEqual(beside);
  expect(error(sn({ target: "lib/orbit.ts#solve", to: 9 }))).toEqual(beside);
  expect(error(sn({ target: "lib/orbit.ts#solve", to: 9 }, bare))).toEqual(
    beside,
  );
  expect(error(sn({ target: "lib/camera.ts#Camera", from: 2 }))).toEqual(
    beside,
  );
});

it("answers no_source for the store, then for snippets, then for the file", () => {
  const notStored = {
    code: "no_source",
    message: "sources are not stored for tiny",
  };
  const off = { code: "no_source", message: "snippets are off for tiny" };
  const camera = {
    code: "no_source",
    message:
      "lib/camera.ts has no stored source (over 1 MB, minified or generated)",
  };
  // a store built without sources marks no file has_source: its own message comes first
  expect(error(sn({ file: "lib/render.ts" }, bare))).toEqual(notStored);
  expect(error(sn({ target: "lib/orbit.ts#solve" }, bare, OFF))).toEqual(
    notStored,
  );
  expect(error(sn({ file: "lib/render.ts" }, s, OFF))).toEqual(off);
  expect(error(sn({ file: "lib/camera.ts" }, s, OFF))).toEqual(off);
  expect(error(sn({ file: "lib/camera.ts" }))).toEqual(camera);
  expect(error(sn({ target: "lib/camera.ts#Camera" }))).toEqual(camera);
  expect(error(sn({ file: "lib/camera.ts", from: 50 }))).toEqual(camera);
  // the target is resolved first
  expect(error(sn({ file: "lib/nope.ts" }, bare, OFF))).toMatchObject({
    code: "not_found",
    field: "file",
  });
});

it("takes a file as target too, with from and to", () => {
  expect(
    JSON.stringify(answer(sn({ target: "lib/render.ts", from: 2, to: 3 }))),
  ).toBe(
    JSON.stringify({
      id: "tiny:lib/render.ts",
      file: "tiny:lib/render.ts",
      builtCommit: "0123456789ab",
      stale: false,
      from: 2,
      to: 3,
      lines: [
        'import type { Body } from "./body";',
        'import { memo } from "react";',
      ],
      truncated: false,
      redactions: 0,
      untrusted: true,
      view: "#lib~render.ts",
    }),
  );
  expect(answer(sn({ target: "tiny:lib/orbit.ts#Orbit" }))).toMatchObject({
    id: "tiny:lib/orbit.ts#Orbit",
    file: "tiny:lib/orbit.ts",
    from: 10,
    to: 16,
    view: "#lib~orbit.ts--Orbit",
  });
});

it("refuses other kinds of node, and passes resolution errors on", () => {
  const overview = "code_overview describes repos and components";
  const library = "code_references lists a library's importers";
  const refused = (
    field: string,
    kind: string,
    takes: string,
    hint: string,
  ) => ({
    code: "invalid_argument",
    message: `${field} is a ${kind}; code_snippet takes ${takes}`,
    field,
    hint,
  });
  const either = "a file or a definition";
  expect(error(sn({ target: "lib/" }))).toEqual(
    refused("target", "component", either, overview),
  );
  expect(error(sn({ target: "tiny:" }))).toEqual(
    refused("target", "repo", either, overview),
  );
  expect(error(sn({ target: "tiny:npm:react" }))).toEqual(
    refused("target", "library", either, library),
  );
  expect(error(sn({ file: "lib/orbit.ts#solve" }))).toEqual(
    refused("file", "definition", "a file", "pass a definition as target"),
  );
  expect(error(sn({ file: "lib/" }))).toEqual(
    refused("file", "component", "a file", overview),
  );
  expect(error(sn({ file: "tiny:npm:react" }))).toEqual(
    refused("file", "library", "a file", library),
  );
  expect(error(sn({ target: "main" }))).toMatchObject({ code: "ambiguous" });
  expect(error(sn({ target: "lib/nope.ts" }))).toMatchObject({
    code: "not_found",
    field: "target",
  });
  expect(error(sn({ target: ".env" }))).toMatchObject({ code: "denied_file" });
});

it("reads a file's range: to past the end stops at its last line, and to below from is refused", () => {
  const range = (a: Partial<Checked<"code_snippet">>) => {
    const { from, to, lines, truncated, next } = answer(sn(a));
    return { from, to, lines: lines.length, truncated, next };
  };
  expect(range({ file: "lib/render.ts", from: 7, to: 50 })).toEqual({
    from: 7,
    to: 8,
    lines: 2,
    truncated: false,
    next: undefined,
  });
  expect(range({ file: "lib/render.ts", from: 8 })).toMatchObject({
    from: 8,
    to: 8,
    lines: 1,
  });
  expect(range({ file: "lib/render.ts", to: 2 })).toMatchObject({
    from: 1,
    to: 2,
    lines: 2,
  });
  expect(error(sn({ file: "lib/render.ts", from: 5, to: 3 }))).toEqual({
    code: "invalid_argument",
    message: "to 3 is below from 5",
    field: "to",
    hint: "to must be at least from",
  });
  expect(error(sn({ file: "lib/render.ts", from: 9 }))).toEqual({
    code: "invalid_argument",
    message: "from 9 is beyond the file",
    field: "from",
    hint: "lib/render.ts has 8 lines",
  });
  expect(error(sn({ file: "lib/render.ts", from: 50, to: 3 }))).toMatchObject({
    field: "from",
  });
});

it("pages past the cap to the end it was asked for, and never past the file", () => {
  const range = (a: Partial<Checked<"code_snippet">>) => {
    const { from, to, truncated, next } = answer(sn(a, long));
    return { from, to, truncated, next };
  };
  expect(range({ file: "src/long.ts", to: 500 })).toEqual({
    from: 1,
    to: 120,
    truncated: true,
    next: { from: 121, to: 240 },
  });
  expect(range({ file: "src/long.ts", from: 121 })).toEqual({
    from: 121,
    to: 240,
    truncated: true,
    next: { from: 241, to: 300 },
  });
  expect(range({ file: "src/long.ts", from: 241, to: 500 })).toEqual({
    from: 241,
    to: 300,
    truncated: false,
    next: undefined,
  });
  expect(range({ file: "src/long.ts", from: 1, to: 121 })).toEqual({
    from: 1,
    to: 120,
    truncated: true,
    next: { from: 121, to: 121 },
  });
  expect(range({ file: "src/long.ts", from: 200, to: 319 })).toEqual({
    from: 200,
    to: 300,
    truncated: false,
    next: undefined,
  });
  expect(range({ target: "src/long.ts#exact" })).toEqual({
    from: 170,
    to: 289,
    truncated: false,
    next: undefined,
  });
  const a = answer(sn({ target: "src/long.ts#long" }, long));
  expect(Object.keys(a)).toEqual([
    "id",
    "file",
    "builtCommit",
    "stale",
    "from",
    "to",
    "lines",
    "truncated",
    "next",
    "redactions",
    "untrusted",
    "view",
  ]);
  expect(a).toMatchObject({
    from: 10,
    to: 129,
    truncated: true,
    next: { from: 130, to: 159 },
  });
  expect(a.lines).toHaveLength(120);
  expect(a.lines[0]).toBe("line 10");
});

it("answers an empty file with no lines, and words a short file's length", () => {
  const none = {
    from: 1,
    to: 0,
    lines: [],
    truncated: false,
    redactions: 0,
  };
  expect(answer(sn({ file: "src/empty.ts" }, long))).toMatchObject(none);
  expect(answer(sn({ file: "src/empty.ts", from: 1 }, long))).toMatchObject(
    none,
  );
  expect(answer(sn({ file: "src/empty.ts", to: 5 }, long))).toMatchObject(none);
  expect(error(sn({ file: "src/empty.ts", from: 2 }, long))).toMatchObject({
    field: "from",
    hint: "src/empty.ts has 0 lines",
  });
  expect(error(sn({ file: "src/one.ts", from: 2 }, long))).toMatchObject({
    field: "from",
    hint: "src/one.ts has 1 line",
  });
});

it("returns the stored lines whole, and counts every redaction in them", () => {
  const a = answer(sn({ file: "src/keys.ts" }, long));
  expect(a.lines).toEqual(KEYS);
  expect(a.lines[2]).toHaveLength(300);
  expect(a.redactions).toBe(3);
  expect(answer(sn({ file: "src/keys.ts", from: 2 }, long)).redactions).toBe(1);
  expect(
    answer(sn({ file: "src/keys.ts", from: 3, to: 3 }, long)).redactions,
  ).toBe(0);
});

interface SourceFile {
  path: string;
  lines: string[];
  defs?: [string, number, number][]; // qualname, start line, end line
}

// "line 1" to "line n".
function numbered(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`);
}

// content plus the component src/ and one source file, src/long.ts, of n lines.
function withLongFile(content: StoreContent, n: number): StoreContent {
  return withSources(content, [{ path: "src/long.ts", lines: numbered(n) }]);
}

// content plus the component src/ holding each file, given in path order, with its source, its
// text index rows and its definitions.
function withSources(content: StoreContent, files: SourceFile[]): StoreContent {
  const defs = files.flatMap((f, i) =>
    (f.defs ?? []).map(([qualname, start, end]) => ({
      file_id: i + 1,
      qualname,
      start,
      end,
    })),
  );
  return {
    ...content,
    components: [
      {
        id: 1,
        path: "src/",
        kind: "folder",
        parent_id: null,
        files: files.length,
        tests: 0,
        lines: files.reduce((n, f) => n + f.lines.length, 0),
      },
    ],
    files: files.map((f, i) => ({
      id: i + 1,
      path: f.path,
      lang: "typescript",
      kind: "code",
      component_id: 1,
      lines: f.lines.length,
      bytes: f.lines.join("\n").length,
      blob_sha: "c".repeat(40),
      mode: "100644",
      link_target: null,
      entry: 0,
      has_source: 1,
    })),
    sources: files.map((f, i) => ({
      file_id: i + 1,
      text: f.lines.join("\n"),
    })),
    definitions: defs.map((d, i) => ({
      id: i + 1,
      file_id: d.file_id,
      qualname: d.qualname,
      ordinal: 1,
      name: d.qualname,
      kind: "function",
      start_line: d.start,
      start_col: 1,
      end_line: d.end,
      end_col: 2,
      exported: 1,
      parent_id: null,
      scip_symbol: null,
      signature: null,
      producer: "ast-grep",
    })),
    text_index: files.flatMap((f, i) =>
      f.lines.flatMap((text, k) =>
        text === "" ? [] : [{ text, file_id: i + 1, line: k + 1 }],
      ),
    ),
  };
}

function opened(content: StoreContent): Store {
  const store = openStore(miniStore(content));
  if ("code" in store) throw new Error(`a test store: ${store.reason}`);
  return store;
}
