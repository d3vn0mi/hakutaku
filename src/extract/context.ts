// What a build hands each engine driver, and the shape every driver has (interfaces
// section 3.5).
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
  log(line: string): void;
}

export interface EngineDriver<Out> {
  name: EngineName;
  minDetail: Detail;
  applies(ctx: ExtractContext): boolean;
  run(ctx: ExtractContext): Promise<Out>; // raw outputs stay under ctx.workDir and are deleted after parsing
}
