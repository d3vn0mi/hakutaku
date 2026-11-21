// How a failed engine run is worded: how it ended first, then a cleaned excerpt of what it said.
// Secret-looking values are assembled at run time, never written whole.
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ExtractContext } from "../../../src/extract/context.js";
import {
  type EngineRunResult,
  type FailureContext,
  failureContext,
  runEnd,
  runFailure,
} from "../../../src/extract/run.js";

// A run that exited 0 within its timeout, with whatever the case changes.
const ended = (patch: Partial<EngineRunResult> = {}): EngineRunResult => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  wallMs: 10,
  cpuMs: null,
  peakRssBytes: null,
  stdout: "",
  stderrTail: "",
  stderrCut: false,
  stderrMarked: false,
  heapOutOfMemory: false,
  oomKilled: null,
  startError: null,
  ...patch,
});

const plain: FailureContext = {
  timeoutMs: 600_000,
  memoryCap: null,
  heapCap: null,
  clean: (text) => text,
};
const capped: FailureContext = { ...plain, memoryCap: "3G" };
const CAP = "reached the 3G memory cap; rebuild with a larger --memory-max";

const token = (): string => ["gh", "p_", "Q7x2M4p9K3l8N5r6".repeat(3)].join("");

it.each<[string, Partial<EngineRunResult>, FailureContext, string | null]>([
  ["an exit 0 as no failure", {}, plain, null],
  ["a non-zero exit by its code", { exitCode: 2 }, plain, "exit code 2"],
  [
    "a signal by its name",
    { exitCode: null, signal: "SIGTERM" },
    plain,
    "stopped by SIGTERM",
  ],
  [
    "a run that could not start by its error code",
    { exitCode: null, startError: "EACCES" },
    plain,
    "could not start: EACCES",
  ],
  [
    "a timeout first, even one ended by SIGKILL under a cap",
    { exitCode: null, signal: "SIGKILL", timedOut: true, oomKilled: true },
    capped,
    "timed out after 600 s",
  ],
  [
    "a timeout that a process the engine left behind outlived",
    { exitCode: 0, timedOut: true },
    plain,
    "timed out after 600 s",
  ],
  [
    "an OOM kill counted under a cap as the cap, however the run ended",
    { exitCode: 1, oomKilled: true },
    capped,
    CAP,
  ],
  [
    "a SIGKILL under a cap whose kills cannot be read as the cap",
    { exitCode: null, signal: "SIGKILL", oomKilled: null },
    capped,
    CAP,
  ],
  [
    "a SIGKILL under a cap that counted no OOM kill as the signal",
    { exitCode: null, signal: "SIGKILL", oomKilled: false },
    capped,
    "stopped by SIGKILL",
  ],
  [
    "a SIGKILL with no cap as the signal, whatever the kills read",
    { exitCode: null, signal: "SIGKILL", oomKilled: true },
    plain,
    "stopped by SIGKILL",
  ],
  [
    "Node's heap running out before the signal it ends with",
    { exitCode: null, signal: "SIGABRT", heapOutOfMemory: true },
    plain,
    "ran out of JavaScript heap",
  ],
  [
    "Node's heap running out, with the repair when the heap is cut from the cap",
    { exitCode: null, signal: "SIGABRT", heapOutOfMemory: true },
    { ...plain, heapCap: "3G" },
    "ran out of JavaScript heap; rebuild with a larger --memory-max",
  ],
])("words %s", (_, patch, context, text) =>
  expect(runEnd(ended(patch), context)?.text ?? null).toBe(text),
);

it("says the timeout the run had, in seconds", () =>
  expect(
    runEnd(ended({ exitCode: null, signal: "SIGKILL", timedOut: true }), {
      ...plain,
      timeoutMs: 500,
    })?.text,
  ).toBe("timed out after 0.5 s"));

