// What a build hands each engine driver, and the shape every driver has.
import type { ExportManifest } from "../export/index.js";
import type { Detail, EngineName } from "../model/index.js";
import type { Profile, Rules } from "../profile/index.js";

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
  log(line: string): void;
}

export interface EngineDriver<Out> {
  name: EngineName;
  minDetail: Detail;
  applies(ctx: ExtractContext): boolean;
  run(ctx: ExtractContext): Promise<Out>; // raw outputs stay under ctx.workDir and are deleted after parsing
}
