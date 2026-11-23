// The data source of an exported page: everything it answers comes from the page's own data
// block, and it asks nothing of anyone. A tool call gets the answer stored for exactly that call,
// a tool's error as a 422, and a call the page holds no answer for status 0; a source the page
// does not hold is no_source. A data block that is not a page's map is refused.
import { expect, it } from "vitest";
import type { ToolName } from "../../../../src/tools/types.js";
import { ApiError } from "../../../../src/viewer/app/data-types.js";
import {
  agentCall,
  callText,
} from "../../../../src/viewer/app/detail/agent-call.js";
import {
  embeddedSource,
  parseEmbedded,
} from "../../../../src/viewer/app/embedded.js";
import { buildModel } from "../../../../src/viewer/app/model.js";
import type { Sel } from "../../../../src/viewer/app/state.js";
import {
  buildStaticBundle,
  escapeForDataBlock,
  type StaticBundle,
} from "../../../../src/viewer/export-page.js";
import { tinyHost } from "../tiny-host.js";
import { tinyStore } from "../tiny-store.js";

const NONE = { ok: false, status: 0, text: "", build: null };
const GRAPH = "tiny:src/core/graph.ts";

const bundleOf = (
  opts: { withSource: boolean; agentUpTo?: number },
  host = tinyHost(tinyStore()),
): StaticBundle => buildStaticBundle(host, undefined, "tiny", opts);

// The bundle as the page reads it back from its data block.
const asRead = (b: StaticBundle): StaticBundle =>
  parseEmbedded(escapeForDataBlock(JSON.stringify(b)));

it("answers each node's Agent call, as the tab asks it, with the answer stored for it", async () => {
  const bundle = asRead(bundleOf({ withSource: false }));
  const model = buildModel(bundle.map);
  const source = embeddedSource(bundle);
  expect(source.kind).toBe("embedded");
  const { files, defs, components, externals } = bundle.map;
  const sels: Sel[] = [
    ...files.map((_, file): Sel => ({ kind: "file", file })),
    ...defs.file.map((file, def): Sel => ({ kind: "definition", file, def })),
    ...components.map(
      (_, component): Sel => ({ kind: "component", component }),
    ),
    ...externals.map((_, external): Sel => ({ kind: "library", external })),
  ];
  const asked: string[] = [];
  for (const sel of sels) {
    const call = agentCall(model, sel);
    if (call === null) throw new Error(`no call for ${JSON.stringify(sel)}`);
    const [, id] = Object.values(call.args);
    const stored = bundle.agent?.[id];
    expect(stored?.call, id).toBe(callText(call));
    // an answer is a 200; the tool's error, as for the config file, a 422
    expect(await source.tool(call.tool, call.args), id).toEqual({
      ok: stored?.ok,
      status: stored?.ok ? 200 : 422,
      text: stored?.text,
      build: bundle.map.build,
    });
    asked.push(id);
  }
  // every answer the page holds is one the tab asks for
  expect(asked.sort()).toEqual(Object.keys(bundle.agent ?? {}).sort());
  expect(
    Object.entries(bundle.agent ?? {}).map(([id, a]) => [id, a.ok]),
  ).toContainEqual(["tiny:package.json", false]);
});

it("gives a tool's error as a 422 with its text", async () => {
  // the tools' gate knows no repo, so every call answers an error
  const base = tinyHost(tinyStore());
  const bundle = bundleOf({ withSource: false }, { ...base, repos: () => [] });
  const stored = bundle.agent?.[GRAPH];
  expect(stored?.ok).toBe(false);
  expect(
    await embeddedSource(bundle).tool("code_explain", {
      repo: "tiny",
      target: GRAPH,
    }),
  ).toEqual({
    ok: false,
    status: 422,
    text: stored?.text,
    build: bundle.map.build,
  });
});

