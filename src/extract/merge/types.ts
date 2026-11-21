// What the merge reads: the export's manifest, profile and rules, the build's options, the
// snapshot's bytes, and each engine's facts, null for an engine that did not run.
import type { ExportManifest } from "../../export/index.js";
import type { Detail } from "../../model/index.js";
import type { Profile, Rules } from "../../profile/index.js";
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
