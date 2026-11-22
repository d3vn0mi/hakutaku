// The viewer's API over a Host: the four data endpoints and the read-only tools, with the status,
// headers and body of each answer, as a host serves them.
import { renameSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { runTool } from "../../../src/tools/index.js";
import { viewerApi } from "../../../src/viewer/api.js";
import { SECURITY_HEADERS } from "../../../src/viewer/csp.js";
import type { ViewerResponse } from "../../../src/viewer/types.js";
import { tinyHost } from "./tiny-host.js";
import { tinyStore } from "./tiny-store.js";

const get = (
  path: string,
  query: Record<string, string> = {},
  host = tinyHost(tinyStore()),
) => viewerApi(host, undefined, "tiny", { method: "GET", path, query });
const post = (path: string, body: string, host = tinyHost(tinyStore())) =>
  viewerApi(host, undefined, "tiny", { method: "POST", path, query: {}, body });
const err = (r: ViewerResponse) => JSON.parse(String(r.body)).error;
const INTERNAL = JSON.stringify(
  { error: { code: "internal", message: "internal error" } },
  null,
  2,
);

it("GET map answers the compact map with the security headers", () => {
  const r = get("map");
  expect([r.status, r.headers["content-type"]]).toEqual([
    200,
    "application/json; charset=utf-8",
  ]);
  expect(JSON.parse(String(r.body)).builtCommit).toBe("4f2a9c1e07b3");
  for (const [k, v] of Object.entries(SECURITY_HEADERS))
    expect(r.headers[k]).toBe(v);
  // Data answers are compact: the body is its own compact serialization.
  expect(r.body).toBe(JSON.stringify(JSON.parse(String(r.body))));
  // The map's freshness and its sources flag are the host's.
  const stale = get("map", {}, tinyHost(tinyStore(), { stale: "unknown" }));
  expect(JSON.parse(String(stale.body)).stale).toBe("unknown");
  const off = get("map", {}, tinyHost(tinyStore(), { snippets: false }));
  expect(JSON.parse(String(off.body)).sources).toBe(false);
});

it("sends exactly these security headers, from a frozen record", () => {
  expect(SECURITY_HEADERS).toEqual({
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "cross-origin-resource-policy": "same-origin",
  });
  expect(Object.isFrozen(SECURITY_HEADERS)).toBe(true);
});

it("GET outline, source and history take the file's ID", () => {
  expect(get("outline", { file: "tiny:src/core/graph.ts" }).status).toBe(200);
  expect(
    JSON.parse(String(get("source", { file: "tiny:src/cli/main.ts" }).body))
      .sites,
  ).toHaveLength(1);
  expect(JSON.parse(String(get("history").body)).weeks).toHaveLength(26);
});

it("refuses a file argument that is not a file ID of this repo", () => {
  for (const file of [
    undefined,
    "src/core/graph.ts",
    "other:src/core/graph.ts",
    "tiny:src/core/",
    "tiny:npm:kleur",
  ]) {
    const r = get("outline", file === undefined ? {} : { file });
    expect([r.status, err(r).code, err(r).field]).toEqual([
      400,
      "invalid_argument",
      "file",
    ]);
  }
  expect([
    get("source", { file: "tiny:src/nope.ts" }).status,
    err(get("source", { file: "tiny:src/nope.ts" })).code,
  ]).toEqual([404, "not_found"]);
  expect(err(get("source", { file: "tiny:.env" })).code).toBe("denied_file");
  // Only the query's own file counts, never one it inherits.
  const inherited = viewerApi(tinyHost(tinyStore()), undefined, "tiny", {
    method: "GET",
    path: "outline",
    query: Object.create({ file: "tiny:src/core/graph.ts" }),
  });
  expect([inherited.status, err(inherited).field]).toEqual([400, "file"]);
});

it("answers no_source without stored sources or with snippets off", () => {
  expect(
    err(
      get(
        "source",
        { file: "tiny:src/cli/main.ts" },
        tinyHost(tinyStore({ noSource: true })),
      ),
    ).code,
  ).toBe("no_source");
  expect(
    err(
      get(
        "source",
        { file: "tiny:src/cli/main.ts" },
        tinyHost(tinyStore(), { snippets: false }),
      ),
    ).code,
  ).toBe("no_source");
});

it("maps host errors to 404 and 503", () => {
  const r = get("map", {}, tinyHost(tinyStore(), { repos: ["other"] }));
  expect([r.status, err(r).code, err(r).known]).toEqual([
    404,
    "unknown_repo",
    ["other"],
  ]);
  expect([
    get("map", {}, tinyHost("/nonexistent/store.sqlite")).status,
    err(get("map", {}, tinyHost("/nonexistent/store.sqlite"))).code,
  ]).toEqual([503, "not_built"]);
  expect(
    typeof err(get("map", {}, tinyHost("/nonexistent/store.sqlite"))).reason,
  ).toBe("string");
});

it("opens the repo before a tool runs, as before the data", () => {
  const ghost = post(
    "tool/code_explain",
    '{"target":"tiny:src/core/graph.ts"}',
    tinyHost("/nonexistent/store.sqlite"),
  );
  expect([ghost.status, err(ghost).code]).toEqual([503, "not_built"]);
  const other = post(
    "tool/code_explain",
    '{"target":"x"}',
    tinyHost(tinyStore(), { repos: ["other"] }),
  );
  expect([other.status, err(other).code, err(other).known]).toEqual([
    404,
    "unknown_repo",
    ["other"],
  ]);
});

it("POST tool answers exactly what runTool answers", () => {
  const host = tinyHost(tinyStore());
  const args = { repo: "tiny", target: "tiny:src/core/graph.ts" };
  const r = post("tool/code_explain", JSON.stringify(args), host);
  const direct = runTool(host, undefined, "code_explain", args);
  expect(r.status).toBe(200);
  expect(r.body).toBe(
    JSON.stringify((direct as { answer: object }).answer, null, 2),
  );
  const bad = post(
    "tool/code_explain",
    JSON.stringify({ repo: "tiny", target: "nope" }),
    host,
  );
  expect([bad.status, bad.body]).toEqual([
    422,
    JSON.stringify(
      {
        error: (
          runTool(host, undefined, "code_explain", {
            repo: "tiny",
            target: "nope",
          }) as { error: object }
        ).error,
      },
      null,
      2,
    ),
  ]);
});

it("refuses refresh, unknown tools, another repo, bad bodies and wrong methods", () => {
  const host = tinyHost(tinyStore());
  expect(post("tool/code_refresh", "{}").status).toBe(404);
  expect(post("tool/code_nope", "{}").status).toBe(404);
  expect(err(post("tool/code_refresh", "{}", host)).code).toBe("not_found");
  expect(err(post("tool/code_nope", "{}", host)).code).toBe("not_found");
  expect([
    post("tool/code_explain", '{"repo":"other","target":"x"}').status,
    err(post("tool/code_explain", '{"repo":"other","target":"x"}')).field,
  ]).toEqual([400, "repo"]);
  expect(
    post("tool/code_explain", '{"target":"tiny:src/core/graph.ts"}').status,
  ).toBe(200);
  expect(err(post("tool/code_explain", "not json")).field).toBe("body");
  // A body must be a JSON object: no other JSON value, and no body at all.
  for (const body of ["[]", "null", '"tiny"', "7", ""]) {
    const r = post("tool/code_explain", body, host);
    expect([r.status, err(r).code, err(r).field]).toEqual([
      400,
      "invalid_argument",
      "body",
    ]);
  }
  const none = viewerApi(host, undefined, "tiny", {
    method: "POST",
    path: "tool/code_explain",
    query: {},
  });
  expect([none.status, err(none).field]).toEqual([400, "body"]);
  expect(get("tool/code_explain").status).toBe(405);
  expect(
    viewerApi(tinyHost(tinyStore()), undefined, "tiny", {
      method: "DELETE",
      path: "map",
      query: {},
    }).status,
  ).toBe(405);
  expect(err(get("tool/code_explain", {}, host))).toMatchObject({
    code: "invalid_argument",
    field: "method",
  });
  expect(get("nope").status).toBe(404);
  expect(err(get("nope", {}, host)).code).toBe("not_found");
});

it("a swapped store answers the new build", () => {
  const path = tinyStore();
  const host = tinyHost(path);
  expect(JSON.parse(String(get("map", {}, host).body)).builtCommit).toBe(
    "4f2a9c1e07b3",
  );
  const next = tinyStore({ commit: `b0b0b0b0b0b0${"0".repeat(28)}` });
  renameSync(next, path); // the atomic swap extract performs
  expect(JSON.parse(String(get("map", {}, host).body)).builtCommit).toBe(
    "b0b0b0b0b0b0",
  );
});

it("an exception becomes internal, without details", () => {
  const thrown = new Error("/secret/path/store.sqlite is locked");
  const host = {
    ...tinyHost(tinyStore()),
    open() {
      throw thrown;
    },
  };
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const r = get("map", {}, host);
    expect([r.status, String(r.body)]).toEqual([
      500,
      JSON.stringify(
        { error: { code: "internal", message: "internal error" } },
        null,
        2,
      ),
    ]);
    // The exception goes to the host's log, and only there.
    expect(log).toHaveBeenCalledExactlyOnceWith("hakutaku viewer:", thrown);
    // A log that throws changes nothing.
    log.mockImplementation(() => {
      throw new Error("the log is closed");
    });
    expect(get("map", {}, host).body).toBe(INTERNAL);
  } finally {
    log.mockRestore();
  }
});

