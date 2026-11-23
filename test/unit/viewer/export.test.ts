// The static export: one self-contained page under a hash CSP, holding the map, its history, the
// tools' own answers for every node and, when asked for, the redacted sources. Nothing in the
// repository's text can end the page's data block, nothing in the bundle may end or double-escape
// its script, and the page is written whole or not at all.
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { formatId, type NodeRef } from "../../../src/model/index.js";
import {
  ECOSYSTEMS,
  F,
  FLAG_SOURCE,
  historyData,
  INLINE_OUTLINES_UP_TO,
  mapData,
  sourceData,
} from "../../../src/query/view/index.js";
import { openStore, type Store } from "../../../src/store/index.js";
import type { StoreContent } from "../../../src/store/types.js";
import { type Host, runTool } from "../../../src/tools/index.js";
import {
  buildStaticBundle,
  escapeForDataBlock,
  exportStaticPage,
  type StaticBundle,
} from "../../../src/viewer/export-page.js";
import {
  inlineViewerHtml,
  scriptHazard,
  styleHazard,
} from "../../../src/viewer/inline.js";
import { emptyContent, miniStore } from "../../helpers/mini-store.js";
import { tinyHost } from "./tiny-host.js";
import { TINY_SOURCES, tinyStore } from "./tiny-store.js";

const BUNDLE_FILES = "../../../src/viewer/bundle-files.js";
// A backslash, built from its code: written as an escape, this file would hold the character it
// names instead.
const BACKSLASH = String.fromCharCode(92);
const jsonEscape = (hex: string) => `${BACKSLASH}u${hex}`;

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  vi.doUnmock(BUNDLE_FILES);
  vi.resetModules();
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-export-"));
  made.push(dir);
  return dir;
}

const sha = (s: string) => createHash("sha256").update(s).digest("base64");

// The text inside the first element that open starts.
function inner(html: string, open: RegExp): string {
  const m = html.match(
    new RegExp(`${open.source}([\\s\\S]*?)</(script|style)>`),
  );
  if (m === null) throw new Error(`no ${open.source} in the page`);
  return m[1];
}

const DATA_BLOCK = /<script type="application\/json" id="hakutaku-data">/;

// The bundle a page holds, read back from its data block.
const bundleOf = (html: string): StaticBundle =>
  JSON.parse(inner(html, DATA_BLOCK));

// A tool's answer as the export stores it: the answer, or the error, as indented JSON, and
// whether it is an answer.
function answered(
  host: Host,
  tool: string,
  args: object,
): { text: string; ok: boolean } {
  const r = runTool(host, undefined, tool, args);
  return {
    text: JSON.stringify(r.ok ? r.answer : { error: r.error }, null, 2),
    ok: r.ok,
  };
}

// emptyContent(repo), plus one component and one production code file at path, with its metrics
// row.
function oneFileContent(repo: string, path: string): StoreContent {
  const base = emptyContent(repo);
  return {
    ...base,
    components: [
      {
        id: 1,
        path: "src/",
        kind: "folder",
        parent_id: null,
        files: 1,
        tests: 0,
        lines: 1,
      },
    ],
    files: [
      {
        id: 1,
        path,
        lang: "typescript",
        kind: "code",
        component_id: 1,
        lines: 1,
        bytes: 22,
        blob_sha: "c".repeat(40),
        mode: "100644",
        link_target: null,
        entry: 0,
        has_source: 0,
      },
    ],
    file_metrics: [
      {
        file_id: 1,
        pagerank: 1,
        dependents_rank: 1,
        fan_in: 0,
        fan_out: 0,
        churn_90d: 0,
        hotspot: 0,
        cycle_id: null,
        core: 1,
        last_change: null,
      },
    ],
  };
}

// n production code files, src/f00000.ts on, with no component, no metrics and no source.
function manyFilesContent(n: number): StoreContent {
  const base = emptyContent("many");
  return {
    ...base,
    files: Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      path: `src/f${String(i).padStart(5, "0")}.ts`,
      lang: "typescript",
      kind: "code",
      component_id: null,
      lines: 1,
      bytes: 1,
      blob_sha: "c".repeat(40),
      mode: "100644",
      link_target: null,
      entry: 0,
      has_source: 0,
    })),
  };
}

function opened(path: string): Store {
  const store = openStore(path);
  if ("code" in store) throw new Error(`no store at ${path}`);
  return store;
}

interface NodeCall {
  id: string;
  tool: string;
  args: Record<string, string>;
}

