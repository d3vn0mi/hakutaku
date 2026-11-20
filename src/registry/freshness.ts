// computeFreshness: the stale rules as one pure function, shared by every reader of a repo's
// freshness (the MCP host and hakutaku list), so each words the same state the same way. The
// first rule that applies wins:
//   1. the last attempt failed its gates: true, "the last build failed its gates: <reason>";
//   2. the last attempt failed: true, "the last build failed: <reason>";
//   3. nothing usable is built: true, "not built: <why>";
//   4. the head cannot be read: "unknown", with the ref reader's reason;
//   5. the head is not the built commit: true, "<ref> is at <head 12>, the store at <built 12>";
//   6. otherwise false, with no reason.
// A failed attempt comes first, so a first build whose gates failed, which leaves no store, still
// says why. An attempt without a reason drops the ": <reason>". headCommit is the full head
// whenever it was read, and null otherwise.
import type { Stale } from "../model/index.js";
import type { Attempt, NotBuilt } from "../store/index.js";
import type { RefResult } from "./types.js";

export function computeFreshness(
  built: string | NotBuilt, // the store's commit, 40 hex, or why there is no usable store
  head: RefResult,
  attempt: Attempt | null,
  ref: string, // the ref the head was read from, as its entry names it
): { headCommit: string | null; stale: Stale; reason?: string } {
  const headCommit = head.commit;
  if (attempt?.result === "gates-failed" || attempt?.result === "failed") {
    const what =
      attempt.result === "gates-failed"
        ? "the last build failed its gates"
        : "the last build failed";
    const reason =
      attempt.reason === undefined ? what : `${what}: ${attempt.reason}`;
    return { headCommit, stale: true, reason };
  }
  if (typeof built !== "string") {
    return { headCommit, stale: true, reason: `not built: ${built.reason}` };
  }
  if (head.commit === null) {
    return { headCommit: null, stale: "unknown", reason: head.reason };
  }
  if (head.commit !== built) {
    return {
      headCommit,
      stale: true,
      reason: `${ref} is at ${head.commit.slice(0, 12)}, the store at ${built.slice(0, 12)}`,
    };
  }
  return { headCommit, stale: false };
}
