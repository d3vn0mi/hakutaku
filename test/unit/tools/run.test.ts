import { homedir, tmpdir } from "node:os";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CallersAnswer,
  type Host,
  type ImpactAnswer,
  measure,
  type ReposAnswer,
  type RulesAnswer,
  runTool,
  type SearchTextAnswer,
  type SnippetAnswer,
  type ToolError,
  type ToolResult,
} from "../../../src/tools/index.js";
import { fixedHost } from "../../helpers/fixed-host.js";
import { tinyStore } from "../../helpers/tiny.js";

const tiny = tinyStore();
const host = fixedHost({ tiny });
const run = (n: string, a?: unknown, h: Host = host) => runTool(h, null, n, a);
const GHOST = "/nonexistent/store.sqlite";

// A result that must be an answer, viewed as one tool's answer type.
function answer<A extends object = Record<string, unknown>>(r: ToolResult): A {
  if (!r.ok) throw new Error(`an error: ${JSON.stringify(r.error)}`);
  return r.answer as A;
}

// A result that must be an error.
function error(r: ToolResult): ToolError {
  if (r.ok) throw new Error(`an answer: ${JSON.stringify(r.answer)}`);
  return r.error;
}

it("lists every repo with its freshness, built or not", () => {
  const r = answer<ReposAnswer>(
    run("code_repos", {}, fixedHost({ tiny, ghost: GHOST })),
  );
  expect(Object.keys(r.repos[0] ?? {})).toEqual([
    "id",
    "ref",
    "builtCommit",
    "headCommit",
    "stale",
    "builtAt",
    "detail",
    "snippets",
    "languages",
    "coverage",
    "engines",
  ]);
  expect(r.repos[0]).toMatchObject({
    id: "tiny",
    builtCommit: "0123456789ab",
    headCommit: "0123456789ab",
    stale: false,
    detail: "standard",
    snippets: true,
    languages: { python: 2, shell: 1, typescript: 10 },
    coverage: {
      files: 15,
      indexed: { python: 2, shell: 1, typescript: 10 },
      unresolvedImports: 0,
      callSites: { bound: 7, scoped: 1, unresolved: 2 },
      redactions: 1,
    },
  });
  expect(r.repos[1]).toMatchObject({
    id: "ghost",
    builtCommit: null,
    builtAt: null,
    languages: {},
    engines: {},
    coverage: {
      files: 0,
      indexed: {},
      unresolvedImports: 0,
      callSites: { bound: 0, scoped: 0, unresolved: 0 },
      redactions: 0,
    },
  });
});

it("refuses an unknown tool", () => {
  expect(run("code_nope", {})).toMatchObject({
    ok: false,
    error: {
      code: "invalid_argument",
      field: "name",
      message: "unknown tool code_nope",
    },
  });
});

it("calls the host in the documented order, and nothing for a repo outside host.repos", () => {
  const calls: string[] = [];
  const rec: Host = {
    maxResultChars: 40000,
    repos: () => {
      calls.push("repos");
      return [{ id: "tiny", ref: "HEAD", detail: "standard" }];
    },
    open: (_c, r) => {
      calls.push(`open:${r}`);
      return host.open(null, r);
    },
    freshness: (r) => {
      calls.push(`freshness:${r}`);
      return host.freshness(r);
    },
    snippets: (r) => {
      calls.push(`snippets:${r}`);
      return true;
    },
    refresh: (r) => {
      calls.push(`refresh:${r}`);
      return { state: "queued" };
    },
  };
  run("code_explain", { repo: "tiny", target: "solve" }, rec);
  expect(calls).toEqual([
    "repos",
    "open:tiny",
    "freshness:tiny",
    "snippets:tiny",
  ]);
  calls.length = 0;
  expect(
    run("code_explain", { repo: "other", target: "x" }, rec),
  ).toMatchObject({
    ok: false,
    error: { code: "unknown_repo", known: ["tiny"] },
  });
  expect(run("code_refresh", { repo: "other" }, rec)).toMatchObject({
    ok: false,
    error: { code: "unknown_repo" },
  });
  // no open, freshness, snippets or refresh for a repo the caller may not ask about
  expect(calls).toEqual(["repos", "repos"]);
});