// Every node a page can select, as the map names it, with the call an agent makes for it: each
// component, each file, each definition and each library.
function nodeCalls(b: StaticBundle): NodeCall[] {
  const { repo, files, defs, components, externals } = b.map;
  const call = (tool: string, key: string, ref: NodeRef): NodeCall => {
    const id = formatId(ref);
    return { id, tool, args: { repo, [key]: id } };
  };
  return [
    ...components.map(([path]) =>
      call("code_overview", "component", {
        kind: "directory",
        repo,
        path: `${path}/`,
      }),
    ),
    ...files.map((f) =>
      call("code_explain", "target", { kind: "file", repo, path: f[F.path] }),
    ),
    ...defs.file.map((file, i) =>
      call("code_explain", "target", {
        kind: "definition",
        repo,
        path: files[file][F.path],
        qualname: defs.name[i],
        ordinal: defs.ordinal[i],
      }),
    ),
    ...externals.map(([ecosystem, name]) =>
      call("code_references", "symbol", {
        kind: "external",
        repo,
        ecosystem: ECOSYSTEMS[ecosystem],
        name,
      }),
    ),
  ];
}

it("puts the CSP first, and names exactly the inline script and style", () => {
  const { html, csp } = inlineViewerHtml(escapeForDataBlock("{}"));
  const js = inner(html, /<script>/);
  const css = inner(html, /<style>/);
  expect(csp).toBe(
    `default-src 'none'; script-src 'sha256-${sha(js)}'; style-src 'sha256-${sha(css)}'; font-src data:; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'`,
  );
  expect(
    html.indexOf('<meta http-equiv="Content-Security-Policy"'),
  ).toBeLessThan(Math.min(html.indexOf("<style"), html.indexOf("<script")));
  expect([
    html.match(/<script>/g)?.length,
    html.match(/<style>/g)?.length,
    html.match(new RegExp(DATA_BLOCK.source, "g"))?.length,
  ]).toEqual([1, 1, 1]);
});

