// How fast hakutaku mcp answers on a large repository: the scale fixture at 2,500 files, built
// with the installed engines, registered in XDG directories of its own and served over stdio,
// answers 200 calls, 20 for each of ten tools, timed from the client's side: 95% of them within
// 300 ms, and every one within 1.5 s, the first included, which opens the store. Run `npm run
// build` first. The fixture is built with the engines' Python; where that Python does not start
// the test is skipped, and in CI it fails.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { formatId } from "../../src/model/index.js";
import {
  profilePathFor,
  saveEntry,
  storePathFor,
} from "../../src/registry/index.js";
import { openStore, type Store } from "../../src/store/index.js";
import type {
  CallersAnswer,
  DepsAnswer,
  FindAnswer,
  ImpactAnswer,
  PathAnswer,
  ReferencesAnswer,
  SearchTextAnswer,
  SnippetAnswer,
  ToolName,
} from "../../src/tools/index.js";
import { requireInCI } from "../helpers/live.js";
import { call, startStdioClient } from "../helpers/mcp-client.js";
import { samplePythonProbe } from "../helpers/sample.js";
import { scaleStore } from "../helpers/scale.js";

const PYTHON = samplePythonProbe();
// The cold build of the fixture's store is most of it.
const TIMEOUT = 900_000;
const REPO = "scale";
const FILES = 2500;
const CALLS = 200;
const P95_MS = 300;
const MAX_MS = 1500;

// The ten tools timed, each called CALLS / 10 times.
const TOOLS = [
  "code_overview",
  "code_explain",
  "code_callers",
  "code_references",
  "code_impact",
  "code_deps",
  "code_path",
  "code_find",
  "code_search_text",
  "code_snippet",
] as const satisfies readonly ToolName[];

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Call {
  name: (typeof TOOLS)[number];
  arguments: Record<string, unknown>;
}

// A production file and its component, and a definition, as pickCalls reads them.
interface Ranked {
  path: string;
  component: string;
}

interface Definition {
  path: string;
  qualname: string;
  ordinal: number;
  name: string;
}

// count calls, an equal share for each tool, from fixed picks: the production files by rank,
// every 50th definition in definition order (module rows left out), taken evenly across the
// repository, and the names of those definitions, which other definitions share.
function pickCalls(store: Store, count: number): Call[] {
  const per = count / TOOLS.length;
  const top = store.db
    .prepare(
      `SELECT f.path AS path, c.path AS component
         FROM files f
         JOIN file_metrics m ON m.file_id = f.id
         JOIN components c ON c.id = f.component_id
        WHERE m.dependents_rank IS NOT NULL
        ORDER BY m.dependents_rank, f.path
        LIMIT ?`,
    )
    .all(per) as unknown as Ranked[];
  const every50 = (
    store.db
      .prepare(
        `SELECT f.path AS path, d.qualname AS qualname, d.ordinal AS ordinal, d.name AS name
           FROM definitions d
           JOIN files f ON f.id = d.file_id
          WHERE d.kind <> 'module'
          ORDER BY d.id`,
      )
      .all() as unknown as Definition[]
  ).filter((_, i) => i % 50 === 0);
  expect(top).toHaveLength(per);
  expect(every50.length).toBeGreaterThanOrEqual(per);
  const defs = Array.from(
    { length: per },
    (_, i) => every50[Math.floor((i * every50.length) / per)],
  );
  const file = (i: number): string =>
    formatId({ kind: "file", repo: REPO, path: top[i]?.path ?? "" });
  const component = (i: number): string =>
    formatId({ kind: "directory", repo: REPO, path: top[i]?.component ?? "" });
  const definition = (i: number): string => {
    const d = defs[i];
    if (d === undefined) throw new Error(`no definition ${i}`);
    return formatId({
      kind: "definition",
      repo: REPO,
      path: d.path,
      qualname: d.qualname,
      ordinal: d.ordinal,
    });
  };
  const definedIn = (i: number): string =>
    formatId({ kind: "file", repo: REPO, path: defs[i]?.path ?? "" });
  const name = (i: number): string => defs[i]?.name ?? "";

  const calls: Call[] = [];
  const add = (tool: Call["name"], args: Record<string, unknown>): void => {
    calls.push({ name: tool, arguments: { repo: REPO, ...args } });
  };
  for (let i = 0; i < per; i++) {
    add("code_overview", i === 0 ? {} : { component: component(i - 1) });
  }
  for (let i = 0; i < per; i++) {
    add("code_explain", { target: i % 2 === 0 ? file(i) : definition(i) });
  }
  const variants = [{}, { scope: "transitive" }, { depth: 2 }];
  for (let i = 0; i < per; i++) {
    add("code_callers", { symbol: definition(i), ...variants[i % 3] });
  }
  for (let i = 0; i < per; i++) {
    add("code_references", { symbol: definition(i) });
  }
  for (let i = 0; i < per; i++) {
    add("code_impact", { target: i % 2 === 0 ? file(i) : definition(i) });
  }
  for (let i = 0; i < per; i++) {
    add("code_deps", {
      file: file(i),
      direction: i % 2 === 0 ? "in" : "out",
      transitive: i % 4 >= 2,
    });
  }
  for (let i = 0; i < per; i++) {
    add(
      "code_path",
      i % 2 === 0
        ? { from: definedIn(i), to: file(i) }
        : {
            from: definition(i),
            to: definition((i + 1) % per),
            via: "calls",
          },
    );
  }
  for (let i = 0; i < per; i++) add("code_find", { name: name(i) });
  for (let i = 0; i < per; i++) add("code_search_text", { text: name(i) });
  for (let i = 0; i < per; i++) {
    add(
      "code_snippet",
      i % 2 === 0 ? { target: definition(i) } : { file: file(i) },
    );
  }
  return calls;
}