it("answers not_built and passes stale through", () => {
  expect(
    run("code_overview", { repo: "ghost" }, fixedHost({ ghost: GHOST })),
  ).toMatchObject({
    ok: false,
    error: { code: "not_built", message: "ghost has no usable store" },
  });
  expect(
    answer(
      run(
        "code_overview",
        { repo: "tiny" },
        fixedHost({ tiny }, { stale: "unknown" }),
      ),
    ).stale,
  ).toBe("unknown");
});

it("handles refresh: disabled, rate-limited and queued", () => {
  expect(run("code_refresh", { repo: "tiny" })).toMatchObject({
    ok: false,
    error: { code: "refresh_disabled", message: "this host offers no refresh" },
  });
  const rl = fixedHost(
    { tiny },
    { refresh: () => ({ state: "rate_limited", retryAfterSeconds: 412 }) },
  );
  expect(run("code_refresh", { repo: "tiny" }, rl)).toEqual({
    ok: false,
    error: {
      code: "rate_limited",
      message: "tiny was refreshed less than 10 minutes ago",
      retryAfterSeconds: 412,
    },
  });
  const q = fixedHost(
    { tiny },
    { refresh: () => ({ state: "queued", retryAfterSeconds: 600 }) },
  );
  expect(JSON.stringify(answer(run("code_refresh", { repo: "tiny" }, q)))).toBe(
    '{"state":"queued","builtCommit":"0123456789ab","headCommit":"0123456789ab","retryAfterSeconds":600}',
  );
});

it("turns exceptions into internal errors and reports them", () => {
  const seen: unknown[] = [];
  const boom = {
    ...host,
    open: () => {
      throw new Error("disk");
    },
  } as Host;
  expect(
    runTool(boom, null, "code_overview", { repo: "tiny" }, (e) => seen.push(e)),
  ).toEqual({
    ok: false,
    error: { code: "internal", message: "internal error" },
  });
  expect(seen).toHaveLength(1);
});

it("pages with the fields after stale, and an explicit offset always pages", () => {
  const p = answer(
    run("code_find", { repo: "tiny", name: "position", limit: 1 }),
  );
  expect(Object.keys(p)).toEqual([
    "query",
    "builtCommit",
    "stale",
    "offset",
    "returned",
    "total",
    "hasMore",
    "nextOffset",
    "note",
    "matches",
  ]);
  expect(p.note).toBe(
    "items 1-1 of 2; call again with offset 1 for the next page",
  );
  expect(
    answer(run("code_find", { repo: "tiny", name: "position", offset: 0 })),
  ).toMatchObject({
    offset: 0,
    returned: 2,
    total: 2,
    hasMore: false,
    note: "items 1-2 of 2; this is the last page",
  });
  expect(
    answer(run("code_find", { repo: "tiny", name: "position" })),
  ).not.toHaveProperty("offset");
});

it("treats absent MCP arguments as {}", () => {
  expect(run("code_repos", undefined)).toMatchObject({ ok: true });
  expect(run("code_overview", undefined)).toMatchObject({
    ok: false,
    error: { field: "repo", message: "repo is required" },
  });
});

it("error messages cut echoed input to 120 characters", () => {
  const e = error(
    run("code_explain", { repo: "tiny", target: "q".repeat(4000) }),
  );
  expect(e.message).toBe(`target ${"q".repeat(119)}… is not in the store`);
});

const ONE_NODE = {
  code_overview: { repo: "tiny" },
  code_explain: { repo: "tiny", target: "solve" },
  code_callers: { repo: "tiny", symbol: "solve" },
  code_references: { repo: "tiny", symbol: "lib/orbit.ts#Orbit" },
  code_deps: { repo: "tiny", file: "app/main.ts", direction: "out" },
  code_snippet: { repo: "tiny", target: "solve" },
  code_path: { repo: "tiny", from: "lib/orbit.test.ts", to: "lib/consts.ts" },
};
const LISTS = {
  code_repos: {},
  code_find: { repo: "tiny", name: "orbit" },
  code_search_text: { repo: "tiny", text: "import" },
  code_rules: { repo: "tiny" },
  code_impact: { repo: "tiny", target: "lib/units.ts" },
};

