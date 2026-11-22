// A Host over one store path, for the viewer's tests. Each repo it serves (["tiny"] unless given)
// opens the store at that path through a store cache, on every call, so a store swapped into
// place, as an extract swaps in a rebuilt one, is reopened. The head is never known: freshness
// gives a null head and the staleness the test sets. A plain object of closures, so a test can
// spread it and replace one member. It offers no refresh.
import type { RepoId, Stale } from "../../../src/model/index.js";
import { createStoreCache } from "../../../src/store/index.js";
import {
  DEFAULT_MAX_RESULT_CHARS,
  type Host,
} from "../../../src/tools/index.js";

export function tinyHost(
  storePath: string,
  opts: { repos?: RepoId[]; snippets?: boolean; stale?: Stale } = {},
): Host {
  const repos = opts.repos ?? ["tiny"];
  const stores = createStoreCache();
  return {
    // The detail of the store when it is built, and "standard" when it is not.
    repos: () => {
      const store = stores.get(storePath);
      const detail = "code" in store ? "standard" : store.meta.detail;
      return repos.map((id) => ({ id, ref: "HEAD", detail }));
    },
    open: (_ctx, repo) =>
      repos.includes(repo) ? stores.get(storePath) : { code: "unknown_repo" },
    freshness: () => ({ headCommit: null, stale: opts.stale ?? false }),
    snippets: () => opts.snippets ?? true,
    maxResultChars: DEFAULT_MAX_RESULT_CHARS,
  };
}