it("inlines the fonts as data URIs and nothing as a style attribute", () => {
  const { html } = inlineViewerHtml(null);
  expect(html.match(/url\(data:font\/woff2;base64,/g)).toHaveLength(6);
  expect(html).not.toMatch(/url\(plex-|\sstyle=/);
});

it("holds no source without --with-source, and the redacted sources with it", () => {
  const path = tinyStore();
  const host = tinyHost(path);
  const without = buildStaticBundle(host, undefined, "tiny", {
    withSource: false,
  });
  expect(without.sources).toBeNull();
  // a page without sources says so: its map holds none
  expect(without.map.sources).toBe(false);
  const b = buildStaticBundle(host, undefined, "tiny", { withSource: true });
  expect(b.sources?.["tiny:src/core/graph.ts"]?.text).toBe(
    TINY_SOURCES["src/core/graph.ts"],
  );
  expect(b.map.sources).toBe(true);
  // every file with a stored source, by its ID, as the API answers it
  const store = opened(path);
  try {
    const held = b.map.files.flatMap(
      (f, i): Array<[string, number]> =>
        (f[F.flags] & FLAG_SOURCE) === 0
          ? []
          : [[formatId({ kind: "file", repo: "tiny", path: f[F.path] }), i]],
    );
    expect(held).toHaveLength(5);
    expect(Object.keys(b.sources ?? {})).toEqual(held.map(([id]) => id));
    // a file's store id is its place in the map plus one
    for (const [id, i] of held) {
      expect(b.sources?.[id], id).toEqual(sourceData(store, i + 1));
    }
  } finally {
    store.close();
  }
});

it("holds no source when the repo's sources are off, whatever was asked", () => {
  for (const [host, why] of [
    [tinyHost(tinyStore({ noSource: true })), "a store without sources"],
    [tinyHost(tinyStore(), { snippets: false }), "snippets off"],
  ] as const) {
    const b = buildStaticBundle(host, undefined, "tiny", { withSource: true });
    expect([b.sources, b.map.sources], why).toEqual([null, false]);
  }
});

it("stores the tools' own answers, and none above the limit", () => {
  const host = tinyHost(tinyStore());
  const b = buildStaticBundle(host, undefined, "tiny", { withSource: false });
  const args = { repo: "tiny", target: "tiny:src/core/graph.ts" };
  expect(b.agent?.["tiny:src/core/graph.ts"]).toEqual({
    call: `code_explain(${JSON.stringify(args)})`,
    text: answered(host, "code_explain", args).text,
    ok: true,
  });
  expect(Object.keys(b.agent ?? {})).toEqual(
    expect.arrayContaining([
      "tiny:src/core/",
      "tiny:npm:kleur",
      "tiny:src/core/graph.ts#helper(2)",
    ]),
  );
  // the limit counts production files: tiny has 3
  expect(
    buildStaticBundle(host, undefined, "tiny", {
      withSource: false,
      agentUpTo: 2,
    }).agent,
  ).toBeNull();
  expect(
    buildStaticBundle(host, undefined, "tiny", {
      withSource: false,
      agentUpTo: 3,
    }).agent,
  ).toEqual(b.agent);
});

it("answers every component, file, definition and library, each with its tool and the node's ID", () => {
  const host = tinyHost(tinyStore());
  const b = buildStaticBundle(host, undefined, "tiny", { withSource: false });
  const calls = nodeCalls(b);
  // 2 components, 5 files, 6 definitions (module scope left out), 2 libraries
  expect(calls).toHaveLength(15);
  expect(Object.keys(b.agent ?? {})).toEqual(calls.map((c) => c.id));
  for (const { id, tool, args } of calls) {
    const { text, ok } = answered(host, tool, args);
    expect(b.agent?.[id], id).toEqual({
      call: `${tool}(${JSON.stringify(args)})`,
      text,
      ok,
    });
    // each answer is of the map's own build; an error names none
    expect(JSON.parse(text).builtCommit, id).toBe(
      ok ? b.map.builtCommit : undefined,
    );
  }
  // the one error is the tool's own, for the config file, as the served Agent tab shows it
  expect(
    Object.entries(b.agent ?? {}).flatMap(([id, a]) => (a.ok ? [] : [id])),
  ).toEqual(["tiny:package.json"]);
  expect(
    JSON.parse(b.agent?.["tiny:package.json"]?.text ?? "").error.code,
  ).toBe("invalid_argument");
});

it("stores an error the tool answers as its own text, marked not ok", () => {
  // the tools' gate knows no repo, so every call answers an error; the store still opens
  const base = tinyHost(tinyStore());
  const host: Host = { ...base, repos: () => [] };
  const b = buildStaticBundle(host, undefined, "tiny", { withSource: false });
  const args = { repo: "tiny", target: "tiny:src/core/graph.ts" };
  const { text } = answered(host, "code_explain", args);
  expect(JSON.parse(text).error.code).toBe("unknown_repo");
  expect(b.agent?.["tiny:src/core/graph.ts"]).toEqual({
    call: `code_explain(${JSON.stringify(args)})`,
    text,
    ok: false,
  });
  expect(Object.values(b.agent ?? {}).every((a) => !a.ok)).toBe(true);
});

it("reads one build for the whole page, even when the repo is rebuilt while it is written", () => {
  const first = tinyHost(tinyStore());
  const rebuilt = tinyHost(tinyStore({ commit: "b".repeat(40) }));
  let opens = 0;
  let asked = 0;
  // the first open gives the store the export starts from, and the first freshness says it is
  // current; any later one, the rebuilt store, and a head that has moved on
  const host: Host = {
    ...first,
    open: (ctx, repo) =>
      opens++ === 0 ? first.open(ctx, repo) : rebuilt.open(ctx, repo),
    freshness: () => ({ headCommit: null, stale: asked++ !== 0 }),
  };
  const b = buildStaticBundle(host, undefined, "tiny", { withSource: true });
  expect(b.map.builtCommit).toBe("4f2a9c1e07b3");
  expect(b.map.stale).toBe(false);
  expect(b.history.builtCommit).toBe(b.map.builtCommit);
  for (const [id, src] of Object.entries(b.sources ?? {}))
    expect(src.builtCommit, id).toBe(b.map.builtCommit);
  const answers = Object.entries(b.agent ?? {});
  expect(answers).toHaveLength(15);
  // every answer is the first build's, as current as the map: each names it, but the config
  // file's error, which names no build
  for (const [id, a] of answers) {
    const answer = JSON.parse(a.text);
    expect([answer.builtCommit, answer.stale], id).toEqual(
      id === "tiny:package.json"
        ? [undefined, undefined]
        : [b.map.builtCommit, false],
    );
  }
  expect(answers.filter(([, a]) => a.ok)).toHaveLength(14);
  expect([opens, asked]).toEqual([1, 1]);
});

it("holds the map with every outline, the history and the build's facts", () => {
  const path = tinyStore();
  const host = tinyHost(path, { stale: "unknown" });
  const b = buildStaticBundle(host, undefined, "tiny", { withSource: true });
  const store = opened(path);
  try {
    expect(b.format).toBe(1);
    expect(b.map).toEqual(
      mapData(store, {
        stale: "unknown",
        snippets: true,
        inlineUpTo: Infinity,
      }),
    );
    expect(b.history).toEqual(historyData(store));
    expect(Object.keys(b)).toEqual([
      "format",
      "map",
      "history",
      "sources",
      "agent",
    ]);
  } finally {
    store.close();
  }
});

it("holds every outline and the files that change together above the served limit, and no answers", () => {
  const n = INLINE_OUTLINES_UP_TO + 1;
  const path = miniStore(manyFilesContent(n));
  const b = buildStaticBundle(
    tinyHost(path, { repos: ["many"] }),
    undefined,
    "many",
    {
      withSource: false,
    },
  );
  expect(b.map.counts.productionFiles).toBe(n);
  expect([b.map.outline === null, b.map.cochange === null]).toEqual([
    false,
    false,
  ]);
  // the agent's answers stop at the limit
  expect(b.agent).toBeNull();
  // as the served map would not hold them
  const store = opened(path);
  try {
    const served = mapData(store, { stale: false, snippets: true });
    expect([served.outline, served.cochange]).toEqual([null, null]);
  } finally {
    store.close();
  }
});

it("escapes exactly <, > and & in the data block, which JSON reads back", () => {
  expect(escapeForDataBlock("<>&")).toBe(
    `${jsonEscape("003c")}${jsonEscape("003e")}${jsonEscape("0026")}`,
  );
  const value = {
    a: "</script><script>alert(1)</script>",
    b: "<!--<script>",
    c: "&amp; &lt;",
    // the line separators, a quote, a backslash and non-ASCII text stay as they are
    d: `${String.fromCodePoint(0x2028, 0x2029)} " ${BACKSLASH} ${String.fromCodePoint(0xe9, 0x1f680)}`,
  };
  const json = JSON.stringify(value);
  const escaped = escapeForDataBlock(json);
  expect(escaped).not.toMatch(/[<>&]/);
  expect(JSON.parse(escaped)).toEqual(value);
  // nothing else changes
  expect(escaped.replace(/\\u003c|\\u003e|\\u0026/g, "")).toBe(
    json.replace(/[<>&]/g, ""),
  );
  expect(escapeForDataBlock("")).toBe("");
});

it("repository text cannot close the data block", async () => {
  const path = "src/</script><script>alert(1)</script>.ts";
  const file = join(tmp(), "m.html");
  await exportStaticPage({
    host: tinyHost(miniStore(oneFileContent("tiny", path))),
    ctx: undefined,
    repo: "tiny",
    file,
    withSource: false,
  });
  const html = readFileSync(file, "utf8");
  expect(html.match(/<\/script>/gi)).toHaveLength(2); // the data block's and the app script's
  const b = bundleOf(html);
  expect(b.map.files[0][0]).toBe(path);
  // the path's answer is held under its ID, with the path in it as text
  const id = formatId({ kind: "file", repo: "tiny", path });
  expect(b.agent?.[id]?.ok).toBe(true);
  expect(b.agent?.[id]?.text).toContain(JSON.stringify(path).slice(1, -1));
});

it("writes the page the bundle reads back, with the data block before the one script", async () => {
  const host = tinyHost(tinyStore());
  const file = join(tmp(), "m.html");
  await exportStaticPage({
    host,
    ctx: undefined,
    repo: "tiny",
    file,
    withSource: true,
  });
  const html = readFileSync(file, "utf8");
  expect(bundleOf(html)).toEqual(
    JSON.parse(
      JSON.stringify(
        buildStaticBundle(host, undefined, "tiny", { withSource: true }),
      ),
    ),
  );
  expect(html).toMatch(
    new RegExp(`${DATA_BLOCK.source}[^<]*</script><script>`),
  );
  // the page is inlineViewerHtml's for that data, exactly
  expect(html).toBe(inlineViewerHtml(inner(html, DATA_BLOCK)).html);
});

it("writes atomically, leaving no temporary file", async () => {
  const dir = tmp();
  const file = join(dir, "m.html");
  writeFileSync(file, "old");
  await exportStaticPage({
    host: tinyHost(tinyStore()),
    ctx: undefined,
    repo: "tiny",
    file,
    withSource: false,
  });
  expect(readdirSync(dir)).toEqual(["m.html"]);
  expect(readFileSync(file, "utf8")).toMatch(/^<!doctype html>/);
});

it("a page that cannot be put in place leaves no temporary file", async () => {
  const dir = tmp();
  // a directory where the page should go: the temporary file is written, the rename fails
  const file = join(dir, "m.html");
  mkdirSync(file);
  await expect(
    exportStaticPage({
      host: tinyHost(tinyStore()),
      ctx: undefined,
      repo: "tiny",
      file,
      withSource: false,
    }),
  ).rejects.toThrow();
  expect(readdirSync(dir)).toEqual(["m.html"]);
  expect(readdirSync(file)).toEqual([]);
});

it("a repo that has no store cannot be exported", async () => {
  const file = join(tmp(), "m.html");
  const host = tinyHost(join(tmp(), "store.sqlite"));
  expect(() =>
    buildStaticBundle(host, undefined, "tiny", { withSource: false }),
  ).toThrow(/tiny has no usable store/);
  await expect(
    exportStaticPage({
      host,
      ctx: undefined,
      repo: "tiny",
      file,
      withSource: false,
    }),
  ).rejects.toThrow(/tiny has no usable store/);
  expect(() =>
    buildStaticBundle(host, undefined, "ghost", { withSource: false }),
  ).toThrow(/unknown repo ghost/);
});

it("finds what would end an inline script early, or keep its end tag from ending it", () => {
  for (const text of [
    "a</script>b",
    "a</SCRIPT>b",
    "x = '</ScRiPt'",
    // a comment that holds a script tag puts the parser where "</script>" ends nothing
    "<!--<script>",
    "/<!--/ <script ",
    "<!-- <SCRIPT>",
    // a second comment that holds one, after a first that is closed
    "<!-- a --> b <!-- <script>",
    // "<!-->" closes the comment it opens, but "<!-->" followed by another comment does not help
    "<!--> <!-- <script>",
  ])
    expect(scriptHazard(text), text).not.toBeNull();
  for (const text of [
    "",
    "plain code",
    // as the bundle holds it now: the comment closes before any script tag
    "t.COMMENT(/<!--/,/-->/,{relevance:10}),{begin:/<script(?=\\s|>)/}",
    "<!-- --> <script>",
    "<!--> <script>",
    "<!---> <script>",
    "<script>",
    "<!--",
    "-->",
    "</scrip",
    "< /script>",
    "<!- -<script>",
  ])
    expect(scriptHazard(text), text).toBeNull();
  for (const text of ["</style", "a</STYLE>", "x</StYlE"])
    expect(styleHazard(text), text).not.toBeNull();
  for (const text of ["", "<style>", "</styl", "a { b: c }", "<!-- --></scrip"])
    expect(styleHazard(text), text).toBeNull();
});

it("the built bundle holds nothing that would break the page it is inlined into", () => {
  const root = new URL("../../../", import.meta.url);
  const js = readFileSync(new URL("dist/viewer/assets/app.js", root), "utf8");
  const css = readFileSync(new URL("dist/viewer/assets/app.css", root), "utf8");
  expect([scriptHazard(js), styleHazard(css)]).toEqual([null, null]);
});

// The real bundle with one asset's text replaced.
async function plantedBundle(name: string, text: string) {
  const real = await import(BUNDLE_FILES);
  const bundle = real.readBundle();
  if (bundle === null) throw new Error("run npm run build first");
  const assets = new Map(bundle.assets);
  assets.set(name, {
    type: "text/plain",
    bytes: new TextEncoder().encode(text),
  });
  return { ...bundle, assets };
}

it("refuses a bundle whose script or styles would break the page, and writes nothing", async () => {
  for (const [name, text, why] of [
    ["app.js", "console.log('</script>')", /script/],
    ["app.js", "var a = /<!--/, b = '<SCRIPT>';", /script/],
    ["app.css", "a::after { content: '</STYLE>' }", /style/],
  ] as const) {
    vi.resetModules();
    const planted = await plantedBundle(name, text);
    vi.doMock(BUNDLE_FILES, async (importOriginal) => ({
      ...(await importOriginal<object>()),
      readBundle: () => planted,
    }));
    const page = await import("../../../src/viewer/export-page.js");
    const inline = await import("../../../src/viewer/inline.js");
    expect(() => inline.inlineViewerHtml(null), text).toThrow(why);
    const dir = tmp();
    await expect(
      page.exportStaticPage({
        host: tinyHost(tinyStore()),
        ctx: undefined,
        repo: "tiny",
        file: join(dir, "m.html"),
        withSource: false,
      }),
      text,
    ).rejects.toThrow(why);
    expect(readdirSync(dir), text).toEqual([]);
    vi.doUnmock(BUNDLE_FILES);
  }
});