it("a tool's internal error is runTool's, and its exception goes to the same log", () => {
  const thrown = new Error("the head cannot be read");
  const host = {
    ...tinyHost(tinyStore()),
    freshness() {
      throw thrown;
    },
  };
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const r = post(
      "tool/code_explain",
      '{"target":"tiny:src/core/graph.ts"}',
      host,
    );
    expect([r.status, r.body]).toEqual([422, INTERNAL]);
    expect(log).toHaveBeenCalledExactlyOnceWith("hakutaku viewer:", thrown);
  } finally {
    log.mockRestore();
  }
});

it("every answer is JSON with exactly the security headers, errors and the internal one included", () => {
  const host = tinyHost(tinyStore());
  const broken = {
    ...host,
    open(): never {
      throw new Error("broken");
    },
  };
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const answers = [
      get("map", {}, host),
      get("history", {}, host),
      post("tool/code_explain", '{"target":"tiny:src/core/graph.ts"}', host),
      post("tool/code_explain", '{"target":"nope"}', host),
      get("outline", {}, host),
      get("source", { file: "tiny:src/nope.ts" }, host),
      get("nope", {}, host),
      get("tool/code_explain", {}, host),
      get("map", {}, tinyHost("/nonexistent/store.sqlite")),
      get("map", {}, broken),
    ];
    expect(answers.map((r) => r.status)).toEqual([
      200, 200, 200, 422, 400, 404, 404, 405, 503, 500,
    ]);
    for (const r of answers) {
      expect(r.headers).toEqual({
        ...SECURITY_HEADERS,
        "content-type": "application/json; charset=utf-8",
      });
    }
  } finally {
    log.mockRestore();
  }
});
