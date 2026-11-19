// The registry's types: hakutaku's own repos, its directories, and what a ref reader answers.
import type { Detail, RepoId } from "../model/index.js";

// $XDG_DATA_HOME/hakutaku, $XDG_CONFIG_HOME/hakutaku and $XDG_CACHE_HOME/hakutaku, with the XDG
// defaults ~/.local/share, ~/.config and ~/.cache.
export interface HakutakuDirs {
  data: string;
  config: string;
  cache: string;
}

export interface RegistryEntry {
  id: RepoId;
  source: string; // absolute top level of the checkout
  ref: string;
  detail: Detail;
  noSource: boolean;
  snippets: boolean;
  profile: string; // absolute
}

// <data>/registry.json, sorted by id
export interface Registry {
  version: 1;
  repos: RegistryEntry[];
}

// The commit a ref names, read with no git process, or why it could not be read.
export type RefResult = { commit: string } | { commit: null; reason: string };