it("puts view last on one-node answers and none on lists", () => {
  for (const [n, a] of Object.entries(ONE_NODE))
    expect(Object.keys(answer(run(n, a))).at(-1)).toBe("view");
  for (const [n, a] of Object.entries(LISTS))
    expect(answer(run(n, a))).not.toHaveProperty("view");
});

it("answers carry no absolute paths", () => {
  for (const [n, a] of Object.entries({ ...ONE_NODE, ...LISTS })) {
    const j = JSON.stringify(run(n, a));
    for (const p of [dirname(tiny), homedir(), tmpdir()])
      expect(j).not.toContain(p);
  }
});

// A host over tiny that records every call it gets; over replaces any of its members.
function recording(over: Partial<Host> = {}) {
  const calls: string[] = [];
  const rec: Host = {
    maxResultChars: 40000,
    repos: () => {
      calls.push("repos");
      return [{ id: "tiny", ref: "HEAD", detail: "standard" }];
    },
    open: (_c, r) => {
      calls.push(`open:${r}`);
      return host.open(null, r);
    },
    freshness: (r) => {
      calls.push(`freshness:${r}`);
      return host.freshness(r);
    },
    snippets: (r) => {
      calls.push(`snippets:${r}`);
      return true;
    },
  };
  return { calls, host: { ...rec, ...over } };
}

const TOOL_LIST =
  "the tools are code_repos, code_overview, code_find, code_explain, code_callers, code_references, code_impact, code_deps, code_path, code_rules, code_search_text, code_snippet, code_refresh";

describe("the checks", () => {
  it("names every tool for an unknown one, and takes no inherited or differently cased name", () => {
    for (const n of [
      "toString",
      "__proto__",
      "constructor",
      "hasOwnProperty",
      "code_Repos",
    ])
      expect(error(run(n, {}))).toEqual({
        code: "invalid_argument",
        message: `unknown tool ${n}`,
        field: "name",
        hint: TOOL_LIST,
      });
    expect(error(run("x".repeat(500), {})).message).toBe(
      `unknown tool ${"x".repeat(119)}…`,
    );
  });

  it("checks the arguments before it asks the host anything", () => {
    const { calls, host: h } = recording();
    expect(error(run("code_explain", { repo: "tiny" }, h))).toMatchObject({
      code: "invalid_argument",
      field: "target",
      message: "target is required",
    });
    expect(error(run("code_repos", { repo: "tiny" }, h))).toMatchObject({
      code: "invalid_argument",
      field: "repo",
    });
    expect(error(run("code_refresh", {}, h))).toMatchObject({
      code: "invalid_argument",
      field: "repo",
    });
    expect(
      error(run("code_find", { repo: "other", name: "ab", limit: 0 }, h)),
    ).toMatchObject({
      code: "invalid_argument",
      field: "limit",
    });
    expect(calls).toEqual([]);
  });
});

describe("the gate", () => {
  it("takes only an exact id, before a host that would open any repo is asked", () => {
    const opened: string[] = [];
    const lax: Host = {
      ...host,
      open: (c, r) => {
        opened.push(r);
        return host.open(c, "tiny");
      },
    };
    for (const repo of ["TINY", " tiny", "tiny ", "tiny:", "Tiny"])
      expect(error(run("code_overview", { repo }, lax))).toEqual({
        code: "unknown_repo",
        message: `unknown repo ${repo}`,
        known: ["tiny"],
      });
    expect(
      error(run("code_overview", { repo: "r".repeat(500) }, lax)).message,
    ).toBe(`unknown repo ${"r".repeat(119)}…`);
    expect(opened).toEqual([]);
  });
});

