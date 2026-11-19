// The layout profile (§8.3) and the rules file.
import type { Severity } from "../model/index.js";

export interface Profile {
  schema: 1;
  components: string[]; // component roots (globs); [] = automatic
  typescript: { aliases: Record<string, string[]>; tsconfigs: string[] };
  python: { roots: string[]; singleFileModules: string[] };
  tests: { extraPatterns: string[] };
  launchManifests: Array<{ glob: string; pointer: string; kind: "plugin" }>; // pointer: a JSON Pointer into each match
  denylist: { extra: string[] };
  gates: { maxUnresolvedRelativeImports: number }; // 0.005
  rules: string | null; // the rules file, relative to the profile file; null for none
}

export interface Rules {
  schema: 1;
  cycles?: { severity: Severity }; // "warn" when absent
  forbidden?: Array<{
    name: string;
    severity: Severity;
    comment?: string;
    from: { path: string };
    to: { path: string };
  }>; // path: JS RegExp source over repo paths
  layers?: Array<{
    name: string;
    severity: Severity;
    containers?: string[];
    layers: string[];
  }>; // Python modules, top first
}
