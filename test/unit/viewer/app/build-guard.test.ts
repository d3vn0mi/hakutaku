// The rebuild guard: every answer passes through unchanged, and the first one that names
// another build than the page's map is reported, once.
import { expect, it } from "vitest";
import type {
  HistoryData,
  MapData,
  OutlineData,
  SourceData,
} from "../../../../src/query/view/types.js";
import { guardBuild } from "../../../../src/viewer/app/build-guard.js";
import {
  ApiError,
  type DataSource,
  type ToolReply,
} from "../../../../src/viewer/app/data-types.js";

// The page's map: its commit, and its store's build.
const MAP = { builtCommit: "4f2a9c1e07b3", build: "0123456789abcdef" };
const OTHER = "fedcba9876543210";

interface Answers {
  map?: unknown;
  outline?: unknown;
  source?: unknown;
  history?: unknown;
  tool?: unknown;
}

// A source whose every method resolves o's value for it.
const fakeSource = (o: Answers): DataSource => ({
  kind: "embedded",
  map: async () => o.map as MapData,
  outline: async () => o.outline as OutlineData,
  source: async () => o.source as SourceData,
  history: async () => o.history as HistoryData,
  tool: async () => o.tool as ToolReply,
});

const toolReply = (
  answer: unknown,
  ok = true,
  build: string | null = null,
): ToolReply => ({
  ok,
  status: ok ? 200 : 422,
  text: JSON.stringify(answer, null, 2),
  build,
});

it("guardBuild reports a response from another build", async () => {
  const seen: Array<string | null> = [];
  const g = guardBuild(
    fakeSource({
      outline: { builtCommit: "b0b0b0b0b0b0" },
      tool: {
        ok: true,
        status: 200,
        text: JSON.stringify({ builtCommit: "b0b0b0b0b0b0" }, null, 2),
        build: null,
      },
    }),
    MAP,
    (c) => seen.push(c),
  );
  await g.outline("tiny:src/core/graph.ts");
  await g.tool("code_explain", { repo: "tiny" });
  expect(seen).toEqual(["b0b0b0b0b0b0"]);
});

it("stays quiet for the same build and passes answers through unchanged", async () => {
  const seen: Array<string | null> = [];
  const reply = {
    ok: true,
    status: 200,
    text: '{\n  "builtCommit": "4f2a9c1e07b3"\n}',
    build: MAP.build,
  };
  const g = guardBuild(fakeSource({ tool: reply }), MAP, (c) => seen.push(c));
  expect(await g.tool("code_explain", {})).toBe(reply);
  expect(seen).toEqual([]);
});

it("checks every kind of answer, each passed through as it came", async () => {
  for (const method of ["map", "outline", "source", "history"] as const) {
    const seen: Array<string | null> = [];
    const answer = { builtCommit: "c0ffee000000" };
    const g = guardBuild(fakeSource({ [method]: answer }), MAP, (c) =>
      seen.push(c),
    );
    const got = await (g[method] as (file: string) => Promise<unknown>)(
      "tiny:src/core/graph.ts",
    );
    expect(got, method).toBe(answer);
    expect(seen, method).toEqual(["c0ffee000000"]);
  }
});

it("reports only the first other build, however many follow", async () => {
  const seen: Array<string | null> = [];
  let commit = "111111111111";
  const source: DataSource = {
    ...fakeSource({}),
    history: async () => ({ builtCommit: commit, build: MAP.build, weeks: [] }),
  };
  const g = guardBuild(source, MAP, (c) => seen.push(c));
  await g.history();
  commit = "222222222222";
  await g.history();
  commit = "4f2a9c1e07b3";
  await g.history();
  expect(seen).toEqual(["111111111111"]);
});

it("reports a tool's answer from another build on its own", async () => {
  const seen: Array<string | null> = [];
  const r = toolReply({ builtCommit: "b0b0b0b0b0b0", repo: "tiny" });
  const g = guardBuild(fakeSource({ tool: r }), MAP, (c) => seen.push(c));
  expect(await g.tool("code_explain", { repo: "tiny" })).toBe(r);
  expect(seen).toEqual(["b0b0b0b0b0b0"]);
});

it("reads a tool's own builtCommit only, and ignores what names none", async () => {
  const seen: Array<string | null> = [];
  const replies: ToolReply[] = [
    toolReply({ error: { code: "not_found", message: "no such file" } }, false),
    toolReply({ repos: [{ id: "tiny", builtCommit: "b0b0b0b0b0b0" }] }),
    toolReply({ builtCommit: null }),
    toolReply({ builtCommit: 12 }),
    toolReply(["b0b0b0b0b0b0"]),
    toolReply("b0b0b0b0b0b0"),
    { ok: false, status: 0, text: "no server here", build: null },
    { ok: true, status: 200, text: "", build: null },
    { ok: true, status: 200, text: '{"builtCommit": "b0b0', build: null },
  ];
  for (const r of replies) {
    const g = guardBuild(fakeSource({ tool: r }), MAP, (c) => seen.push(c));
    expect(await g.tool("code_overview", { repo: "tiny" })).toBe(r);
  }
  expect(seen).toEqual([]);
});

