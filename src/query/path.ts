// code_path: the shortest directed path between two nodes, each hop with its line
// (docs/tools.md). Via imports the endpoints are files, and to may be a library; each hop is
// one import. Via calls they are definitions; each hop is one callee, labelled by its strongest
// call. The walk is breadth-first from `from`, with parent links, and stops when it reaches
// `to`; it is iterative, with a seen set, so a cyclic graph neither recurses nor loops.
import { comparePaths, type Lang, viewOf } from "../model/index.js";
import type { Store } from "../store/index.js";
import type { ToolError } from "../tools/errors.js";
import type { Checked, PathAnswer } from "../tools/types.js";
import { type CallLink, calleesOf, strongest } from "./calls.js";
import { fail, ok, type QueryCtx, type QueryOut } from "./ctx.js";
import { type Resolved, resolveTarget, wrongKind } from "./resolve.js";
import { locationText } from "./source.js";
import {
  type DefInfo,
  type FileInfo,
  type StoreIndex,
  storeIndex,
} from "./store-index.js";
import { pathBlindSpots } from "./tiers.js";

type Hop = PathAnswer["hops"][number];
type Via = Checked<"code_path">["via"];
type Endpoint = Extract<Resolved, { kind: "file" | "definition" | "external" }>;

const DEFINITION_HINT =
  "via imports takes files; pass via calls for definitions";
const FILE_HINT = "via calls takes definitions; pass path#name";
const OTHER_HINT = "code_path takes files or definitions";

// One way out of a node: the node it leads to, the hop's kind and line, and the file that line
// is in. A node is a file's id or minus a library's id via imports, and a definition's id via
// calls.
interface Step {
  to: number;
  kind: Hop["kind"];
  line: number;
  fileId: number;
}

interface Link {
  from: number;
  step: Step;
}

export function queryPath(
  store: Store,
  args: Checked<"code_path">,
  q: QueryCtx,
): QueryOut<PathAnswer> {
  const from = endpoint(store, q, args.via, "from", args.from);
  if ("code" in from) return fail(from);
  const to = endpoint(store, q, args.via, "to", args.to);
  if ("code" in to) return fail(to);
  const ix = storeIndex(store);
  const start = nodeOf(from);
  const goal = nodeOf(to);
  const links =
    start === goal
      ? []
      : walk(start, goal, (node) =>
          args.via === "calls"
            ? calleeSteps(store, ix, node)
            : importSteps(ix, node),
        );
  const idOf = (node: number): string =>
    args.via === "calls"
      ? ix.idOfDef(node)
      : node < 0
        ? ix.idOfExternal(-node)
        : ix.idOfFile(node);
  return ok({
    from: idOf(start),
    to: idOf(goal),
    via: args.via,
    builtCommit: q.builtCommit,
    stale: q.stale,
    found: links !== null,
    hops: (links ?? []).map(({ from: node, step }): Hop => {
      const text = locationText(store, q, step.fileId, step.line);
      return {
        from: idOf(node),
        to: idOf(step.to),
        kind: step.kind,
        line: step.line,
        ...(text === undefined ? {} : { text }),
      };
    }),
    blindSpots: pathBlindSpots(store, args.via, langOf(ix, from)),
    view: viewOf(from.ref),
  });
}

// The language of an endpoint's file. A library has none; from is never one.
function langOf(ix: StoreIndex, node: Endpoint): Lang | null {
  return node.kind === "external" ? null : fileAt(ix, node.fileId).lang;
}

// An endpoint resolved, and refused unless via takes its kind: files via imports, where to may
// also be a library, and definitions via calls.
function endpoint(
  store: Store,
  q: QueryCtx,
  via: Via,
  field: "from" | "to",
  target: string,
): Endpoint | ToolError {
  const node = resolveTarget(store, q.repo, target, field);
  if ("code" in node) return node;
  const takes =
    via === "calls"
      ? "a definition via calls"
      : field === "to"
        ? "a file or a library via imports"
        : "a file via imports";
  const refuse = (hint: string) =>
    wrongKind(field, node, "code_path", takes, hint);
  if (via === "imports") {
    if (node.kind === "file") return node;
    if (node.kind === "external" && field === "to") return node;
    return refuse(node.kind === "definition" ? DEFINITION_HINT : OTHER_HINT);
  }
  if (node.kind === "definition") return node;
  return refuse(node.kind === "file" ? FILE_HINT : OTHER_HINT);
}

