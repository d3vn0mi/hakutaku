import { afterEach, expect, it, vi } from "vitest";
import {
  computeFreshness,
  type RefResult,
} from "../../../src/registry/index.js";
import type { Attempt, NotBuilt } from "../../../src/store/index.js";

const A = "a".repeat(40),
  B = "b".repeat(40);
const att = (result: Attempt["result"], reason?: string): Attempt => ({
  at: "2026-01-01T00:00:00Z",
  commit: A,
  result,
  reason,
});
const notBuilt = (reason: string): NotBuilt => ({ code: "not_built", reason });
const NONE = notBuilt("not built yet");
const REFTABLE = "reftable ref storage is not read";
const UNREAD: RefResult = { commit: null, reason: REFTABLE };

it.each<
  [
    string | NotBuilt,
    RefResult,
    Attempt | null,
    string,
    ReturnType<typeof computeFreshness>,
  ]
>([
  [A, { commit: A }, att("built"), "main", { headCommit: A, stale: false }],
  [
    A,
    { commit: B },
    att("built"),
    "main",
    {
      headCommit: B,
      stale: true,
      reason: "main is at bbbbbbbbbbbb, the store at aaaaaaaaaaaa",
    },
  ],
  [
    A,
    UNREAD,
    null,
    "main",
    { headCommit: null, stale: "unknown", reason: REFTABLE },
  ],
  [
    A,
    { commit: A },
    att("gates-failed", "denylist: 1 denylisted path: sim/.env"),
    "main",
    {
      headCommit: A,
      stale: true,
      reason:
        "the last build failed its gates: denylist: 1 denylisted path: sim/.env",
    },
  ],
  [
    NONE,
    { commit: A },
    null,
    "main",
    { headCommit: A, stale: true, reason: "not built: not built yet" },
  ],
  // a failed build, with and without its reason, and a failed attempt before an unreadable head
  [
    A,
    { commit: A },
    att("failed", "ast-grep exited 2"),
    "main",
    {
      headCommit: A,
      stale: true,
      reason: "the last build failed: ast-grep exited 2",
    },
  ],
  [
    A,
    { commit: A },
    att("failed"),
    "main",
    { headCommit: A, stale: true, reason: "the last build failed" },
  ],
  [
    A,
    { commit: B },
    att("gates-failed"),
    "main",
    { headCommit: B, stale: true, reason: "the last build failed its gates" },
  ],
  [
    A,
    UNREAD,
    att("failed", "ast-grep exited 2"),
    "main",
    {
      headCommit: null,
      stale: true,
      reason: "the last build failed: ast-grep exited 2",
    },
  ],
  // a failed attempt before a store that is not built: a first build whose gates failed leaves
  // an entry and no store, and a build still running reads as failed until it ends
  [
    NONE,
    { commit: A },
    att("gates-failed", "unresolved imports grew"),
    "main",
    {
      headCommit: A,
      stale: true,
      reason: "the last build failed its gates: unresolved imports grew",
    },
  ],
  [
    NONE,
    UNREAD,
    att("failed", "interrupted or still running (pid 7): running ast-grep"),
    "main",
    {
      headCommit: null,
      stale: true,
      reason:
        "the last build failed: interrupted or still running (pid 7): running ast-grep",
    },
  ],
  // a store that is not built, before an unreadable head, with the store's own reason
  [
    NONE,
    UNREAD,
    null,
    "main",
    { headCommit: null, stale: true, reason: "not built: not built yet" },
  ],
  [
    notBuilt("store unreadable"),
    { commit: B },
    att("built"),
    "main",
    { headCommit: B, stale: true, reason: "not built: store unreadable" },
  ],
  // a skipped build is no failure, and the reason names the ref as the entry gives it
  [
    A,
    { commit: B },
    att("skipped"),
    "origin/main",
    {
      headCommit: B,
      stale: true,
      reason: "origin/main is at bbbbbbbbbbbb, the store at aaaaaaaaaaaa",
    },
  ],
  [A, { commit: A }, att("skipped"), "HEAD", { headCommit: A, stale: false }],
])("computeFreshness(%j, %j, %j, %s)", (built, head, attempt, ref, want) =>
  expect(computeFreshness(built, head, attempt, ref)).toStrictEqual(want),
);

afterEach(() => {
  vi.unstubAllEnvs();
});

it("cleans the reason it reads: the home directory as ~, and secrets redacted", () => {
  vi.stubEnv("HOME", "/srv/astronomer");
  // assembled here, never written whole
  const secret = ["gh", "p_", "Q7x2M4p9K3l8N5r6".repeat(3)].join("");
  expect(
    computeFreshness(
      A,
      { commit: A },
      att(
        "failed",
        `grimp failed: exit code 3\nat /srv/astronomer/sky.py: token=${secret}`,
      ),
      "main",
    ).reason,
  ).toBe(
    "the last build failed: grimp failed: exit code 3\nat ~/sky.py: token=«redacted:github-token»",
  );
});