it(
  "answers within p95 300 ms and at most 1.5 s per call",
  async (ctx) => {
    requireInCI(ctx, PYTHON);
    const { repo, store } = await scaleStore(FILES);
    // the fixture registered as "scale" under XDG directories of its own, with its store copied
    // into place
    const root = mkdtempSync(join(tmpdir(), "hakutaku-scale-env-"));
    roots.push(root);
    const xdg = {
      XDG_DATA_HOME: join(root, "data"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_CACHE_HOME: join(root, "cache"),
    };
    for (const [key, value] of Object.entries(xdg)) vi.stubEnv(key, value);
    let served: string;
    try {
      saveEntry({
        id: REPO,
        source: repo,
        ref: "main",
        detail: "standard",
        noSource: false,
        snippets: true,
        profile: profilePathFor(REPO),
      });
      served = storePathFor(REPO);
      mkdirSync(dirname(served), { recursive: true });
      copyFileSync(store, served);
    } finally {
      vi.unstubAllEnvs();
    }
    const opened = openStore(served);
    if ("code" in opened) throw new Error(`the scale store: ${opened.reason}`);
    let calls: Call[];
    try {
      calls = pickCalls(opened, CALLS);
    } finally {
      opened.close();
    }
    expect(calls).toHaveLength(CALLS);
    for (const tool of TOOLS) {
      expect(calls.filter((c) => c.name === tool)).toHaveLength(
        CALLS / TOOLS.length,
      );
    }

    const timed: Array<Call & { ms: number; answer: unknown }> = [];
    const session = await startStdioClient({
      args: ["mcp", REPO],
      env: { ...process.env, ...xdg },
    });
    try {
      for (const c of calls) {
        const r = await call(session.client, c.name, c.arguments);
        expect(
          r.isError,
          `${c.name} ${JSON.stringify(c.arguments)}: ${r.text.slice(0, 400)}`,
        ).toBe(false);
        timed.push({ ...c, ms: r.ms, answer: JSON.parse(r.text) });
      }
    } finally {
      await session.close();
    }

    // The answers hold what was asked for, so the times measure real work.
    const answers = <A>(tool: Call["name"]): A[] =>
      timed.filter((t) => t.name === tool).map((t) => t.answer as A);
    expect(
      answers<FindAnswer>("code_find").every((a) => a.matches.length > 0),
      "every code_find answer lists a match",
    ).toBe(true);
    expect(
      answers<SearchTextAnswer>("code_search_text").every(
        (a) => a.hits.length > 0,
      ),
      "every code_search_text answer lists a hit",
    ).toBe(true);
    expect(
      answers<SnippetAnswer>("code_snippet").every((a) => a.lines.length > 0),
      "every code_snippet answer holds lines",
    ).toBe(true);
    expect(
      answers<CallersAnswer>("code_callers").some((a) => a.callers.length > 0),
      "some code_callers answer lists a caller",
    ).toBe(true);
    expect(
      answers<ReferencesAnswer>("code_references").some(
        (a) => a.references.length > 0,
      ),
      "some code_references answer lists a reference",
    ).toBe(true);
    expect(
      answers<ImpactAnswer>("code_impact").some((a) => a.counts.files > 0),
      "some code_impact answer reaches a file",
    ).toBe(true);
    expect(
      answers<DepsAnswer>("code_deps").some((a) => a.edges.length > 0),
      "some code_deps answer lists an edge",
    ).toBe(true);
    expect(
      answers<PathAnswer>("code_path").some((a) => a.found),
      "some code_path answer finds a path",
    ).toBe(true);

    const ms = timed.map((t) => t.ms).sort((a, b) => a - b);
    const p95 = ms[Math.ceil(0.95 * ms.length) - 1] ?? Number.POSITIVE_INFINITY;
    const slowest = [...timed]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 5)
      .map(
        (t) =>
          `${t.name} ${JSON.stringify(t.arguments)}: ${t.ms.toFixed(0)} ms`,
      )
      .join("; ");
    expect(
      p95,
      `p95 of ${ms.length} calls; the slowest: ${slowest}`,
    ).toBeLessThan(P95_MS);
    expect(
      ms.at(-1) ?? Number.POSITIVE_INFINITY,
      `the slowest: ${slowest}`,
    ).toBeLessThan(MAX_MS);
  },
  TIMEOUT,
);
