// code_callers: who calls a definition, grouped by the calling definition, each call site with
// its label (docs/tools.md). The walk goes breadth-first by hop and lists each caller once, at
// its first hop; a hop is only as strong as its weakest link.
import { type Label, viewOf } from "../model/index.js";
import type { Store } from "../store/index.js";
import { toolError } from "../tools/errors.js";
import type { CallersAnswer, Checked } from "../tools/types.js";
import { callersOf, type LinkLabel, strongest, weakest } from "./calls.js";
import { fail, ok, type QueryCtx, type QueryOut } from "./ctx.js";
import { resolveTarget, wrongKind } from "./resolve.js";
import { locationText } from "./source.js";
import {
  type DefInfo,
  type FileInfo,
  type StoreIndex,
  storeIndex,
} from "./store-index.js";
import { blindSpots } from "./tiers.js";

type Caller = CallersAnswer["callers"][number];
type Site = Caller["sites"][number];

// The labels code_callers answers with, in the order its answer lists them.
const CALL_LABELS = ["bound", "scoped", "unscoped"] as const;

// A caller found at a hop: its sites by site id, and the strongest label among them, which is
// the label of the paths that go on through it.
interface Found {
  def: DefInfo;
  file: FileInfo;
  hop: number;
  sites: Map<
    number,
    {
      line: number;
      col: number;
      label: Label;
      collision: boolean;
      fileId: number;
    }
  >;
  path: LinkLabel;
}

export function queryCallers(
  store: Store,
  args: Checked<"code_callers">,
  q: QueryCtx,
): QueryOut<CallersAnswer> {
  if (args.labels.includes("reference")) {
    return fail(
      toolError(
        "invalid_argument",
        "labels cannot include reference: references are not calls",
        { field: "labels", hint: "code_references lists them" },
      ),
    );
  }
  const target = resolveTarget(store, q.repo, args.symbol, "symbol");
  if ("code" in target) return fail(target);
  const refuse = (hint: string) =>
    fail(wrongKind("symbol", target, "code_callers", "a definition", hint));
  switch (target.kind) {
    case "file":
      return refuse("code_deps with direction in lists a file's importers");
    case "repo":
    case "directory":
      return refuse("code_overview describes repos and components");
    case "external":
      return refuse("code_references lists a library's importers");
    case "definition":
      break;
  }
  const ix = storeIndex(store);
  const wanted = new Set<Label>(args.labels);
  const found = walk(store, ix, target.defId, args, wanted);
  const callers = found.map((caller) => callerOf(store, ix, caller, q));
  return ok({
    id: ix.idOfDef(target.defId),
    builtCommit: q.builtCommit,
    stale: q.stale,
    labels: CALL_LABELS.filter((label) => wanted.has(label)),
    scope: args.scope,
    depth: args.depth,
    counts: countsOf(callers),
    callers,
    blindSpots: blindSpots(store, fileAt(ix, target.fileId).lang, {
      labels: args.labels,
    }),
    view: viewOf(target.ref),
  });
}

// The callers up to args.depth hops away, in the answer's order: by hop, production before
// tests, then by rank, path and the caller's start line.
function walk(
  store: Store,
  ix: StoreIndex,
  targetId: number,
  args: Checked<"code_callers">,
  wanted: ReadonlySet<Label>,
): Found[] {
  const opts = { unscoped: wanted.has("unscoped"), scope: args.scope };
  const seen = new Set([targetId]);
  const out: Found[] = [];
  let frontier: { defId: number; path: LinkLabel }[] = [
    { defId: targetId, path: "bound" },
  ];
  for (let hop = 1; hop <= args.depth && frontier.length > 0; hop++) {
    const found = new Map<number, Found>();
    for (const from of frontier) {
      for (const link of callersOf(store, from.defId, opts)) {
        if (seen.has(link.callerDefId)) continue;
        const def = defAt(ix, link.callerDefId);
        const file = fileAt(ix, def.fileId);
        if (file.test && !args.include_tests) continue;
        const label = weakest(link.label, from.path);
        if (!wanted.has(label)) continue;
        let caller = found.get(def.id);
        if (caller === undefined) {
          caller = { def, file, hop, sites: new Map(), path: label };
          found.set(def.id, caller);
        }
        // a site linked to two definitions of this hop is one site, with its strongest label
        const prior = caller.sites.get(link.siteId);
        if (
          prior === undefined ||
          strongest(prior.label, label) !== prior.label
        ) {
          caller.sites.set(link.siteId, {
            line: link.line,
            col: link.col,
            label,
            collision: link.collision,
            fileId: link.fileId,
          });
        }
        caller.path = strongest(caller.path, label);
      }
    }
    const next: { defId: number; path: LinkLabel }[] = [];
    for (const caller of found.values()) {
      seen.add(caller.def.id);
      out.push(caller);
      if (caller.def.kind !== "module" && !caller.file.test) {
        next.push({ defId: caller.def.id, path: caller.path });
      }
    }
    frontier = next;
  }
  return out.sort(
    (a, b) =>
      a.hop - b.hop ||
      Number(a.file.test) - Number(b.file.test) ||
      ix.compareFiles(a.file, b.file) ||
      a.def.startLine - b.def.startLine ||
      a.def.id - b.def.id,
  );
}

// A caller as the answer lists it, its sites by line, then col.
function callerOf(
  store: Store,
  ix: StoreIndex,
  caller: Found,
  q: QueryCtx,
): Caller {
  const sites = [...caller.sites]
    .sort(([ida, a], [idb, b]) => a.line - b.line || a.col - b.col || ida - idb)
    .map(([, site]) => {
      const out: Site = { line: site.line, col: site.col, label: site.label };
      if (site.collision) out.collision = true;
      const text = locationText(store, q, site.fileId, site.line);
      if (text !== undefined) out.text = text;
      return out;
    });
  return {
    id: ix.idOfDef(caller.def.id),
    file: ix.idOfFile(caller.file.id),
    test: caller.file.test,
    hop: caller.hop,
    sites,
  };
}

function countsOf(callers: readonly Caller[]): CallersAnswer["counts"] {
  const counts = {
    files: new Set(callers.map((caller) => caller.file)).size,
    callers: callers.length,
    sites: 0,
    bound: 0,
    scoped: 0,
    unscoped: 0,
  };
  for (const caller of callers) {
    for (const site of caller.sites) {
      counts.sites += 1;
      if (site.label === "bound") counts.bound += 1;
      else if (site.label === "scoped") counts.scoped += 1;
      else if (site.label === "unscoped") counts.unscoped += 1;
    }
  }
  return counts;
}

function defAt(ix: StoreIndex, defId: number): DefInfo {
  const def = ix.defs.get(defId);
  if (def === undefined) {
    throw new RangeError(`the store has no definition ${defId}`);
  }
  return def;
}

function fileAt(ix: StoreIndex, fileId: number): FileInfo {
  const file = ix.files.get(fileId);
  if (file === undefined)
    throw new RangeError(`the store has no file ${fileId}`);
  return file;
}