it("marks only the outcomes a larger memory cap can repair", () => {
  const repairs = (patch: Partial<EngineRunResult>, c: FailureContext) =>
    runEnd(ended(patch), c)?.memory;
  expect(repairs({ exitCode: 1, oomKilled: true }, capped)).toBe(true);
  expect(
    repairs(
      { exitCode: null, signal: "SIGABRT", heapOutOfMemory: true },
      {
        ...plain,
        heapCap: "3G",
      },
    ),
  ).toBe(true);
  expect(
    repairs(
      { exitCode: null, signal: "SIGABRT", heapOutOfMemory: true },
      plain,
    ),
  ).toBe(false);
  expect(repairs({ exitCode: null, timedOut: true }, capped)).toBe(false);
  expect(repairs({ exitCode: 3 }, capped)).toBe(false);
});

it("puts how the run ended first, then the excerpt, so a non-empty stderr never hides a signal", () =>
  expect(
    runFailure(
      ended({
        exitCode: null,
        signal: "SIGSEGV",
        stderrTail: "\n  orbit: bad state\n\n",
      }),
      plain,
    )?.text,
  ).toBe("stopped by SIGSEGV\n  orbit: bad state"));

it("keeps whole lines only, dropping the first line of a tail cut from a longer stderr", () =>
  expect(
    runFailure(
      ended({
        exitCode: 1,
        stderrTail: "ky 0042: half a line\nsky 0043\nsky 0044\n",
        stderrCut: true,
      }),
      plain,
    )?.text,
  ).toBe("exit code 1\nsky 0043\nsky 0044"));

it("cleans the excerpt: each root by its token, then every secret redacted", () => {
  const root = "/srv/observatory";
  const ctx = {
    exportDir: join(root, "export"),
    snapshotDir: join(root, "export", "snapshot"),
    workDir: join(root, "store", "work.tmp-7"),
    storeDir: join(root, "store"),
    enginesDir: join(root, "engines"),
    home: "/srv/astronomer",
  } as ExtractContext;
  const said = [
    `Error: cannot parse ${root}/export/snapshot/web/sky.ts`,
    `  at ${root}/engines/node_modules/sky/index.js:1:1`,
    `  read ${root}/store/work.tmp-7/run.json and ${root}/store/store.sqlite`,
    `  config ${root}/export/tsconfig.json`,
    `  node ${process.execPath}`,
    `  cache /srv/astronomer/.cache/sky: token=${token()}`,
  ].join("\n");
  expect(
    runFailure(
      ended({ exitCode: 1, stderrTail: said }),
      failureContext(ctx, 600_000),
    )?.text,
  ).toBe(
    [
      "exit code 1",
      "Error: cannot parse <snapshot>/web/sky.ts",
      "  at <engines>/node_modules/sky/index.js:1:1",
      "  read <work>/run.json and <store>/store.sqlite",
      "  config <export>/tsconfig.json",
      "  node <node>",
      "  cache ~/.cache/sky: token=«redacted:github-token»",
    ].join("\n"),
  );
});

it("takes the engine's own words when its stderr says nothing", () => {
  expect(
    runFailure(ended({ exitCode: 1 }), plain, "error: no files got indexed")
      ?.text,
  ).toBe("exit code 1\nerror: no files got indexed");
  // stderr comes first when it says anything
  expect(
    runFailure(
      ended({ exitCode: 1, stderrTail: "Error: boom\n" }),
      plain,
      "error: no files got indexed",
    )?.text,
  ).toBe("exit code 1\nError: boom");
  expect(runFailure(ended(), plain, "error: unseen")).toBeNull();
});

it("takes the build's memory cap only when the sandbox applies it, and the heap's when asked", () => {
  const ctx = {
    exportDir: "/srv/e",
    snapshotDir: "/srv/e/snapshot",
    workDir: "/srv/s/work.tmp-1",
    enginesDir: "/srv/engines",
    memoryMax: "15G",
  } as ExtractContext;
  expect(failureContext(ctx, 1000)).toMatchObject({
    timeoutMs: 1000,
    memoryCap: null,
    heapCap: null,
  });
  expect(
    failureContext({ ...ctx, memoryCapped: true }, 1000, { heap: true }),
  ).toMatchObject({ memoryCap: "15G", heapCap: "15G" });
  expect(
    failureContext({ ...ctx, memoryMax: undefined, memoryCapped: true }, 1000),
  ).toMatchObject({ memoryCap: "3G", heapCap: null });
});
