// code_repos: every repo this caller may ask about, with how fresh and how complete its store is.
import { fileLanguages } from "../query/index.js";
import type { Store } from "../store/index.js";
import type { CallContext, Host, HostError, RepoEntry } from "./host.js";
import type { ReposAnswer } from "./types.js";

type RepoInfo = ReposAnswer["repos"][number];

// A commit as answers write it: its first 12 hex characters.
export function shortCommit(commit: string): string {
  return commit.slice(0, 12);
}

// A store the host opened, or undefined for a HostError: a repo that is not built, or one the
// host lists but will not open, which code_repos shows as not built.
export function builtStore(opened: Store | HostError): Store | undefined {
  return "code" in opened ? undefined : opened;
}

// For each entry of host.repos(ctx), in order: host.open, then host.freshness, then
// host.snippets. Every map in the answer is a copy, never the store's own.
export function reposAnswer(host: Host, ctx: CallContext): ReposAnswer {
  return {
    repos: host.repos(ctx).map((entry) => repoInfo(host, ctx, entry)),
  };
}

function repoInfo(host: Host, ctx: CallContext, entry: RepoEntry): RepoInfo {
  const store = builtStore(host.open(ctx, entry.id));
  const fresh = host.freshness(entry.id);
  const snippets = host.snippets(entry.id);
  const coverage = store?.meta.coverage;
  return {
    id: entry.id,
    ref: entry.ref,
    builtCommit: store === undefined ? null : shortCommit(store.meta.commit),
    headCommit:
      fresh.headCommit === null ? null : shortCommit(fresh.headCommit),
    stale: fresh.stale,
    ...(fresh.reason === undefined ? {} : { staleReason: fresh.reason }),
    builtAt: store === undefined ? null : store.run.builtAt,
    // The detail the store was built at; the entry's own only when there is no store.
    detail: store === undefined ? entry.detail : store.meta.detail,
    snippets,
    // every code, test and test-support file, where coverage.indexed counts only those an
    // import engine read
    languages: store === undefined ? {} : fileLanguages(store),
    coverage: {
      files: coverage?.files ?? 0,
      indexed: { ...coverage?.indexed },
      unresolvedImports: coverage?.unresolvedImports ?? 0,
      callSites: {
        bound: coverage?.callSites.bound ?? 0,
        scoped: coverage?.callSites.scoped ?? 0,
        unresolved: coverage?.callSites.unresolved ?? 0,
      },
      redactions: coverage?.redactions ?? 0,
    },
    engines: { ...store?.meta.engines },
  };
}
