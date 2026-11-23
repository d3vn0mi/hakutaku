// viewerApi: the viewer's JSON API over a Host, for one mounted repo. It answers the map, a file's
// outline, a file's source and the history, and runs the read-only tools for the page's Agent tab.
// It checks no session and no Host header: the host authenticates the caller before it calls.
// It is synchronous, as runTool and node:sqlite are, and never throws: an exception becomes the
// internal error, and its details go only to the host's log. Every answer it makes once the repo's
// store is open names the store's build in BUILD_HEADER, so the page can tell a rebuild at the
// same commit from its own build, by a tool's reply and a refusal too.
import { parseId, type RepoId } from "../model/index.js";
import {
  buildOf,
  fileIdOf,
  historyData,
  mapData,
  outlineData,
  sourceData,
} from "../query/view/index.js";
import { isDenied } from "../redact/denylist.js";
import type { Store } from "../store/index.js";
import {
  type CallContext,
  echo,
  type Host,
  runTool,
  TOOL_NAMES,
  type ToolError,
  toolError,
} from "../tools/index.js";
import { BUILD_HEADER, SECURITY_HEADERS } from "./csp.js";
import type { ViewerRequest, ViewerResponse } from "./types.js";

type Route = "map" | "outline" | "source" | "history" | "tool";

const TOOL_PATH = "tool/";
const TOOLS: ReadonlySet<string> = new Set(TOOL_NAMES);

export function viewerApi(
  host: Host,
  ctx: CallContext,
  repo: RepoId,
  req: ViewerRequest,
): ViewerResponse {
  try {
    return answer(host, ctx, repo, req);
  } catch (err) {
    log(err);
    return failure(500, toolError("internal", "internal error"));
  }
}

// The host's log: the only place an exception's details go, from viewerApi or from runTool.
function log(err: unknown): void {
  try {
    console.error("hakutaku viewer:", err);
  } catch {
    // A log that fails changes nothing: the answer is the internal error either way.
  }
}

// The checks, in order: the route and its method, the repo's store, then the route's own.
function answer(
  host: Host,
  ctx: CallContext,
  repo: RepoId,
  req: ViewerRequest,
): ViewerResponse {
  const route = routeOf(req.path);
  if (route === undefined) {
    return failure(
      404,
      toolError("not_found", `unknown endpoint ${echo(req.path)}`),
    );
  }
  const method = route === "tool" ? "POST" : "GET";
  if (req.method !== method) {
    const what = route === "tool" ? "a tool call" : route;
    return failure(
      405,
      toolError("invalid_argument", `${what} takes ${method} only`, {
        field: "method",
      }),
    );
  }

  const store = host.open(ctx, repo);
  if ("code" in store) {
    return store.code === "not_built"
      ? failure(
          503,
          toolError("not_built", `${repo} has no usable store`, {
            reason: store.reason,
          }),
        )
      : failure(
          404,
          toolError("unknown_repo", `unknown repo ${echo(repo)}`, {
            known: host.repos(ctx).map((entry) => entry.id),
          }),
        );
  }

  return named(served(host, ctx, repo, req, route, store), buildOf(store));
}

// An answer made once the store is open, which names the store's build in BUILD_HEADER.
function named(res: ViewerResponse, build: string): ViewerResponse {
  return { ...res, headers: { ...res.headers, [BUILD_HEADER]: build } };
}

// The route's own answer, over the repo's open store.
function served(
  host: Host,
  ctx: CallContext,
  repo: RepoId,
  req: ViewerRequest,
  route: Route,
  store: Store,
): ViewerResponse {
  switch (route) {
    case "map":
      return data(
        mapData(store, {
          stale: host.freshness(repo).stale,
          snippets: host.snippets(repo),
        }),
      );
    case "history":
      return data(historyData(store));
    case "outline": {
      const file = fileOf(store, repo, req.query);
      return "status" in file ? file : data(outlineData(store, file.id));
    }
    case "source": {
      const file = fileOf(store, repo, req.query);
      return "status" in file ? file : source(host, store, repo, file);
    }
    case "tool":
      return tool(host, ctx, repo, req.path.slice(TOOL_PATH.length), req.body);
  }
}

