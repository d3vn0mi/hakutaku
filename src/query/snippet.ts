// code_snippet: source lines (docs/tools.md), a definition's range or a file's, at most
// MAX_SNIPPET_LINES of them from the range's start, with next pointing past the cap. The lines
// are the stored ones, neither trimmed nor cut: runTool windows an answer too long to send.
//
// The checks run in this order: target and file, which need no store; the node they name and
// its kind; from and to beside a definition; then no_source, for the store, for this repo's
// snippets, and for the file; then the file's range.
import { viewOf } from "../model/index.js";
import type { Store } from "../store/index.js";
import { type ToolError, toolError } from "../tools/errors.js";
import { MAX_SNIPPET_LINES } from "../tools/limits.js";
import type { Checked, SnippetAnswer } from "../tools/types.js";
import { fail, ok, type QueryCtx, type QueryOut } from "./ctx.js";
import { type Resolved, resolveTarget, wrongKind } from "./resolve.js";
import { sourceLines } from "./source.js";
import { type StoreIndex, storeIndex } from "./store-index.js";

// What redaction leaves in a stored line, in the form «redacted:<rule>».
const REDACTED = "«redacted:";

const OVERVIEW_HINT = "code_overview describes repos and components";
const LIBRARY_HINT = "code_references lists a library's importers";

type Readable = Extract<Resolved, { kind: "file" | "definition" }>;

// The lines to read: first and last, before the cap.
interface Range {
  from: number;
  end: number;
}

export function querySnippet(
  store: Store,
  args: Checked<"code_snippet">,
  q: QueryCtx,
): QueryOut<SnippetAnswer> {
  if (args.target !== undefined && args.file !== undefined) {
    return fail(
      invalid(
        "target and file cannot both be given",
        "file",
        "pass target or file, not both",
      ),
    );
  }
  const asked =
    args.target !== undefined
      ? { field: "target", value: args.target }
      : args.file !== undefined
        ? { field: "file", value: args.file }
        : undefined;
  if (asked === undefined) {
    return fail(
      invalid(
        "target or file is required",
        "target",
        "pass target, or file with from and to",
      ),
    );
  }
  const node = readable(store, q, asked.field, asked.value);
  if ("code" in node) return fail(node);
  if (
    node.kind === "definition" &&
    (args.from !== undefined || args.to !== undefined)
  ) {
    return fail(
      invalid(
        "from and to apply to a file, not to a definition",
        "from",
        "from and to go with file",
      ),
    );
  }
  if (store.meta.noSource) {
    return fail(toolError("no_source", `sources are not stored for ${q.repo}`));
  }
  if (!q.snippets) {
    return fail(toolError("no_source", `snippets are off for ${q.repo}`));
  }
  const ix = storeIndex(store);
  const file = ix.files.get(node.fileId);
  if (file === undefined) {
    throw new RangeError(`the store has no file ${node.fileId}`);
  }
  const source = file.hasSource ? sourceLines(store, file.id) : null;
  if (source === null) {
    return fail(
      toolError(
        "no_source",
        `${file.path} has no stored source (over 1 MB, minified or generated)`,
      ),
    );
  }
  const range =
    node.kind === "definition"
      ? definitionRange(ix, node.defId)
      : fileRange(args, file.path, source.length);
  if ("code" in range) return fail(range);
  const { from, end } = range;
  const to = Math.min(end, from + MAX_SNIPPET_LINES - 1);
  const truncated = end > to;
  const lines = source.slice(from - 1, to);
  return ok({
    id:
      node.kind === "definition"
        ? ix.idOfDef(node.defId)
        : ix.idOfFile(file.id),
    file: ix.idOfFile(file.id),
    builtCommit: q.builtCommit,
    stale: q.stale,
    from,
    to,
    lines,
    truncated,
    ...(truncated
      ? { next: { from: to + 1, to: Math.min(end, to + MAX_SNIPPET_LINES) } }
      : {}),
    redactions: redactionsIn(lines),
    untrusted: true,
    view: viewOf(node.ref),
  });
}

// The node a snippet reads: target names a file or a definition, file names a file.
function readable(
  store: Store,
  q: QueryCtx,
  field: string,
  value: string,
): Readable | ToolError {
  const node = resolveTarget(store, q.repo, value, field);
  if ("code" in node) return node;
  const takes = field === "target" ? "a file or a definition" : "a file";
  const refuse = (hint: string) =>
    wrongKind(field, node, "code_snippet", takes, hint);
  switch (node.kind) {
    case "file":
      return node;
    case "definition":
      return field === "target" ? node : refuse("pass a definition as target");
    case "external":
      return refuse(LIBRARY_HINT);
    case "repo":
    case "directory":
      return refuse(OVERVIEW_HINT);
  }
}

function definitionRange(ix: StoreIndex, defId: number): Range {
  const def = ix.defs.get(defId);
  if (def === undefined) {
    throw new RangeError(`the store has no definition ${defId}`);
  }
  return { from: def.startLine, end: def.endLine };
}

// A file's range, from from (1 when absent) to to (its last line when absent), never past its
// last line. from may not lie past the last line, though an empty file reads as lines 1 to 0;
// to may not lie below from.
function fileRange(
  args: Checked<"code_snippet">,
  path: string,
  n: number,
): Range | ToolError {
  const from = args.from ?? 1;
  if (from > Math.max(n, 1)) {
    return invalid(
      `from ${from} is beyond the file`,
      "from",
      `${path} has ${n} ${n === 1 ? "line" : "lines"}`,
    );
  }
  if (args.to !== undefined && args.to < from) {
    return invalid(
      `to ${args.to} is below from ${from}`,
      "to",
      "to must be at least from",
    );
  }
  return { from, end: Math.min(args.to ?? n, n) };
}

// How many times redaction marked the lines: a line may hold more than one mark.
function redactionsIn(lines: readonly string[]): number {
  let n = 0;
  for (const line of lines) n += line.split(REDACTED).length - 1;
  return n;
}

function invalid(message: string, field: string, hint: string): ToolError {
  return toolError("invalid_argument", message, { field, hint });
}