it("passes a failed call through as it failed, and keeps the source's kind", async () => {
  const seen: Array<string | null> = [];
  const failure = new Error("no answer from the server");
  const source: DataSource = {
    ...fakeSource({}),
    kind: "http",
    outline: () => Promise.reject(failure),
  };
  const g = guardBuild(source, MAP, (c) => seen.push(c));
  expect(g.kind).toBe("http");
  await expect(g.outline("tiny:src/core/graph.ts")).rejects.toBe(failure);
  expect(seen).toEqual([]);
});

it("forwards each call's arguments to the source", async () => {
  const calls: unknown[][] = [];
  const source: DataSource = {
    kind: "http",
    map: async () => ({ builtCommit: "4f2a9c1e07b3" }) as MapData,
    outline: async (...a) => {
      calls.push(["outline", ...a]);
      return { builtCommit: "4f2a9c1e07b3" } as OutlineData;
    },
    source: async (...a) => {
      calls.push(["source", ...a]);
      return { builtCommit: "4f2a9c1e07b3" } as SourceData;
    },
    history: async () => ({
      builtCommit: "4f2a9c1e07b3",
      build: MAP.build,
      weeks: [],
    }),
    tool: async (...a) => {
      calls.push(["tool", ...a]);
      return toolReply({ builtCommit: "4f2a9c1e07b3" });
    },
  };
  const g = guardBuild(source, MAP, () => {
    throw new Error("same build");
  });
  await g.outline("tiny:a.ts");
  await g.source("tiny:b.ts");
  await g.tool("code_callers", { repo: "tiny", target: "tiny:a.ts#f" });
  expect(calls).toEqual([
    ["outline", "tiny:a.ts"],
    ["source", "tiny:b.ts"],
    ["tool", "code_callers", { repo: "tiny", target: "tiny:a.ts#f" }],
  ]);
});

it("reports an answer of the map's commit from another build of it", async () => {
  for (const method of ["map", "outline", "source", "history"] as const) {
    const seen: Array<string | null> = [];
    const answer = { builtCommit: MAP.builtCommit, build: OTHER };
    const g = guardBuild(fakeSource({ [method]: answer }), MAP, (c) =>
      seen.push(c),
    );
    const got = await (g[method] as (file: string) => Promise<unknown>)(
      "tiny:src/core/graph.ts",
    );
    expect(got, method).toBe(answer);
    expect(seen, method).toEqual([MAP.builtCommit]);
  }
  // the same build stays quiet
  const seen: Array<string | null> = [];
  const g = guardBuild(fakeSource({ outline: { ...MAP } }), MAP, (c) =>
    seen.push(c),
  );
  await g.outline("tiny:src/core/graph.ts");
  expect(seen).toEqual([]);
});

it("reports a tool's reply from another build of the map's commit, an error included", async () => {
  for (const r of [
    toolReply({ builtCommit: MAP.builtCommit }, true, OTHER),
    toolReply(
      { error: { code: "not_found", message: "no such ID" } },
      false,
      OTHER,
    ),
  ]) {
    const seen: Array<string | null> = [];
    const g = guardBuild(fakeSource({ tool: r }), MAP, (c) => seen.push(c));
    expect(await g.tool("code_overview", { repo: "tiny" })).toBe(r);
    expect(seen).toEqual([r.ok ? MAP.builtCommit : null]);
  }
  // a reply of the map's own build, or one that names none, stays quiet
  const seen: Array<string | null> = [];
  for (const build of [MAP.build, null]) {
    const r = toolReply({ builtCommit: MAP.builtCommit }, true, build);
    const g = guardBuild(fakeSource({ tool: r }), MAP, (c) => seen.push(c));
    await g.tool("code_overview", { repo: "tiny" });
  }
  expect(seen).toEqual([]);
});

it("reports a refusal from another build, and still refuses as it came", async () => {
  for (const method of ["outline", "source", "history"] as const) {
    const seen: Array<string | null> = [];
    const refusal = new ApiError(
      404,
      { code: "no_source", message: "sources are not stored for tiny" },
      OTHER,
    );
    const g = guardBuild(
      { ...fakeSource({}), [method]: () => Promise.reject(refusal) },
      MAP,
      (c) => seen.push(c),
    );
    await expect(
      (g[method] as (file: string) => Promise<unknown>)("tiny:a.ts"),
    ).rejects.toBe(refusal);
    expect(seen, method).toEqual([null]);
  }
  // a refusal of the map's own build, or of none, stays quiet
  const seen: Array<string | null> = [];
  for (const build of [MAP.build, null]) {
    const refusal = new ApiError(
      404,
      { code: "no_source", message: "x" },
      build,
    );
    const g = guardBuild(
      { ...fakeSource({}), source: () => Promise.reject(refusal) },
      MAP,
      (c) => seen.push(c),
    );
    await expect(g.source("tiny:a.ts")).rejects.toBe(refusal);
  }
  expect(seen).toEqual([]);
});
