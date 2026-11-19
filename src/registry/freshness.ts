// computeFreshness: the stale rules (§5.9) as one pure function, shared by every reader of a
// repo's freshness. The first rule that applies wins:
//   1. the last attempt failed, or failed its gates: true, with that attempt's result and reason;
//   2. the head cannot be read: "unknown", with the ref reader's reason;
//   3. nothing is built: true;
//   4. the head is not the built commit: true, with the head's first 12 hex;
//   5. otherwise false, with no reason.
// headCommit is the full head whenever it was read, and null otherwise.
import type { Stale } from "../model/index.js";
import type { Attempt } from "../store/index.js";
import type { RefResult } from "./types.js";

export function computeFreshness(
  builtCommit: string | null,
  head: RefResult,
  attempt: Attempt | null,
): { headCommit: string | null; stale: Stale; reason?: string } {
  const headCommit = head.commit;
  if (attempt?.result === "failed" || attempt?.result === "gates-failed") {
    const reason =
      attempt.reason === undefined
        ? `last build ${attempt.result}`
        : `last build ${attempt.result}: ${attempt.reason}`;
    return { headCommit, stale: true, reason };
  }
  if (head.commit === null) {
    return { headCommit: null, stale: "unknown", reason: head.reason };
  }
  if (builtCommit === null) {
    return { headCommit, stale: true, reason: "not built yet" };
  }
  if (head.commit !== builtCommit) {
    return {
      headCommit,
      stale: true,
      reason: `ref moved to ${head.commit.slice(0, 12)}`,
    };
  }
  return { headCommit, stale: false };
}
