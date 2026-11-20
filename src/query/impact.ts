// code_impact: what a change to a file or a definition can reach, hop by hop (docs/tools.md).
// From a file, each hop follows the importers of the previous hop's production files. From a
// definition, each hop follows the stored callers and the referrers of the previous hop's
// definitions, and a hop is only as strong as its weakest link. Every node is listed once, at
// its first hop; tests are listed and never followed. The walks are iterative, with seen sets,
// so a deep or cyclic graph neither recurses nor loops.
import { comparePaths } from "../model/index.js";
import type { Store } from "../store/index.js";
import type { Checked, ImpactAnswer } from "../tools/types.js";
import {
  callersOf,
  type LinkLabel,
  referrersOf,
  strongest,
  weakest,
} from "./calls.js";
import { fail, ok, type QueryCtx, type QueryOut } from "./ctx.js";
import { resolveTarget, wrongKind } from "./resolve.js";
import {
  type DefInfo,
  type FileInfo,
  type StoreIndex,
  storeIndex,
} from "./store-index.js";
import { blindSpots } from "./tiers.js";

type Hop = ImpactAnswer["byHop"][number];

// The stored links only: code_impact takes no unscoped matches and no transitive scope.
const STORED = Object.freeze({ unscoped: false, scope: "direct" } as const);

// A definition reached at a hop, with the strongest label among the paths that reach it there.
interface Reached {
  def: DefInfo;
  file: FileInfo;
  label: LinkLabel;
}

export function queryImpact(
  store: Store,
  args: Checked<"code_impact">,
  q: QueryCtx,
): QueryOut<ImpactAnswer> {
  const target = resolveTarget(store, q.repo, args.target, "target");
  if ("code" in target) return fail(target);
  const refuse = (hint: string) =>
    fail(
      wrongKind(
        "target",
        target,
        "code_impact",
        "a file or a definition",
        hint,
      ),
    );
  const ix = storeIndex(store);
  let id: string;
  let byHop: Hop[];
  let opts: { fileTarget?: boolean };
  switch (target.kind) {
    case "repo":
    case "directory":
      return refuse("code_overview describes repos and components");
    case "external":
      return refuse("code_references lists a library's importers");
    case "file":
      id = ix.idOfFile(target.fileId);
      byHop = fromFile(ix, target.fileId, args);
      opts = { fileTarget: true };
      break;
    case "definition":
      id = ix.idOfDef(target.defId);
      byHop = fromDefinition(store, ix, target.defId, target.fileId, args);
      opts = {};
      break;
  }
  const counts = { definitions: 0, files: 0, tests: 0 };
  for (const hop of byHop) {
    counts.definitions += hop.definitions.length;
    counts.files += hop.files.length;
    counts.tests += hop.tests.length;
  }
  return ok({
    id,
    builtCommit: q.builtCommit,
    stale: q.stale,
    depth: args.depth,
    byHop,
    counts,
    blindSpots: blindSpots(store, fileAt(ix, target.fileId).lang, opts),
  });
}

// From a file: each hop lists the importers not seen before, tests apart, and goes on from the
// production files among them. The target file counts as seen.
function fromFile(
  ix: StoreIndex,
  targetId: number,
  args: Checked<"code_impact">,
): Hop[] {
  const seen = new Set([targetId]);
  const byHop: Hop[] = [];
  let frontier = [targetId];
  for (let hop = 1; hop <= args.depth && frontier.length > 0; hop++) {
    const files: FileInfo[] = [];
    const tests: FileInfo[] = [];
    for (const fileId of frontier) {
      for (const edge of ix.importsIn.get(fileId) ?? []) {
        if (seen.has(edge.src)) continue;
        const file = fileAt(ix, edge.src);
        if (file.test && !args.include_tests) continue;
        seen.add(file.id);
        (file.test ? tests : files).push(file);
      }
    }
    if (files.length === 0 && tests.length === 0) break;
    byHop.push(hopOf(ix, hop, [], files, tests));
    frontier = files.filter((file) => file.production).map((file) => file.id);
  }
  return byHop;
}

// From a definition: each hop takes the stored bound and scoped links and the referrers of the
// previous hop's definitions. A caller in a test file only lists its file among the tests; any
// other goes to the definitions, with its best path label, and its file, when first reached,
// to the files. A <module> row is listed but not followed. The target and its file count as
// seen.
function fromDefinition(
  store: Store,
  ix: StoreIndex,
  targetId: number,
  targetFileId: number,
  args: Checked<"code_impact">,
): Hop[] {
  const seenDefs = new Set([targetId]);
  const seenFiles = new Set([targetFileId]);
  const byHop: Hop[] = [];
  let frontier: { defId: number; path: LinkLabel }[] = [
    { defId: targetId, path: "bound" },
  ];
  for (let hop = 1; hop <= args.depth && frontier.length > 0; hop++) {
    const found = new Map<number, Reached>();
    const tests = new Map<number, FileInfo>();
    const reach = (callerDefId: number, link: LinkLabel, path: LinkLabel) => {
      if (seenDefs.has(callerDefId)) return;
      const def = defAt(ix, callerDefId);
      const file = fileAt(ix, def.fileId);
      if (file.test) {
        if (args.include_tests && !seenFiles.has(file.id)) {
          tests.set(file.id, file);
        }
        return;
      }
      const label = weakest(link, path);
      const prior = found.get(def.id);
      if (prior === undefined) found.set(def.id, { def, file, label });
      else prior.label = strongest(prior.label, label);
    };
    for (const from of frontier) {
      for (const link of callersOf(store, from.defId, STORED)) {
        reach(link.callerDefId, link.label, from.path);
      }
      for (const use of referrersOf(store, from.defId)) {
        reach(use.callerDefId, "reference", from.path);
      }
    }
    if (found.size === 0 && tests.size === 0) break;
    const reached = [...found.values()].sort(
      (a, b) =>
        ix.compareFiles(a.file, b.file) ||
        a.def.startLine - b.def.startLine ||
        a.def.id - b.def.id,
    );
    const files: FileInfo[] = [];
    for (const { def, file } of reached) {
      seenDefs.add(def.id);
      if (seenFiles.has(file.id)) continue;
      seenFiles.add(file.id);
      files.push(file);
    }
    for (const fileId of tests.keys()) seenFiles.add(fileId);
    byHop.push(hopOf(ix, hop, reached, files, [...tests.values()]));
    frontier = reached
      .filter(({ def }) => def.kind !== "module")
      .map(({ def, label }) => ({ defId: def.id, path: label }));
  }
  return byHop;
}

// One hop of the answer: definitions and files by rank, then path (and a definition by line),
// and tests by path.
function hopOf(
  ix: StoreIndex,
  hop: number,
  reached: readonly Reached[],
  files: FileInfo[],
  tests: FileInfo[],
): Hop {
  return {
    hop,
    definitions: reached.map(({ def, label }) => ({
      id: ix.idOfDef(def.id),
      label,
    })),
    files: files.sort(ix.compareFiles).map((file) => ix.idOfFile(file.id)),
    tests: tests
      .sort((a, b) => comparePaths(a.path, b.path))
      .map((file) => ix.idOfFile(file.id)),
  };
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
