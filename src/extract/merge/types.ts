// What the merge reads: the export's manifest, profile and rules, the build's options, the
// snapshot's bytes, and each engine's facts, null for an engine that did not run. And what it
// gives: the content tables but the metrics', and the counts beside them.
import type { ExportManifest } from "../../export/index.js";
import type { Detail, Lang } from "../../model/index.js";
import type { Profile, Rules } from "../../profile/index.js";
import type { StoreContent } from "../../store/index.js";
import type { AstGrepFacts } from "../drivers/ast-grep.js";
import type { DepcruiseFacts } from "../drivers/depcruise.js";
import type { GrimpFacts } from "../drivers/grimp.js";
import type { ScipFacts } from "../scip/facts.js";

export interface MergeInput {
  manifest: ExportManifest;
  profile: Profile;
  rules: Rules | null;
  detail: Detail;
  noSource: boolean;
  // a regular file's bytes in the snapshot; links and submodules have none
  readSnapshot(path: string): Uint8Array;
  astGrep: AstGrepFacts | null;
  depcruise: DepcruiseFacts | null;
  scip: ScipFacts | null;
  grimp: GrimpFacts | null;
  pythonResolver: "grimp" | "hakutaku-resolver" | "none";
}

// Every content table but those the metrics fill (file_metrics, def_metrics, cochange, cycles,
// timeline and renames), and neither meta nor run.
export type MergedContent = Omit<
  StoreContent,
  | "meta"
  | "run"
  | "file_metrics"
  | "def_metrics"
  | "cochange"
  | "cycles"
  | "timeline"
  | "renames"
>;

// The counts beside the merged rows, which coverage, the gates and build.json read.
export interface MergeSide {
  // relative specifiers, and those of them left unresolved
  relative: { total: number; unresolved: number };
  // per language, the files its import engine covered
  indexed: Map<Lang, Set<string>>;
  // the symbols two or more SCIP documents define as their own
  scipDuplicates: string[];
  // redactText's count over every stored text: sources, signatures, receivers, specifiers,
  // entry names, external names and link targets
  redactions: number;
  computedImports: number;
  unmatchedScipDefinitions: number;
  unmatchedBoundUses: number;
  warnings: string[];
}
