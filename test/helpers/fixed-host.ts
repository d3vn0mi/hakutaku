// A Host over fixed stores, for tests that go through runTool. Each key of stores is a repo id,
// in key order, and each store path is opened once. A plain object of closures, so a test can
// spread it and replace one member.
import type { RepoId, Stale } from "../../src/model/index.js";
import { type NotBuilt, openStore, type Store } from "../../src/store/index.js";
import {
  DEFAULT_MAX_RESULT_CHARS,
  type Host,
  type HostError,
} from "../../src/tools/index.js";

export interface FixedHostOptions {
  maxResultChars?: number; // DEFAULT_MAX_RESULT_CHARS
  snippets?: boolean; // true
  ref?: string; // "HEAD"
  stale?: Stale; // false
  refresh?: Host["refresh"]; // none: code_refresh answers refresh_disabled
}

export function fixedHost(
  stores: Record<RepoId, string>,
  opts: FixedHostOptions = {},
): Host {
  const opened = new Map<string, Store | NotBuilt>();
  // The repo's store, opened once per path; a key not in stores is unknown_repo.
  const storeOf = (repo: string): Store | HostError => {
    if (!Object.hasOwn(stores, repo)) return { code: "unknown_repo" };
    const path = stores[repo] ?? "";
    let store = opened.get(path);
    if (store === undefined) {
      store = openStore(path);
      opened.set(path, store);
    }
    return store;
  };
  const host: Host = {
    // The detail of each built store, and "standard" for one that is not built.
    repos: () =>
      Object.keys(stores).map((id) => {
        const store = storeOf(id);
        return {
          id,
          ref: opts.ref ?? "HEAD",
          detail: "code" in store ? "standard" : store.meta.detail,
        };
      }),
    open: (_ctx, repo) => storeOf(repo),
    // The head is the store's own commit, null when it is not built.
    freshness: (repo) => {
      const store = storeOf(repo);
      return {
        headCommit: "code" in store ? null : store.meta.commit,
        stale: opts.stale ?? false,
      };
    },
    snippets: () => opts.snippets ?? true,
    maxResultChars: opts.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS,
  };
  if (opts.refresh !== undefined) host.refresh = opts.refresh;
  return host;
}
