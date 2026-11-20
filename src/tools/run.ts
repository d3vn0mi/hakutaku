// runTool: the one entry point of every face. It checks the call, applies the host's gate, runs
// the tool's query and pages the answer under host.maxResultChars. It is synchronous and never
// throws: an exception becomes an internal error, and goes to onInternal.
import {
  type QueryCtx,
  type QueryOut,
  queryCallers,
  queryDeps,
  queryExplain,
  queryFind,
  queryImpact,
  queryOverview,
  queryPath,
  queryReferences,
  queryRules,
  querySearchText,
  querySnippet,
} from "../query/index.js";
import type { Store } from "../store/index.js";
import { LIST_ADAPTERS } from "./adapters.js";
import { echo, type ToolError, type ToolResult, toolError } from "./errors.js";
import type { CallContext, Host, LastAttempt } from "./host.js";
import { REFRESH_INTERVAL_SECONDS } from "./limits.js";
import { pageList, pageText } from "./paging.js";
import { builtStore, reposAnswer, shortCommit } from "./repos.js";
import {
  type Checked,
  type RefreshAnswer,
  TOOL_NAMES,
  type ToolAnswer,
  type ToolName,
} from "./types.js";
import { checkArgs } from "./validate.js";

// The tools that answer from a repo's store.
type ContentTool = Exclude<ToolName, "code_repos" | "code_refresh">;

type Query<N extends ContentTool> = (
  store: Store,
  args: Checked<N>,
  q: QueryCtx,
) => QueryOut<ToolAnswer<N>>;

const QUERIES: { readonly [N in ContentTool]: Query<N> } = Object.freeze({
  code_overview: queryOverview,
  code_find: queryFind,
  code_explain: queryExplain,
  code_callers: queryCallers,
  code_references: queryReferences,
  code_impact: queryImpact,
  code_deps: queryDeps,
  code_path: queryPath,
  code_rules: queryRules,
  code_search_text: querySearchText,
  code_snippet: querySnippet,
});

const TOOLS: ReadonlySet<string> = new Set(TOOL_NAMES);

// A name of TOOL_NAMES itself: never one that an object inherits, such as "toString".
const isToolName = (name: string): name is ToolName => TOOLS.has(name);

export function runTool(
  host: Host,
  ctx: CallContext,
  name: string,
  args: unknown,
  onInternal?: (err: unknown) => void,
): ToolResult {
  try {
    return dispatch(host, ctx, name, args);
  } catch (err) {
    try {
      onInternal?.(err);
    } catch {
      // A log that fails changes nothing: the answer is the internal error either way.
    }
    return failed(toolError("internal", "internal error"));
  }
}

function dispatch(
  host: Host,
  ctx: CallContext,
  name: string,
  args: unknown,
): ToolResult {
  // A name that is not a string can only come from untyped code; it is still named, not thrown.
  if (typeof name !== "string" || !isToolName(name)) {
    return failed(
      toolError("invalid_argument", `unknown tool ${echo(String(name))}`, {
        field: "name",
        hint: `the tools are ${TOOL_NAMES.join(", ")}`,
      }),
    );
  }
  if (name === "code_repos") {
    const checked = checkArgs(name, args);
    if (!checked.ok) return checked;
    return { ok: true, answer: reposAnswer(host, ctx) };
  }
  if (name === "code_refresh") return refresh(host, ctx, args);
  return content(host, ctx, name, args);
}

// The gate: repo must equal the id of an entry of host.repos(ctx), the repos this caller may
// ask about. The host is asked nothing else about any other repo.
function gate(
  host: Host,
  ctx: CallContext,
  repo: string,
): { ok: true; known: string[] } | { ok: false; error: ToolError } {
  const known = host.repos(ctx).map((entry) => entry.id);
  return known.includes(repo)
    ? { ok: true, known }
    : failed(unknownRepo(repo, known));
}

const unknownRepo = (repo: string, known: string[]) =>
  toolError("unknown_repo", `unknown repo ${echo(repo)}`, { known });

