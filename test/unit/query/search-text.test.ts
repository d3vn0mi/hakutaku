import { expect, it } from "vitest";
import {
  type QueryCtx,
  type QueryOut,
  querySearchText,
} from "../../../src/query/index.js";
import { openStore, type Store } from "../../../src/store/index.js";
import type { ToolError } from "../../../src/tools/errors.js";
import type { Checked, SearchTextAnswer } from "../../../src/tools/types.js";
import { emptyContent, miniStore } from "../../helpers/mini-store.js";
import { openTiny, TINY_CTX } from "../../helpers/tiny.js";

const answer = (out: QueryOut<SearchTextAnswer>): SearchTextAnswer => {
  if (!out.ok) throw new Error(`an error: ${JSON.stringify(out.error)}`);
  return out.answer;
};
const error = (out: QueryOut<SearchTextAnswer>): ToolError => {
  if (out.ok) throw new Error(`an answer: ${JSON.stringify(out.answer)}`);
  return out.error;
};

type Args = Partial<Checked<"code_search_text">> &
  Pick<Checked<"code_search_text">, "text">;

const s = openTiny();
const bare = openTiny({ noSource: true });

// Store "s": z.ts ranks first; a.ts and b.ts have no rank, so they go by path. a.ts's line 2
// starts with U+FFFD, and b.ts's line 3 holds a NUL.
const S_CTX: QueryCtx = Object.freeze({
  repo: "s",
  builtCommit: "fedcba987654",
  stale: false,
  snippets: true,
});

const ranked = rankStore();

const st = (a: Args, store: Store = s, q: QueryCtx = TINY_CTX) =>
  querySearchText(store, { repo: q.repo, limit: 50, ...a }, q);
const where = (a: Args, store: Store = s, q: QueryCtx = TINY_CTX) =>
  answer(st(a, store, q)).hits.map((h) => `${h.file}:${h.line}`);

it("finds a literal, case-sensitive, by rank", () => {
  const a = answer(st({ text: "position(" }));
  expect(Object.keys(a)).toEqual(["text", "builtCommit", "stale", "hits"]);
  expect(a.hits).toEqual([
    {
      file: "tiny:lib/orbit.ts",
      line: 12,
      text: "position(t: number): number[] {",
    },
    {
      file: "tiny:lib/render.ts",
      line: 6,
      text: "const p = body.position(t);",
    },
    {
      file: "tiny:lib/orbit.test.ts",
      line: 4,
      text: "expect(o.position(0)).toEqual([1, 0]);",
    },
    {
      file: "tiny:lib/orbit.test.ts",
      line: 5,
      text: "expect(c.position(1)[0]).toBeCloseTo(-1);",
    },
  ]);
  expect(answer(st({ text: "Position(" })).hits).toEqual([]);
});

it("escapes quotes in the literal", () => {
  expect(answer(st({ text: '"./orbit"' })).hits.map((h) => h.file)).toEqual([
    "tiny:lib/render.ts",
    "tiny:lib/orbit.test.ts",
  ]);
});

it("globs never reach a filesystem: they filter stored paths only", () => {
  expect(
    answer(st({ text: "import", path_glob: "app/*.ts" })).hits.map(
      (h) => h.line,
    ),
  ).toEqual([1, 2, 3]);
  for (const g of ["../**", "/etc/*", "/var/**"]) {
    expect(answer(st({ text: "import", path_glob: g })).hits).toEqual([]);
  }
  expect(
    error(st({ text: "import", path_glob: "*".repeat(257) })),
  ).toMatchObject({ code: "invalid_argument", field: "path_glob" });
});

it("answers no_source without sources, and drops text when snippets are off", () => {
  expect(error(st({ text: "import" }, bare))).toMatchObject({
    code: "no_source",
  });
  const hits = answer(
    st({ text: "import" }, s, { ...TINY_CTX, snippets: false }),
  ).hits;
  expect(hits.every((h) => !("text" in h))).toBe(true);
  expect(hits.map((h) => `${h.file}:${h.line}`)).toEqual(
    where({ text: "import" }),
  );
});

it("echoes the text, and lists every line that holds it by rank, then path, then line", () => {
  expect(answer(st({ text: "position(" })).text).toBe("position(");
  expect(where({ text: "import" })).toEqual([
    "tiny:lib/orbit.ts:1",
    "tiny:lib/render.ts:1",
    "tiny:lib/render.ts:2",
    "tiny:lib/render.ts:3",
    "tiny:app/main.ts:1",
    "tiny:app/main.ts:2",
    "tiny:app/main.ts:3",
    "tiny:lib/orbit.test.ts:1",
    "tiny:lib/orbit.test.ts:2",
  ]);
  expect(where({ text: "needle" }, ranked, S_CTX)).toEqual([
    "s:z.ts:2",
    "s:a.ts:1",
    "s:a.ts:3",
    "s:b.ts:1",
    "s:b.ts:2",
  ]);
  expect(where({ text: "import", path_glob: "**.test.ts" })).toEqual([
    "tiny:lib/orbit.test.ts:1",
    "tiny:lib/orbit.test.ts:2",
  ]);
});

