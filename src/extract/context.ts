// What a build hands each engine driver, and the shape every driver has.
import type { ExportManifest } from "../export/index.js";
import type { Detail, EngineName } from "../model/index.js";
import type { Profile, Rules } from "../profile/index.js";
import type { EngineRun, EngineRunResult } from "./run.js";

export interface ExtractContext {
  exportDir: string;
  snapshotDir: string;
  workDir: string;
  enginesDir: string;
  detail: Detail;
  noSource: boolean;
  profile: Profile;
  rules: Rules | null;
  manifest: ExportManifest;
  pythonPath: string | null; // from installed.json; null without Python
  // The build's memory cap, systemd's MemoryMax such as "3G", which the sandbox applies;
  // scip-typescript takes 80% of it as Node's heap. 3G when absent.
  memoryMax?: string;
  // Whether the sandbox this build runs in does apply memoryMax: only then can an engine's
  // failure be put down to the cap. False when absent.
  memoryCapped?: boolean;
  // The store's directory, which holds workDir, and the user's home directory, which a
  // failure's text names as <store> and ~; this process's home when absent, none when null.
  storeDir?: string;
  home?: string | null;
  // Every engine's timeout, in place of its detail's, as a test's short one.
  timeoutMs?: number;
  log(line: string): void;
  // How each engine is run: runEngine, which a build wraps to learn when each engine starts and
  // how its run ended, even when the driver then throws. runEngine itself when absent.
  runner?: (run: EngineRun) => Promise<EngineRunResult>;
}

export interface EngineDriver<Out> {
  name: EngineName;
  minDetail: Detail;
  applies(ctx: ExtractContext): boolean;
  run(ctx: ExtractContext): Promise<Out>; // raw outputs stay under ctx.workDir and are deleted after parsing
}
