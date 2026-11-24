// A build's coverage: the counts code_repos shows, and those blindSpots and the gates read,
// from the merge, the tiers the build's engines ended in, the cycle finders' disagreement and
// the export. A call site is bound or scoped by its rows' label, and unresolved with none. The
// shadowed Python files are those the files-indexed gate leaves uncounted.
import type { Lang } from "../../model/index.js";
import { comparePaths } from "../../model/index.js";
import type { Coverage } from "../../store/index.js";
import { shadowedPython } from "../gates.js";
import { regularPaths } from "./files.js";
import type { MergedContent, MergeInput, MergeSide } from "./types.js";

export interface CoverageParts {
  input: Pick<MergeInput, "manifest" | "profile" | "rules" | "pythonResolver">;
  content: Pick<MergedContent, "files" | "call_sites" | "call_targets">;
  side: MergeSide;
  tiers: Coverage["tiers"];
  // the files exactly one of Tarjan's cycles and dependency-cruiser's holds
  cycleDifferences: number;
}

export function coverageOf(parts: CoverageParts): Coverage {
  const { input, content, side } = parts;
  // a site's rows share one label: one bound row, or scoped ones
  const labels = new Map<number, "bound" | "scoped">();
  for (const target of content.call_targets) {
    labels.set(target.site_id, target.label);
  }
  let bound = 0;
  for (const label of labels.values()) if (label === "bound") bound++;
  const scoped = labels.size - bound;
  const indexed: Record<Lang, number> = {};
  for (const lang of [...side.indexed.keys()].sort(comparePaths)) {
    indexed[lang] = side.indexed.get(lang)?.size ?? 0;
  }
  const shadowed = shadowedPython({
    files: content.files,
    regularPaths: regularPaths(input.manifest),
    metadataOnly: input.manifest.metadataOnly.map((m) => m.path),
    python: input.profile.python,
  });
  return {
    files: content.files.length,
    indexed,
    unresolvedImports: side.relative.unresolved,
    callSites: {
      bound,
      scoped,
      unresolved: content.call_sites.length - labels.size,
    },
    redactions: side.redactions,
    tiers: parts.tiers,
    pythonResolver: input.pythonResolver,
    computedImports: side.computedImports,
    unmatchedScipDefinitions: side.unmatchedScipDefinitions,
    unmatchedBoundUses: side.unmatchedBoundUses,
    cycleDifferences: parts.cycleDifferences,
    // over 1 MB, minified or generated
    noSourceFiles: input.manifest.metadataOnly.length,
    denied: input.manifest.denied,
    cycleSeverity: input.rules?.cycles?.severity ?? "warn",
    // written only when a file is shadowed
    ...(shadowed.length === 0 ? {} : { shadowedPython: shadowed }),
  };
}
