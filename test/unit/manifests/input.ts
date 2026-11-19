// The ManifestInput the manifest tests share: every file given is tracked, with mode 100644
// unless `modes` names another, and a null text stands for a metadata-only file. isTest and
// pythonModules are derived as an extract derives them: classifyFile's test kind, and
// pythonModuleIndex over the profile's Python roots and single-file modules.
import { classifyFile } from "../../../src/extract/classify.js";
import {
  type ManifestInput,
  pythonModuleIndex,
} from "../../../src/manifests/index.js";
import type { GitMode } from "../../../src/model/index.js";
import { DEFAULT_PROFILE, type Profile } from "../../../src/profile/index.js";

const encoder = new TextEncoder();

// The sample's Python layout: one import root, sim/src.
export const SIM: Partial<Profile> = {
  python: { roots: ["sim/src"], singleFileModules: [] },
};

export function input(
  files: Record<string, string | null>,
  options: { modes?: Record<string, GitMode>; profile?: Partial<Profile> } = {},
): ManifestInput {
  const profile: Profile = { ...DEFAULT_PROFILE, ...options.profile };
  const paths = new Set(Object.keys(files));
  const text = (path: string): string | null =>
    Object.hasOwn(files, path) ? (files[path] ?? null) : null;
  return {
    paths,
    modes: new Map(
      [...paths].map((path) => [path, options.modes?.[path] ?? "100644"]),
    ),
    read: text,
    profile,
    isTest: (path) =>
      classifyFile(path, encoder.encode(text(path) ?? ""), profile).kind ===
      "test",
    pythonModules: pythonModuleIndex(
      paths,
      profile.python.roots,
      profile.python.singleFileModules,
    ),
  };
}