describe("code_refresh", () => {
  const states = (state: Parameters<typeof fixedHost>[1]) =>
    fixedHost({ tiny }, state);

  it("gates the repo before it looks for a refresh", () => {
    expect(error(run("code_refresh", { repo: "other" }))).toEqual({
      code: "unknown_repo",
      message: "unknown repo other",
      known: ["tiny"],
    });
  });

  it("asks for the refresh, then the store and the head, and no more when rate-limited", () => {
    const queued = recording({
      refresh: (r) => {
        queued.calls.push(`refresh:${r}`);
        return { state: "queued" };
      },
    });
    expect(answer(run("code_refresh", { repo: "tiny" }, queued.host))).toEqual({
      state: "queued",
      builtCommit: "0123456789ab",
      headCommit: "0123456789ab",
    });
    expect(queued.calls).toEqual([
      "repos",
      "refresh:tiny",
      "open:tiny",
      "freshness:tiny",
    ]);
    const limited = recording({
      refresh: (r) => {
        limited.calls.push(`refresh:${r}`);
        return { state: "rate_limited", retryAfterSeconds: 1 };
      },
    });
    expect(
      error(run("code_refresh", { repo: "tiny" }, limited.host)).code,
    ).toBe("rate_limited");
    expect(limited.calls).toEqual(["repos", "refresh:tiny"]);
  });

  it("keeps retryAfterSeconds only while a build is queued or building, and copies lastAttempt", () => {
    const at = "2026-01-01T00:00:00Z";
    const of = (h: Host) =>
      JSON.stringify(answer(run("code_refresh", { repo: "tiny" }, h)));
    expect(
      of(
        states({
          refresh: () => ({
            state: "idle",
            lastAttempt: { at, result: "ok" },
            retryAfterSeconds: 5,
          }),
        }),
      ),
    ).toBe(
      `{"state":"idle","builtCommit":"0123456789ab","headCommit":"0123456789ab","lastAttempt":{"at":"${at}","result":"ok"}}`,
    );
    expect(
      of(
        states({
          refresh: () => ({
            retryAfterSeconds: 9,
            lastAttempt: {
              reason: "unresolved imports grew",
              result: "failed",
              at,
            },
            state: "failed",
          }),
        }),
      ),
    ).toBe(
      `{"state":"failed","builtCommit":"0123456789ab","headCommit":"0123456789ab","lastAttempt":{"at":"${at}","result":"failed","reason":"unresolved imports grew"}}`,
    );
    expect(
      of(
        states({
          refresh: () => ({ state: "building", retryAfterSeconds: 540 }),
        }),
      ),
    ).toBe(
      '{"state":"building","builtCommit":"0123456789ab","headCommit":"0123456789ab","retryAfterSeconds":540}',
    );
  });

  it("answers a repo that is not built with null commits, and a limit without seconds", () => {
    const ghost = fixedHost(
      { ghost: GHOST },
      { refresh: () => ({ state: "queued" }) },
    );
    expect(
      JSON.stringify(answer(run("code_refresh", { repo: "ghost" }, ghost))),
    ).toBe('{"state":"queued","builtCommit":null,"headCommit":null}');
    expect(
      error(
        run(
          "code_refresh",
          { repo: "tiny" },
          states({ refresh: () => ({ state: "rate_limited" }) }),
        ),
      ),
    ).toEqual({
      code: "rate_limited",
      message: "tiny was refreshed less than 10 minutes ago",
    });
  });
});

