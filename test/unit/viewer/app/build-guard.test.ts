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
import type {
  DataSource,
  ToolReply,
} from "../../../../src/viewer/app/data-types.js";

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

const toolReply = (answer: unknown, ok = true): ToolReply => ({
  ok,
  status: ok ? 200 : 422,
  text: JSON.stringify(answer, null, 2),
});

it("guardBuild reports a response from another build", async () => {
  const seen: string[] = [];
  const g = guardBuild(
    fakeSource({
      outline: { builtCommit: "b0b0b0b0b0b0" },
      tool: {
        ok: true,
        status: 200,
        text: JSON.stringify({ builtCommit: "b0b0b0b0b0b0" }, null, 2),
      },
    }),
    "4f2a9c1e07b3",
    (c) => seen.push(c),
  );
  await g.outline("tiny:src/core/graph.ts");
  await g.tool("code_explain", { repo: "tiny" });
  expect(seen).toEqual(["b0b0b0b0b0b0"]);
});

it("stays quiet for the same build and passes answers through unchanged", async () => {
  const seen: string[] = [];
  const reply = {
    ok: true,
    status: 200,
    text: '{\n  "builtCommit": "4f2a9c1e07b3"\n}',
  };
  const g = guardBuild(fakeSource({ tool: reply }), "4f2a9c1e07b3", (c) =>
    seen.push(c),
  );
  expect(await g.tool("code_explain", {})).toBe(reply);
  expect(seen).toEqual([]);
});

it("checks every kind of answer, each passed through as it came", async () => {
  for (const method of ["map", "outline", "source", "history"] as const) {
    const seen: string[] = [];
    const answer = { builtCommit: "c0ffee000000" };
    const g = guardBuild(
      fakeSource({ [method]: answer }),
      "4f2a9c1e07b3",
      (c) => seen.push(c),
    );
    const got = await (g[method] as (file: string) => Promise<unknown>)(
      "tiny:src/core/graph.ts",
    );
    expect(got, method).toBe(answer);
    expect(seen, method).toEqual(["c0ffee000000"]);
  }
});

it("reports only the first other build, however many follow", async () => {
  const seen: string[] = [];
  let commit = "111111111111";
  const source: DataSource = {
    ...fakeSource({}),
    history: async () => ({ builtCommit: commit, weeks: [] }),
  };
  const g = guardBuild(source, "4f2a9c1e07b3", (c) => seen.push(c));
  await g.history();
  commit = "222222222222";
  await g.history();
  commit = "4f2a9c1e07b3";
  await g.history();
  expect(seen).toEqual(["111111111111"]);
});

it("reports a tool's answer from another build on its own", async () => {
  const seen: string[] = [];
  const r = toolReply({ builtCommit: "b0b0b0b0b0b0", repo: "tiny" });
  const g = guardBuild(fakeSource({ tool: r }), "4f2a9c1e07b3", (c) =>
    seen.push(c),
  );
  expect(await g.tool("code_explain", { repo: "tiny" })).toBe(r);
  expect(seen).toEqual(["b0b0b0b0b0b0"]);
});

it("reads a tool's own builtCommit only, and ignores what names none", async () => {
  const seen: string[] = [];
  const replies: ToolReply[] = [
    toolReply({ error: { code: "not_found", message: "no such file" } }, false),
    toolReply({ repos: [{ id: "tiny", builtCommit: "b0b0b0b0b0b0" }] }),
    toolReply({ builtCommit: null }),
    toolReply({ builtCommit: 12 }),
    toolReply(["b0b0b0b0b0b0"]),
    toolReply("b0b0b0b0b0b0"),
    { ok: false, status: 0, text: "no server here" },
    { ok: true, status: 200, text: "" },
    { ok: true, status: 200, text: '{"builtCommit": "b0b0' },
  ];
  for (const r of replies) {
    const g = guardBuild(fakeSource({ tool: r }), "4f2a9c1e07b3", (c) =>
      seen.push(c),
    );
    expect(await g.tool("code_overview", { repo: "tiny" })).toBe(r);
  }
  expect(seen).toEqual([]);
});

it("passes a failed call through as it failed, and keeps the source's kind", async () => {
  const seen: string[] = [];
  const failure = new Error("no answer from the server");
  const source: DataSource = {
    ...fakeSource({}),
    kind: "http",
    outline: () => Promise.reject(failure),
  };
  const g = guardBuild(source, "4f2a9c1e07b3", (c) => seen.push(c));
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
    history: async () => ({ builtCommit: "4f2a9c1e07b3", weeks: [] }),
    tool: async (...a) => {
      calls.push(["tool", ...a]);
      return toolReply({ builtCommit: "4f2a9c1e07b3" });
    },
  };
  const g = guardBuild(source, "4f2a9c1e07b3", () => {
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