it("caps path_glob at 256 UTF-16 units, before it reads the store", () => {
  expect(error(st({ text: "import", path_glob: "*".repeat(257) }))).toEqual({
    code: "invalid_argument",
    message: "path_glob must have at most 256 characters",
    field: "path_glob",
    hint: "see the input schema of code_search_text",
  });
  // 256 stars are 128 double stars, which match every path
  expect(where({ text: "import", path_glob: "*".repeat(256) })).toEqual(
    where({ text: "import" }),
  );
  const face = String.fromCodePoint(0x1f600); // 129 of them: 258 units, 129 characters
  expect(
    error(st({ text: "import", path_glob: face.repeat(129) })),
  ).toMatchObject({ code: "invalid_argument", field: "path_glob" });
  expect(
    error(st({ text: "import", path_glob: "*".repeat(257) }, bare)),
  ).toMatchObject({ code: "invalid_argument", field: "path_glob" });
});

it("words no_source with the repo", () => {
  expect(error(st({ text: "import" }, bare))).toEqual({
    code: "no_source",
    message: "sources are not stored for tiny",
  });
  expect(
    error(st({ text: "import" }, bare, { ...TINY_CTX, snippets: false })),
  ).toEqual({ code: "no_source", message: "sources are not stored for tiny" });
});

it("reads FTS5 syntax as literal text, and never throws on it", () => {
  expect(where({ text: "i++" })).toEqual(["tiny:lib/orbit.ts:5"]);
  expect(where({ text: "[1, 0]" })).toEqual(["tiny:lib/orbit.test.ts:4"]);
  expect(where({ text: "e < 1" })).toEqual(["tiny:lib/orbit.ts:7"]);
  expect(where({ text: "solve(" })).toEqual([
    "tiny:lib/orbit.ts:3",
    "tiny:lib/orbit.ts:13",
    "tiny:lib/render.ts:7",
    "tiny:app/main.ts:6",
  ]);
  const nul = String.fromCharCode(0);
  const lone = String.fromCharCode(0xd83d); // a high surrogate with no pair
  for (const text of [
    '""""',
    'x"y',
    "NEAR(o c)",
    "a OR b",
    "solve*",
    "^import",
    "text:import",
    "{text}: import",
    "-import",
    `imp${nul}ort`,
    `${lone}ort`,
  ]) {
    expect(answer(st({ text })).hits).toEqual([]);
  }
});

it("keeps only the rows whose text holds the literal itself", () => {
  const replacement = String.fromCharCode(0xfffd);
  const lone = String.fromCharCode(0xd83d);
  // SQLite reads a lone surrogate as U+FFFD, so the index matches a.ts's line 2
  const matched = ranked.db
    .prepare("SELECT count(*) AS n FROM text_index WHERE text_index MATCH ?")
    .get(`"${lone}abc"`);
  expect(matched).toEqual({ n: 1 });
  expect(where({ text: `${lone}abc` }, ranked, S_CTX)).toEqual([]);
  expect(where({ text: `${replacement}abc` }, ranked, S_CTX)).toEqual([
    "s:a.ts:2",
  ]);
});

it("answers no hits for a literal that holds a NUL, without asking the index", () => {
  const nul = String.fromCharCode(0);
  // b.ts's line 3 holds x, NUL, y, z, but SQLite hands a stored line back only up to its NUL
  expect(where({ text: `x${nul}y` }, ranked, S_CTX)).toEqual([]);
  expect(where({ text: `${nul}yz` }, ranked, S_CTX)).toEqual([]);
  expect(where({ text: `imp${nul}ort` })).toEqual([]);
  expect(where({ text: `${nul}${nul}${nul}` })).toEqual([]);
});

function rankStore(): Store {
  const c = emptyContent("s");
  const sources: [string, string[]][] = [
    ["a.ts", ["needle 1", `${String.fromCharCode(0xfffd)}abc`, "needle 3"]],
    ["b.ts", ["needle 1", "needle 2", `x${String.fromCharCode(0)}yz`]],
    ["z.ts", ["x", "needle 2"]],
  ];
  c.files = sources.map(([path, lines], i) => ({
    id: i + 1,
    path,
    lang: "typescript",
    kind: "code",
    component_id: null,
    lines: lines.length,
    bytes: 30,
    blob_sha: "c".repeat(40),
    mode: "100644",
    link_target: null,
    entry: 0,
    has_source: 1,
  }));
  c.sources = sources.map(([, lines], i) => ({
    file_id: i + 1,
    text: lines.join("\n"),
  }));
  c.text_index = sources.flatMap(([, lines], i) =>
    lines.map((text, k) => ({ text, file_id: i + 1, line: k + 1 })),
  );
  c.file_metrics = [
    {
      file_id: 3,
      pagerank: 0.5,
      dependents_rank: 1,
      fan_in: 1,
      fan_out: 0,
      churn_90d: 0,
      hotspot: 0,
      cycle_id: null,
      core: 0,
      last_change: null,
    },
  ];
  const store = openStore(miniStore(c));
  if ("code" in store) throw new Error(`store s: ${store.reason}`);
  return store;
}