describe("code_repos", () => {
  it("writes a repo that is not built in full", () => {
    const r = answer<ReposAnswer>(
      run("code_repos", {}, fixedHost({ ghost: GHOST }, { ref: "main" })),
    );
    expect(JSON.stringify(r)).toBe(
      JSON.stringify({
        repos: [
          {
            id: "ghost",
            ref: "main",
            builtCommit: null,
            headCommit: null,
            stale: false,
            builtAt: null,
            detail: "standard",
            snippets: true,
            languages: {},
            coverage: {
              files: 0,
              indexed: {},
              unresolvedImports: 0,
              callSites: { bound: 0, scoped: 0, unresolved: 0 },
              redactions: 0,
            },
            engines: {},
          },
        ],
      }),
    );
  });

  it("gives the store's detail when built and the entry's when not, the reason right after stale, and each repo's own calls in turn", () => {
    const both = fixedHost({ tiny, ghost: GHOST });
    const calls: string[] = [];
    const h: Host = {
      ...both,
      repos: () => [
        { id: "tiny", ref: "main", detail: "deep" },
        { id: "ghost", ref: "main", detail: "quick" },
      ],
      open: (c, r) => {
        calls.push(`open:${r}`);
        return both.open(c, r);
      },
      freshness: (r) => {
        calls.push(`freshness:${r}`);
        return r === "tiny"
          ? {
              headCommit: "89abcdef0123456789abcdef0123456789abcdef",
              stale: true,
              reason: "main is at 89abcdef0123, the store at 0123456789ab",
            }
          : {
              headCommit: null,
              stale: "unknown",
              reason: "not a git repository",
            };
      },
      snippets: (r) => {
        calls.push(`snippets:${r}`);
        return r === "tiny";
      },
    };
    const r = answer<ReposAnswer>(run("code_repos", {}, h));
    expect(calls).toEqual([
      "open:tiny",
      "freshness:tiny",
      "snippets:tiny",
      "open:ghost",
      "freshness:ghost",
      "snippets:ghost",
    ]);
    expect(JSON.stringify(r.repos[0])).toBe(
      JSON.stringify({
        id: "tiny",
        ref: "main",
        builtCommit: "0123456789ab",
        headCommit: "89abcdef0123",
        stale: true,
        staleReason: "main is at 89abcdef0123, the store at 0123456789ab",
        builtAt: "2026-01-01T00:00:00Z",
        detail: "standard",
        snippets: true,
        languages: { python: 2, shell: 1, typescript: 10 },
        coverage: {
          files: 15,
          indexed: { python: 2, shell: 1, typescript: 10 },
          unresolvedImports: 0,
          callSites: { bound: 7, scoped: 1, unresolved: 2 },
          redactions: 1,
        },
        engines: {
          "ast-grep": "0.0.0",
          "dependency-cruiser": "0.0.0",
          grimp: "0.0.0",
          "scip-typescript": "0.0.0",
        },
      }),
    );
    expect(r.repos[1]).toMatchObject({
      id: "ghost",
      builtCommit: null,
      headCommit: null,
      stale: "unknown",
      staleReason: "not a git repository",
      detail: "quick",
      snippets: false,
    });
  });

  it("treats a listed repo its host will not open as not built", () => {
    const h: Host = { ...host, open: () => ({ code: "unknown_repo" }) };
    expect(
      answer<ReposAnswer>(run("code_repos", {}, h)).repos[0],
    ).toMatchObject({
      id: "tiny",
      builtCommit: null,
      builtAt: null,
      detail: "standard",
      languages: {},
      engines: {},
    });
    expect(error(run("code_overview", { repo: "tiny" }, h))).toEqual({
      code: "unknown_repo",
      message: "unknown repo tiny",
      known: ["tiny"],
    });
  });

  it("hands out copies, never the store's own maps", () => {
    const first = answer<ReposAnswer>(run("code_repos", {})).repos[0];
    if (first === undefined) throw new Error("no repo");
    first.languages.typescript = 0;
    first.coverage.indexed.python = 0;
    first.coverage.callSites.bound = 0;
    first.engines.grimp = "x";
    expect(answer<ReposAnswer>(run("code_repos", {})).repos[0]).toMatchObject({
      languages: { python: 2, typescript: 10 },
      coverage: { indexed: { python: 2 }, callSites: { bound: 7 } },
      engines: { grimp: "0.0.0" },
    });
  });
});

