// What the launch-manifest readers read, and the facts they produce.
import type { EntryKind, GitMode } from "../model/index.js";
import type { Profile } from "../profile/index.js";

// One launch: `manifest` starts `file` at `line`. `qualname` is the definition a console script
// calls, or null; `name` is the command, script, unit or route that launches it, or the file's
// own path for the secondary signals.
export interface EntryFact {
  file: string;
  qualname: string | null;
  kind: EntryKind;
  manifest: string;
  line: number;
  name: string;
}

export interface ManifestInput {
  paths: ReadonlySet<string>;
  modes: ReadonlyMap<string, GitMode>;
  // a snapshot file's text, or null for a metadata-only or absent file
  read(path: string): string | null;
  profile: Profile;
  isTest(path: string): boolean;
  pythonModules: ReadonlyMap<string, string>;
}

// The tracked file a repo path names: the path itself, or the source sourceForBuilt maps it
// to; null for neither.
export type Named = (path: string) => string | null;

// The tracked file a word of a command or manifest names, or null.
export type Resolve = (word: string) => string | null;

// What each reader gets: the input, the built-path mapping, and the suffix match of the
// manifests whose paths are deployed ones (systemd units and Dockerfiles).
export interface ReadContext {
  input: ManifestInput;
  named: Named;
  bySuffix: Resolve;
}
