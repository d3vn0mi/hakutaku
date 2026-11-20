// The Host: what each face of hakutaku hands to runTool. It says which repos a caller may ask
// about, opens their stores, and answers for their freshness, their snippets and refreshes.
import type { Detail, RepoId, Stale } from "../model/index.js";
import type { NotBuilt, Store } from "../store/index.js";

// Opaque: runTool passes it back to the host and never reads it.
export type CallContext = unknown;

export interface RepoEntry {
  id: RepoId;
  ref: string;
  detail: Detail;
}

export type HostError = { code: "unknown_repo" } | NotBuilt;

// headCommit is the ref's full 40-hex commit, or null when it cannot be read. stale is true when
// the head differs from the built commit, or when the last attempt failed or failed its gates,
// and reason says which; "unknown" when the head cannot be read, with the reason; false
// otherwise.
export interface Freshness {
  headCommit: string | null;
  stale: Stale;
  reason?: string;
}

// The last build attempt. One that built, or was skipped, is "ok".
export interface LastAttempt {
  at: string;
  result: "ok" | "failed";
  reason?: string;
}

// retryAfterSeconds: on "rate_limited", the seconds to wait. On "queued" or "building", when the
// host sets it, the seconds until another call would queue a new build.
export interface RefreshState {
  state: "queued" | "building" | "idle" | "failed" | "rate_limited";
  lastAttempt?: LastAttempt;
  retryAfterSeconds?: number;
}

export interface Host {
  repos(ctx: CallContext): RepoEntry[]; // the repos this caller may ask about
  open(ctx: CallContext, repo: string): Store | HostError; // exact id match, never a path
  freshness(repo: string): Freshness;
  snippets(repo: string): boolean; // source lines on or off
  refresh?(repo: string): RefreshState; // absent: code_refresh answers refresh_disabled
  maxResultChars: number; // DEFAULT_MAX_RESULT_CHARS unless the host sets its own
}