describe("content tools", () => {
  it("answers not_built with the store's reason", () => {
    expect(
      error(
        run("code_overview", { repo: "ghost" }, fixedHost({ ghost: GHOST })),
      ),
    ).toEqual({
      code: "not_built",
      message: "ghost has no usable store",
      reason: "not built yet",
    });
  });

  it("passes the host's snippets setting to the query", () => {
    const off = fixedHost({ tiny }, { snippets: false });
    expect(
      error(run("code_snippet", { repo: "tiny", target: "solve" }, off)),
    ).toMatchObject({
      code: "no_source",
      message: "snippets are off for tiny",
    });
    const hits = answer<SearchTextAnswer>(
      run("code_search_text", { repo: "tiny", text: "import" }, off),
    ).hits;
    expect(hits).toHaveLength(9);
    expect(hits.filter((h) => "text" in h)).toEqual([]);
  });

  it("reports an exception from the store, the gate or the log as internal", () => {
    const seen: unknown[] = [];
    const log = (e: unknown) => seen.push(e);
    const closed = fixedHost({ tiny: tinyStore() });
    const store = closed.open(null, "tiny");
    if ("code" in store) throw new Error(store.code);
    store.close();
    const internal = {
      ok: false,
      error: { code: "internal", message: "internal error" },
    };
    expect(
      runTool(closed, null, "code_overview", { repo: "tiny" }, log),
    ).toEqual(internal);
    const noRepos = {
      ...host,
      repos: () => {
        throw new Error("registry");
      },
    } as Host;
    expect(runTool(noRepos, null, "code_repos", {}, log)).toEqual(internal);
    expect(
      runTool(noRepos, null, "code_find", { repo: "tiny", name: "x" }, log),
    ).toEqual(internal);
    expect(seen).toHaveLength(3);
    const badLog = () => {
      throw new Error("log");
    };
    expect(
      runTool(closed, null, "code_overview", { repo: "tiny" }, badLog),
    ).toEqual(internal);
    expect(runTool(closed, null, "code_overview", { repo: "tiny" })).toEqual(
      internal,
    );
  });
});

// Every page of a call, from the first, following nextOffset.
function follow<A extends object>(h: Host, n: string, a: object): A[] {
  const pages: A[] = [];
  let offset: number | undefined;
  for (let i = 0; i < 100; i += 1) {
    const page = answer<A>(
      run(n, offset === undefined ? a : { ...a, offset }, h),
    );
    pages.push(page);
    if (!("nextOffset" in page) || typeof page.nextOffset !== "number")
      return pages;
    offset = page.nextOffset;
  }
  throw new Error("more than 100 pages");
}

// A list an answer holds under key.
function listOf(page: Record<string, unknown>, key: string): unknown[] {
  const list = page[key];
  if (!Array.isArray(list)) throw new Error(`no list ${key}`);
  return list;
}