function nodeOf(endpoint: Endpoint): number {
  switch (endpoint.kind) {
    case "file":
      return endpoint.fileId;
    case "external":
      return -endpoint.externalId;
    case "definition":
      return endpoint.defId;
  }
}

// Breadth-first from start, each node's steps in the order given, until a step reaches goal:
// the path's links in order, or null when goal is out of reach.
function walk(
  start: number,
  goal: number,
  stepsOf: (node: number) => readonly Step[],
): Link[] | null {
  const parent = new Map<number, Link>();
  const seen = new Set([start]);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head];
    for (const step of stepsOf(node)) {
      if (seen.has(step.to)) continue;
      seen.add(step.to);
      parent.set(step.to, { from: node, step });
      if (step.to === goal) return pathTo(parent, start, goal);
      queue.push(step.to);
    }
  }
  return null;
}

function pathTo(
  parent: ReadonlyMap<number, Link>,
  start: number,
  goal: number,
): Link[] {
  const links: Link[] = [];
  for (let node = goal; node !== start; ) {
    const link = parent.get(node);
    if (link === undefined) throw new RangeError(`no link into node ${node}`);
    links.push(link);
    node = link.from;
  }
  return links.reverse();
}

// A file's resolved imports, in the order of the node each leads to (files by path, then
// libraries by ID), then by line. A library leads nowhere further.
function importSteps(ix: StoreIndex, node: number): Step[] {
  if (node < 0) return [];
  const outs: { step: Step; library: boolean; key: string; row: number }[] = [];
  for (const edge of ix.importsOut.get(node) ?? []) {
    const at = { kind: edge.kind, line: edge.line, fileId: node };
    if (edge.dstFile !== null) {
      outs.push({
        step: { to: edge.dstFile, ...at },
        library: false,
        key: fileAt(ix, edge.dstFile).path,
        row: edge.id,
      });
    } else if (edge.dstExternal !== null) {
      outs.push({
        step: { to: -edge.dstExternal, ...at },
        library: true,
        key: ix.idOfExternal(edge.dstExternal),
        row: edge.id,
      });
    }
  }
  return outs
    .sort(
      (a, b) =>
        Number(a.library) - Number(b.library) ||
        comparePaths(a.key, b.key) ||
        a.step.line - b.step.line ||
        a.row - b.row,
    )
    .map((out) => out.step);
}

// A definition's callees, one step each: the strongest label among its calls to the callee, at
// the first line with that label; in the order of the callee's file path, start line and
// qualname.
function calleeSteps(store: Store, ix: StoreIndex, defId: number): Step[] {
  const best = new Map<number, CallLink>();
  for (const link of calleesOf(store, defId)) {
    const kept = best.get(link.calleeDefId);
    if (
      kept === undefined ||
      strongest(kept.label, link.label) !== kept.label ||
      (link.label === kept.label && link.line < kept.line)
    ) {
      best.set(link.calleeDefId, link);
    }
  }
  return [...best.values()]
    .map((link) => ({ link, def: defAt(ix, link.calleeDefId) }))
    .sort(
      (a, b) =>
        comparePaths(
          fileAt(ix, a.def.fileId).path,
          fileAt(ix, b.def.fileId).path,
        ) ||
        a.def.startLine - b.def.startLine ||
        comparePaths(a.def.qualname, b.def.qualname) ||
        a.def.id - b.def.id,
    )
    .map(({ link }) => ({
      to: link.calleeDefId,
      kind: link.label,
      line: link.line,
      fileId: link.fileId,
    }));
}

function fileAt(ix: StoreIndex, fileId: number): FileInfo {
  const file = ix.files.get(fileId);
  if (file === undefined)
    throw new RangeError(`the store has no file ${fileId}`);
  return file;
}

function defAt(ix: StoreIndex, defId: number): DefInfo {
  const def = ix.defs.get(defId);
  if (def === undefined) {
    throw new RangeError(`the store has no definition ${defId}`);
  }
  return def;
}
