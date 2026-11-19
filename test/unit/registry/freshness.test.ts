import { expect, it } from "vitest";
import {
  computeFreshness,
  type RefResult,
} from "../../../src/registry/index.js";
import type { Attempt } from "../../../src/store/index.js";

const A = "a".repeat(40),
  B = "b".repeat(40);
const att = (result: Attempt["result"], reason?: string): Attempt => ({
  at: "2026-01-01T00:00:00Z",
  commit: A,
  result,
  reason,
});
const REFTABLE = "reftable ref storage is not read";

it.each<
  [
    string | null,
    RefResult,
    Attempt | null,
    ReturnType<typeof computeFreshness>,
  ]
>([
  [A, { commit: A }, att("built"), { headCommit: A, stale: false }],
  [
    A,
    { commit: B },
    att("built"),
    { headCommit: B, stale: true, reason: "ref moved to bbbbbbbbbbbb" },
  ],
  [
    A,
    { commit: null, reason: REFTABLE },
    null,
    { headCommit: null, stale: "unknown", reason: REFTABLE },
  ],
  [
    A,
    { commit: A },
    att("gates-failed", "denylist: 1 denylisted path: sim/.env"),
    {
      headCommit: A,
      stale: true,
      reason: "last build gates-failed: denylist: 1 denylisted path: sim/.env",
    },
  ],
  [
    null,
    { commit: A },
    null,
    { headCommit: A, stale: true, reason: "not built yet" },
  ],
  // rule 1, a failed build, with and without its reason, and before an unreadable head
  [
    A,
    { commit: A },
    att("failed", "ast-grep exited 2"),
    {
      headCommit: A,
      stale: true,
      reason: "last build failed: ast-grep exited 2",
    },
  ],
  [
    A,
    { commit: A },
    att("failed"),
    { headCommit: A, stale: true, reason: "last build failed" },
  ],
  [
    A,
    { commit: null, reason: REFTABLE },
    att("failed", "ast-grep exited 2"),
    {
      headCommit: null,
      stale: true,
      reason: "last build failed: ast-grep exited 2",
    },
  ],
  // rule 2 before rule 3, rule 3 before rule 4, and a skipped build is no failure
  [
    null,
    { commit: null, reason: REFTABLE },
    null,
    { headCommit: null, stale: "unknown", reason: REFTABLE },
  ],
  [
    null,
    { commit: B },
    att("built"),
    { headCommit: B, stale: true, reason: "not built yet" },
  ],
  [
    A,
    { commit: B },
    att("skipped"),
    { headCommit: B, stale: true, reason: "ref moved to bbbbbbbbbbbb" },
  ],
  [A, { commit: A }, att("skipped"), { headCommit: A, stale: false }],
])("computeFreshness(%s, %j, %j)", (built, head, attempt, want) =>
  expect(computeFreshness(built, head, attempt)).toStrictEqual(want),
);
