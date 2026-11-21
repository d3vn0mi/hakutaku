// code_deps: the imports around a file (docs/tools.md). Direction out lists its resolved
// imports, direction in its importers; each edge carries the import's kind, line and specifier,
// and the text of that line, from the file that imports. With transitive, the walk goes
// breadth-first through the edges kinds allows, and lists every node it reaches once, at its
// first hop; it is iterative, with a seen set, so a cyclic graph neither recurses nor loops.
import { comparePaths, viewOf } from "../model/index.js";
import type { Store } from "../store/index.js";
import type { Checked, DepsAnswer } from "../tools/types.js";
import { fail, ok, type QueryCtx, type QueryOut } from "./ctx.js";
import { resolveTarget, wrongKind } from "./resolve.js";
import { locationText } from "./source.js";
import {
  type FileInfo,
  type ImportEdge,
  type StoreIndex,
  storeIndex,
} from "./store-index.js";
import { importBlindSpots } from "./tiers.js";

type Edge = DepsAnswer["edges"][number];

// An import row seen from the file a walk stands on: the node at its far end (a repo file, or an
// external module, which has no rank), and the hop that reached it, when the walk is transitive.
interface Step {
  edge: ImportEdge;
  id: string;
  file: FileInfo | null;
  hop?: number;
}

export function queryDeps(
  store: Store,
  args: Checked<"code_deps">,
  q: QueryCtx,
): QueryOut<DepsAnswer> {
  const target = resolveTarget(store, q.repo, args.file, "file");
  if ("code" in target) return fail(target);
  const refuse = (hint: string) =>
    fail(wrongKind("file", target, "code_deps", "a file", hint));
  switch (target.kind) {
    case "definition":
      return refuse("pass the file that defines it");
    case "external":
      return refuse("code_references lists a library's importers");
    case "repo":
    case "directory":
      return refuse("code_overview describes repos and components");
    case "file":
      break;
  }
  const ix = storeIndex(store);
  const allowed =
    args.kinds === undefined ? undefined : new Set<string>(args.kinds);
  const around = (fileId: number): Step[] =>
    args.direction === "out"
      ? importsOf(ix, fileId, allowed)
      : importersOf(ix, fileId, allowed);
  const steps = args.transitive
    ? walk(ix, target.fileId, around)
    : around(target.fileId).sort(compareSteps);
  return ok({
    id: ix.idOfFile(target.fileId),
    builtCommit: q.builtCommit,
    stale: q.stale,
    direction: args.direction,
    edges: steps.map((step) => edgeOf(store, q, step)),
    blindSpots: importBlindSpots(store, fileAt(ix, target.fileId).lang),
    view: viewOf(target.ref),
  });
}

// Breadth-first from fileId: each hop goes on from the repo files the last one reached, in the
// answer's order, and keeps the first edge that reaches each new node. fileId counts as seen.
function walk(
  ix: StoreIndex,
  fileId: number,
  around: (fileId: number) => Step[],
): Step[] {
  const seen = new Set([ix.idOfFile(fileId)]);
  const out: Step[] = [];
  let frontier = [fileId];
  for (let hop = 1; frontier.length > 0; hop++) {
    const reached: Step[] = [];
    for (const from of frontier) {
      for (const step of around(from)) {
        if (seen.has(step.id)) continue;
        seen.add(step.id);
        reached.push({ ...step, hop });
      }
    }
    reached.sort(compareSteps);
    out.push(...reached);
    frontier = reached.flatMap((step) =>
      step.file === null ? [] : [step.file.id],
    );
  }
  return out;
}

// A file's resolved imports that kinds allows, each toward the file or external it imports.
function importsOf(
  ix: StoreIndex,
  fileId: number,
  allowed: ReadonlySet<string> | undefined,
): Step[] {
  const steps: Step[] = [];
  for (const edge of ix.importsOut.get(fileId) ?? []) {
    if (allowed !== undefined && !allowed.has(edge.kind)) continue;
    if (edge.dstFile !== null) {
      steps.push({
        edge,
        id: ix.idOfFile(edge.dstFile),
        file: fileAt(ix, edge.dstFile),
      });
    } else if (edge.dstExternal !== null) {
      steps.push({ edge, id: ix.idOfExternal(edge.dstExternal), file: null });
    }
  }
  return steps;
}

// The imports of a file that kinds allows, each toward the file that imports it.
function importersOf(
  ix: StoreIndex,
  fileId: number,
  allowed: ReadonlySet<string> | undefined,
): Step[] {
  const steps: Step[] = [];
  for (const edge of ix.importsIn.get(fileId) ?? []) {
    if (allowed !== undefined && !allowed.has(edge.kind)) continue;
    steps.push({ edge, id: ix.idOfFile(edge.src), file: fileAt(ix, edge.src) });
  }
  return steps;
}

// By hop, then by the rank of the node: ranked files by rank, then files without a rank, then
// externals; then comparePaths over the node's ID, the line, and the store's row order.
function compareSteps(a: Step, b: Step): number {
  return (
    (a.hop ?? 0) - (b.hop ?? 0) ||
    rankOrder(a.file, b.file) ||
    comparePaths(a.id, b.id) ||
    a.edge.line - b.edge.line ||
    a.edge.id - b.edge.id
  );
}

function rankOrder(a: FileInfo | null, b: FileInfo | null): number {
  if (a === null || b === null) {
    return a === b ? 0 : a === null ? 1 : -1;
  }
  if (a.rank === b.rank) return 0;
  if (a.rank === null) return 1;
  if (b.rank === null) return -1;
  return a.rank - b.rank;
}

// An edge as the answer lists it; line, specifier and text come from the importing file.
function edgeOf(store: Store, q: QueryCtx, step: Step): Edge {
  const text = locationText(store, q, step.edge.src, step.edge.line);
  return {
    id: step.id,
    kind: step.edge.kind,
    line: step.edge.line,
    ...(step.hop === undefined ? {} : { hop: step.hop }),
    specifier: step.edge.specifier,
    ...(text === undefined ? {} : { text }),
  };
}

function fileAt(ix: StoreIndex, fileId: number): FileInfo {
  const file = ix.files.get(fileId);
  if (file === undefined)
    throw new RangeError(`the store has no file ${fileId}`);
  return file;
}