it("holds no answer for a call it did not store, which is status 0", async () => {
  const source = embeddedSource(asRead(bundleOf({ withSource: false })));
  const calls: Array<[ToolName, Record<string, unknown>]> = [
    // a file the page does not hold
    ["code_explain", { repo: "tiny", target: "tiny:src/nowhere.ts" }],
    // the same file asked another way: arguments in another order, or one more
    ["code_explain", { target: GRAPH, repo: "tiny" }],
    ["code_explain", { repo: "tiny", target: GRAPH, limit: "5" }],
    ["code_explain", { repo: "other", target: GRAPH }],
    // a node's ID with another node's tool
    ["code_overview", { repo: "tiny", component: GRAPH }],
    ["code_references", { repo: "tiny", symbol: "tiny:src/core/" }],
    // a tool the tab never asks
    ["code_find", { repo: "tiny", query: "graph" }],
    // no ID, or one that is not a string
    ["code_explain", { repo: "tiny" }],
    ["code_explain", { repo: "tiny", target: 42 }],
    // the names every object inherits hold nothing
    ["code_explain", { repo: "tiny", target: "constructor" }],
    ["code_explain", { repo: "tiny", target: "__proto__" }],
    ["code_explain", { repo: "tiny", target: "toString" }],
  ];
  for (const [name, args] of calls) {
    expect(await source.tool(name, args), JSON.stringify(args)).toEqual(NONE);
  }
  // a page written above the limit holds no answer at all
  const none = embeddedSource(
    asRead(bundleOf({ withSource: false, agentUpTo: 0 })),
  );
  expect(
    await none.tool("code_explain", { repo: "tiny", target: GRAPH }),
  ).toEqual(NONE);
});

it("serves the page's map, history and sources, and no source it does not hold", async () => {
  const bundle = asRead(bundleOf({ withSource: true }));
  const source = embeddedSource(bundle);
  expect(await source.map()).toBe(bundle.map);
  expect(await source.history()).toBe(bundle.history);
  expect(await source.source(GRAPH)).toBe(bundle.sources?.[GRAPH]);
  for (const file of [
    "tiny:src/nowhere.ts",
    "constructor",
    "__proto__",
    "toString",
  ]) {
    const asked = source.source(file);
    await expect(asked, file).rejects.toBeInstanceOf(ApiError);
    await expect(asked, file).rejects.toMatchObject({
      status: 404,
      error: { code: "no_source" },
    });
  }
  const without = embeddedSource(asRead(bundleOf({ withSource: false })));
  await expect(without.source(GRAPH)).rejects.toMatchObject({
    status: 404,
    error: { code: "no_source" },
  });
  // the map holds every outline, so none is asked of the page
  await expect(source.outline(GRAPH)).rejects.toMatchObject({
    status: 404,
    error: { code: "not_found" },
  });
});

it("reads a page's data block, and refuses one that is not a page's map", () => {
  const bundle = bundleOf({ withSource: true });
  expect(parseEmbedded(escapeForDataBlock(JSON.stringify(bundle)))).toEqual(
    JSON.parse(JSON.stringify(bundle)),
  );
  const { format: _, ...noFormat } = bundle;
  for (const bad of [
    "",
    "{",
    "null",
    "[]",
    '"map"',
    "1",
    JSON.stringify({ ...bundle, format: 2 }),
    JSON.stringify(noFormat),
    JSON.stringify({ ...bundle, map: null }),
    JSON.stringify({ ...bundle, map: [] }),
    JSON.stringify({ ...bundle, history: null }),
    JSON.stringify({ ...bundle, sources: [] }),
    JSON.stringify({ ...bundle, sources: "x" }),
    JSON.stringify({ ...bundle, agent: [] }),
    JSON.stringify({ ...bundle, agent: 1 }),
  ]) {
    expect(() => parseEmbedded(bad), bad.slice(0, 40)).toThrow(ApiError);
  }
  // sources and answers may be absent from a page, as null
  expect(
    parseEmbedded(JSON.stringify({ ...bundle, sources: null, agent: null })),
  ).toMatchObject({ sources: null, agent: null });
});