// code_refresh: the gate, then host.refresh. A build that is rate-limited answers an error;
// any other state answers with the commit the store was built at (host.open) and the head
// (host.freshness).
function refresh(host: Host, ctx: CallContext, args: unknown): ToolResult {
  const checked = checkArgs("code_refresh", args);
  if (!checked.ok) return checked;
  const { repo } = checked.args;
  const gated = gate(host, ctx, repo);
  if (!gated.ok) return gated;
  if (host.refresh === undefined) {
    return failed(toolError("refresh_disabled", "this host offers no refresh"));
  }
  const r = host.refresh(repo);
  if (r.state === "rate_limited") {
    return failed(
      toolError(
        "rate_limited",
        `${repo} was refreshed less than ${REFRESH_INTERVAL_SECONDS / 60} minutes ago`,
        { retryAfterSeconds: r.retryAfterSeconds },
      ),
    );
  }
  const store = builtStore(host.open(ctx, repo));
  const { headCommit } = host.freshness(repo);
  const answer: RefreshAnswer = {
    state: r.state,
    builtCommit: store === undefined ? null : shortCommit(store.meta.commit),
    headCommit: headCommit === null ? null : shortCommit(headCommit),
  };
  if (r.lastAttempt !== undefined) answer.lastAttempt = attempt(r.lastAttempt);
  // Only a build that is queued or running gives the seconds until another call would queue one.
  if (
    (r.state === "queued" || r.state === "building") &&
    r.retryAfterSeconds !== undefined
  ) {
    answer.retryAfterSeconds = r.retryAfterSeconds;
  }
  return { ok: true, answer };
}

// A copy of the host's last attempt, its keys in LastAttempt's order.
function attempt(a: LastAttempt): LastAttempt {
  return a.reason === undefined
    ? { at: a.at, result: a.result }
    : { at: a.at, result: a.result, reason: a.reason };
}

// A tool that answers from the store: the gate, host.open, host.freshness and host.snippets, in
// that order, then the query, then the paging.
function content<N extends ContentTool>(
  host: Host,
  ctx: CallContext,
  tool: N,
  args: unknown,
): ToolResult {
  const checked = checkArgs(tool, args);
  if (!checked.ok) return checked;
  const given: object = checked.args;
  const repo = repoOf(given);
  const gated = gate(host, ctx, repo);
  if (!gated.ok) return gated;
  const opened = host.open(ctx, repo);
  if ("code" in opened) {
    return failed(
      opened.code === "not_built"
        ? toolError("not_built", `${repo} has no usable store`, {
            reason: opened.reason,
          })
        : unknownRepo(repo, gated.known),
    );
  }
  const { stale } = host.freshness(repo);
  const snippets = host.snippets(repo);
  const q: QueryCtx = {
    repo,
    builtCommit: shortCommit(opened.meta.commit),
    stale,
    snippets,
  };
  const out = QUERIES[tool](opened, checked.args, q);
  if (!out.ok) return out;
  return {
    ok: true,
    answer: page(tool, out.answer, given, host.maxResultChars),
  };
}

// The answer as it goes out: a list answer through its adapter's pageList, code_snippet's
// through pageText, and the rest, a library answer of code_references included, whole.
function page(
  tool: ContentTool,
  answer: object,
  args: object,
  maxChars: number,
): object {
  const offset =
    "offset" in args && typeof args.offset === "number"
      ? args.offset
      : undefined;
  const adapter = LIST_ADAPTERS[tool];
  if (adapter !== undefined && !isLibrary(answer)) {
    // checkArgs gives every paged tool its default limit.
    if (!("limit" in args && typeof args.limit === "number")) {
      throw new Error(`${tool} was checked without a limit`);
    }
    return pageList(answer, adapter, { offset, limit: args.limit, maxChars });
  }
  if (tool === "code_snippet" && hasLines(answer)) {
    return pageText(answer, { offset, maxChars });
  }
  return answer;
}

// The checked repo: checkArgs requires it of every tool but code_repos.
function repoOf(args: object): string {
  if ("repo" in args && typeof args.repo === "string") return args.repo;
  throw new Error("a call was checked without a repo");
}

const isLibrary = (answer: object): boolean =>
  "kind" in answer && answer.kind === "library";

const hasLines = (answer: object): answer is { lines: string[] } =>
  "lines" in answer && Array.isArray(answer.lines);

const failed = (error: ToolError): { ok: false; error: ToolError } => ({
  ok: false,
  error,
});
