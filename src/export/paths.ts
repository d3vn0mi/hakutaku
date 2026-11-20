// The export's rules for tree paths (§9.2): which paths are refused, which files are the
// engines' own configs, and the repo id a checkout's folder name gives.
import { basename, resolve } from "node:path";
import { matchGlob } from "../model/index.js";

// "dotgit" is an addition to interfaces section 3.6's three reasons.
export type RefuseReason = "dotdot" | "absolute" | "control-char" | "dotgit";

// A path that would leave snapshot/, start at the file system's root, hold a C0 control
// character or DEL, or hold a .git component. git refuses such names in its index, but a
// crafted tree can hold them. The first that applies, in this order.
export function refuseReason(path: string): RefuseReason | null {
  const components = path.split("/");
  if (components.includes("..")) return "dotdot";
  if (path.startsWith("/")) return "absolute";
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return "control-char";
  }
  if (components.some(isDotGit)) return "dotgit";
  return null;
}

// A component a file system can take for .git: in any case, or with a code point HFS+
// ignores inside it, as git's own check on checkout. A git directory written into the
// snapshot would be found by any git run inside it, and its config can name commands.
const HFS_IGNORED = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;
const isDotGit = (component: string): boolean =>
  component.replace(HFS_IGNORED, "").toLowerCase() === ".git";

// The engines' own configs (§9.2), as globs over a base name, at any depth. Each is removed at
// export: hakutaku generates every engine's config and passes it explicitly.
export const ENGINE_CONFIG_FILES: readonly string[] = Object.freeze([
  ".dependency-cruiser.*",
  "sgconfig.yml",
  "pyrightconfig.json",
  ".babelrc*",
  "babel.config.*",
  "webpack.config.*",
]);

export function isEngineConfig(path: string): boolean {
  return ENGINE_CONFIG_FILES.some((glob) => matchGlob(glob, path));
}

// The default repo id (interfaces section 3.6): the checkout's top-level folder name, lower-
// cased, with each run of characters outside [a-z0-9._-] replaced by "-", cut to 64 characters.
// The answer can still fail REPO_ID_RE ("_sky", ""), which the caller checks.
export function defaultRepoId(repo: string): string {
  return basename(resolve(repo))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .slice(0, 64);
}