function routeOf(path: string): Route | undefined {
  if (
    path === "map" ||
    path === "outline" ||
    path === "source" ||
    path === "history"
  ) {
    return path;
  }
  return path.startsWith(TOOL_PATH) ? "tool" : undefined;
}

interface HeldFile {
  id: number;
  path: string;
}

// The file a request names: its query's own file parameter, which must be the ID of a file of
// the mounted repo as parseId reads it, at a path the store holds exactly. A denylisted path is
// never stored, and says so.
function fileOf(
  store: Store,
  repo: RepoId,
  query: Record<string, string>,
): HeldFile | ViewerResponse {
  const given = Object.hasOwn(query, "file") ? query.file : undefined;
  const ref = typeof given === "string" ? parseId(given) : null;
  if (ref === null || ref.kind !== "file" || ref.repo !== repo) {
    return failure(
      400,
      toolError(
        "invalid_argument",
        `file must be the ID of a file of ${repo}`,
        {
          field: "file",
        },
      ),
    );
  }
  const id = fileIdOf(store, ref.path);
  if (id === null) {
    return failure(
      404,
      isDenied(ref.path, [])
        ? toolError(
            "denied_file",
            `${echo(ref.path)} is denylisted and was never stored`,
          )
        : toolError("not_found", `${echo(ref.path)} is not in the store`),
    );
  }
  return { id, path: ref.path };
}

// A file's text, when the store holds sources, the host shows them and this file's is stored.
function source(
  host: Host,
  store: Store,
  repo: RepoId,
  file: HeldFile,
): ViewerResponse {
  if (store.meta.noSource) {
    return failure(
      404,
      toolError("no_source", `sources are not stored for ${repo}`),
    );
  }
  if (!host.snippets(repo)) {
    return failure(404, toolError("no_source", `snippets are off for ${repo}`));
  }
  const found = sourceData(store, file.id);
  return found === null
    ? failure(
        404,
        toolError(
          "no_source",
          `${echo(file.path)} has no stored source (over 1 MB, minified or generated)`,
        ),
      )
    : data(found);
}

// A read-only tool, run by runTool on the mounted repo with runTool's own answer or error.
// code_refresh starts a build: a host that authenticates its callers with a cookie would let a
// cross-site POST reach it, so it is not served here at all.
function tool(
  host: Host,
  ctx: CallContext,
  repo: RepoId,
  name: string,
  body: string | undefined,
): ViewerResponse {
  if (name === "code_refresh") {
    return failure(
      404,
      toolError("not_found", "code_refresh is not served by the viewer"),
    );
  }
  if (!TOOLS.has(name)) {
    return failure(404, toolError("not_found", `unknown tool ${echo(name)}`));
  }
  const args = argsOf(body);
  if (args === undefined) {
    return failure(
      400,
      toolError(
        "invalid_argument",
        "the body must be a JSON object of the tool's arguments",
        { field: "body" },
      ),
    );
  }
  const given = Object.hasOwn(args, "repo");
  if (given && args.repo !== repo) {
    return failure(
      400,
      toolError("invalid_argument", `repo must be ${repo}, the viewer's repo`, {
        field: "repo",
      }),
    );
  }
  const result = runTool(
    host,
    ctx,
    name,
    given ? args : { repo, ...args },
    log,
  );
  return result.ok
    ? respond(200, JSON.stringify(result.answer, null, 2))
    : failure(422, result.error);
}

// The body as a JSON object, or undefined for no body, text that is not JSON, or another value.
function argsOf(body: string | undefined): Record<string, unknown> | undefined {
  if (typeof body !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

// Every response carries the security headers, in a fresh object a host may add to.
const respond = (status: number, body: string): ViewerResponse => ({
  status,
  headers: {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
  },
  body,
});

// The data endpoints answer compact JSON; errors are written as tools write them.
const data = (value: object): ViewerResponse =>
  respond(200, JSON.stringify(value));

const failure = (status: number, error: ToolError): ViewerResponse =>
  respond(status, JSON.stringify({ error }, null, 2));