describe("paging", () => {
  it("pages each list tool over its own list", () => {
    const cases: [string, object, string][] = [
      ["code_find", { repo: "tiny", name: "orbit" }, "matches"],
      ["code_callers", { repo: "tiny", symbol: "solve" }, "callers"],
      [
        "code_references",
        { repo: "tiny", symbol: "lib/orbit.ts#Orbit" },
        "references",
      ],
      [
        "code_deps",
        { repo: "tiny", file: "app/main.ts", direction: "out" },
        "edges",
      ],
      ["code_rules", { repo: "tiny" }, "findings"],
      ["code_search_text", { repo: "tiny", text: "import" }, "hits"],
    ];
    for (const [n, a, key] of cases) {
      const whole = listOf(answer(run(n, a)), key);
      expect(whole.length).toBeGreaterThan(1);
      const pages = follow<Record<string, unknown>>(host, n, {
        ...a,
        limit: 1,
      });
      expect(pages.map((p) => listOf(p, key))).toEqual(
        whole.map((item) => [item]),
      );
    }
  });

  it("keeps blind spots whole on every page, past the last one too, right after the list", () => {
    const quick = fixedHost({ tiny: tinyStore({ detail: "quick" }) });
    const cases: [string, object, string][] = [
      ["code_callers", { repo: "tiny", symbol: "solve" }, "callers"],
      [
        "code_references",
        { repo: "tiny", symbol: "lib/orbit.ts#Orbit" },
        "references",
      ],
      [
        "code_deps",
        { repo: "tiny", file: "app/main.ts", direction: "out" },
        "edges",
      ],
      ["code_search_text", { repo: "tiny", text: "import" }, "hits"],
    ];
    for (const [n, a, key] of cases) {
      const whole = answer(run(n, a, quick)).blindSpots;
      expect(Array.isArray(whole) && whole.length > 0).toBe(true);
      const pages = follow<Record<string, unknown>>(quick, n, {
        ...a,
        limit: 1,
      });
      expect(pages.length).toBeGreaterThan(1);
      pages.push(answer(run(n, { ...a, offset: 99 }, quick)));
      for (const page of pages) {
        expect(page.blindSpots).toEqual(whole);
        const keys = Object.keys(page);
        expect(keys.slice(keys.indexOf(key) + 1)).toEqual(
          n === "code_search_text" ? ["blindSpots"] : ["blindSpots", "view"],
        );
      }
    }
  });

  const SOLVE = { repo: "tiny", target: "solve", depth: 3 };

  it("pages code_impact over the nodes it reaches, rebuilt into the hops a page touches", () => {
    const whole = answer<ImpactAnswer>(run("code_impact", SOLVE));
    const [first, second, ...rest] = follow<ImpactAnswer>(host, "code_impact", {
      ...SOLVE,
      limit: 4,
    });
    expect(rest).toEqual([]);
    expect(first).toMatchObject({
      offset: 0,
      returned: 4,
      total: 6,
      hasMore: true,
      nextOffset: 4,
    });
    expect(first?.byHop).toEqual([
      {
        hop: 1,
        definitions: whole.byHop[0]?.definitions,
        files: ["tiny:lib/render.ts"],
        tests: [],
      },
    ]);
    expect(JSON.stringify(second)).toBe(
      JSON.stringify({
        id: "tiny:lib/orbit.ts#solve",
        builtCommit: "0123456789ab",
        stale: false,
        offset: 4,
        returned: 2,
        total: 6,
        hasMore: false,
        note: "items 5-6 of 6; this is the last page",
        depth: 3,
        byHop: [
          { hop: 1, definitions: [], files: ["tiny:app/main.ts"], tests: [] },
          {
            hop: 2,
            definitions: [],
            files: [],
            tests: ["tiny:lib/orbit.test.ts"],
          },
        ],
        counts: whole.counts,
        blindSpots: whole.blindSpots,
      }),
    );
  });

  it("rebuilds code_impact's hops exactly from its pages, whatever the limit", () => {
    const whole = answer<ImpactAnswer>(run("code_impact", SOLVE)).byHop;
    expect(whole.map((h) => h.hop)).toEqual([1, 2]);
    for (let limit = 1; limit <= 6; limit += 1) {
      const merged: ImpactAnswer["byHop"] = [];
      for (const page of follow<ImpactAnswer>(host, "code_impact", {
        ...SOLVE,
        limit,
      }))
        for (const h of page.byHop) {
          expect(Object.keys(h)).toEqual([
            "hop",
            "definitions",
            "files",
            "tests",
          ]);
          const last = merged.at(-1);
          if (last?.hop === h.hop) {
            last.definitions.push(...h.definitions);
            last.files.push(...h.files);
            last.tests.push(...h.tests);
          } else merged.push(structuredClone(h));
        }
      expect(merged).toEqual(whole);
    }
  });

  it("pages a hop's files before its tests", () => {
    const [first] = follow<ImpactAnswer>(host, "code_impact", {
      repo: "tiny",
      target: "lib/units.ts",
      limit: 4,
    });
    expect(first?.byHop).toEqual([
      {
        hop: 1,
        definitions: [],
        files: ["tiny:lib/orbit.ts", "tiny:lib/consts.ts"],
        tests: [],
      },
      {
        hop: 2,
        definitions: [],
        files: ["tiny:lib/render.ts", "tiny:app/main.ts"],
        tests: [],
      },
    ]);
  });

  it("answers a page past the last node of code_impact with no hop", () => {
    expect(answer(run("code_impact", { ...SOLVE, offset: 6 }))).toMatchObject({
      returned: 0,
      total: 6,
      hasMore: false,
      note: "no items at offset 6; there are 6",
      byHop: [],
      counts: { definitions: 3, files: 2, tests: 1 },
    });
  });

  it("splits a caller too large for a page into parts, part before sites, under the host's cap", () => {
    const a = {
      repo: "tiny",
      symbol: "lib/orbit.ts#Orbit.position",
      labels: ["bound", "scoped", "unscoped"],
    };
    const whole = answer<CallersAnswer>(run("code_callers", a));
    const capped = fixedHost({ tiny }, { maxResultChars: 1200 });
    const pages = follow<CallersAnswer>(capped, "code_callers", a);
    expect(
      pages.map((p) => p.callers.map((c) => [c.id, c.part ?? null])),
    ).toEqual([
      [
        ["tiny:lib/render.ts#draw", null],
        ["tiny:lib/loader.ts#load", null],
      ],
      [["tiny:lib/orbit.test.ts#<module>", "1/2"]],
      [["tiny:lib/orbit.test.ts#<module>", "2/2"]],
    ]);
    for (const p of pages) {
      expect(measure(p)).toBeLessThanOrEqual(1200);
      expect(p.counts).toEqual(whole.counts);
    }
    const parts = pages.slice(1).flatMap((p) => p.callers);
    expect(Object.keys(parts[0] ?? {})).toEqual([
      "id",
      "file",
      "test",
      "hop",
      "part",
      "sites",
    ]);
    const { part: _, ...rest } = parts[0] ?? { part: "" };
    expect({ ...rest, sites: parts.flatMap((c) => c.sites) }).toEqual(
      whole.callers[2],
    );
  });

  it("splits a rule finding too large for a page into parts, part before chain", () => {
    const whole = answer<RulesAnswer>(run("code_rules", { repo: "tiny" }));
    const pages = follow<RulesAnswer>(
      fixedHost({ tiny }, { maxResultChars: 650 }),
      "code_rules",
      {
        repo: "tiny",
      },
    );
    expect(
      pages.map((p) => p.findings.map((f) => [f.kind, f.part ?? null])),
    ).toEqual([[["violation", null]], [["cycle", "1/2"]], [["cycle", "2/2"]]]);
    const parts = pages.slice(1).flatMap((p) => p.findings);
    expect(Object.keys(parts[0] ?? {})).toEqual([
      "kind",
      "id",
      "severity",
      "files",
      "part",
      "chain",
    ]);
    expect(parts.map((f) => [f.files, f.chain.length])).toEqual([
      [["tiny:lib/consts.ts", "tiny:lib/units.ts"], 1],
      [[], 1],
    ]);
    expect(parts.flatMap((f) => f.chain)).toEqual(whole.findings[1]?.chain);
  });

  it("windows code_snippet under the host's cap, and an explicit offset always windows", () => {
    const a = { repo: "tiny", file: "lib/orbit.ts" };
    const whole = answer<SnippetAnswer>(run("code_snippet", a));
    const pages = follow<SnippetAnswer>(
      fixedHost({ tiny }, { maxResultChars: 600 }),
      "code_snippet",
      a,
    );
    expect(
      pages.map((p) =>
        "offset" in p ? [p.offset, p.returned, p.total] : null,
      ),
    ).toEqual([
      [0, 139, 330],
      [139, 120, 330],
      [259, 71, 330],
    ]);
    expect(pages[0]).toMatchObject({
      note: "characters 1-139 of 330; call again with offset 139 for the next window",
    });
    for (const p of pages) expect(measure(p)).toBeLessThanOrEqual(600);
    expect(pages.map((p) => p.lines.join("\n")).join("")).toBe(
      whole.lines.join("\n"),
    );
    expect(
      answer(run("code_snippet", { repo: "tiny", target: "solve", offset: 0 })),
    ).toMatchObject({
      offset: 0,
      returned: 151,
      total: 151,
      hasMore: false,
      note: "characters 1-151 of 151; this is the last window",
    });
  });

  it("never pages a library answer, even at an explicit offset over the cap", () => {
    const capped = fixedHost({ tiny }, { maxResultChars: 100 });
    const library = answer(
      run(
        "code_references",
        { repo: "tiny", symbol: "tiny:npm:react", offset: 0 },
        capped,
      ),
    );
    expect(Object.keys(library)).toEqual([
      "id",
      "kind",
      "builtCommit",
      "stale",
      "importedBy",
      "view",
    ]);
    expect(
      answer(
        run("code_references", {
          repo: "tiny",
          symbol: "lib/orbit.ts#Orbit",
          offset: 0,
        }),
      ),
    ).toHaveProperty("offset", 0);
  });
});
