// The model's shared types. This file is part of the codec the viewer bundles, so it
// imports no node: module.

export type RepoId = string; // REPO_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
export type Id = string; // a stable ID
export type Detail = "quick" | "standard" | "deep";
export type Stale = boolean | "unknown";
export type Ecosystem = "npm" | "pypi" | "node" | "python";
export type FileKind =
  | "code"
  | "test"
  | "test-support"
  | "config"
  | "doc"
  | "other";
// "typescript" (.ts .tsx .mts .cts), "javascript" (.js .jsx .mjs .cjs), "python" (.py .pyi),
// "shell" (.sh .bash); other code languages by LANG_BY_EXT
export type Lang = string;
export type GitMode = "100644" | "100755" | "120000" | "160000";
export type Label = "bound" | "scoped" | "unscoped" | "reference";
export type DefKind = "function" | "class" | "method" | "constant" | "type";
export type ImportKind =
  | "static"
  | "dynamic"
  | "type-only"
  | "re-export"
  | "require"
  | "side-effect"
  | "source"
  | "exec";
export type RefRole = "read" | "write" | "type" | "import" | "other";
export type Severity = "error" | "warn" | "info";
export type EntryKind =
  | "bin"
  | "script"
  | "dev-script"
  | "unit"
  | "console-script"
  | "container"
  | "procfile"
  | "ci"
  | "plugin"
  | "executable"
  | "main-guard"
  | "route";
export type EngineName =
  | "scip-typescript"
  | "dependency-cruiser"
  | "grimp"
  | "ast-grep"
  | "scip-python";
export type Producer = EngineName | "hakutaku-resolver" | "hakutaku";
export const MODULE_QUALNAME = "<module>";

// A Python file under an import root that claims a module name another file holds: a file of an
// earlier root, or, within one root, a package's __init__.py over a module of the same name.
export interface ShadowedModule {
  path: string;
  name: string; // the dotted name it would give
  heldBy: string; // the file that holds that name
  by: "root" | "package";
}

export type NodeRef =
  | { kind: "repo"; repo: RepoId }
  // a component; path ends with "/". The root component's path is "./".
  | { kind: "directory"; repo: RepoId; path: string }
  | { kind: "file"; repo: RepoId; path: string }
  // ordinal 1 writes no "(n)"
  | {
      kind: "definition";
      repo: RepoId;
      path: string;
      qualname: string;
      ordinal: number;
    }
  | { kind: "external"; repo: RepoId; ecosystem: Ecosystem; name: string };
