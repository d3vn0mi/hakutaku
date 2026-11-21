// runEngine's OOM kill count, with this cgroup's memory.events replaced: the count read before
// the engine starts and the count read after it ends.
import { afterEach, expect, it, vi } from "vitest";

const counts = vi.hoisted(() => ({ seen: [] as Array<number | null> }));

vi.mock("../../../src/extract/cgroup.js", async (original) => ({
  ...(await original<typeof import("../../../src/extract/cgroup.js")>()),
  cgroupOf: () => "/sky.scope",
  oomKills: () => (counts.seen.length > 0 ? counts.seen.shift() : null),
}));

const { runEngine } = await import("../../../src/extract/run.js");

afterEach(() => {
  counts.seen = [];
});

const run = () =>
  runEngine({
    engine: "ast-grep",
    argv: [process.execPath, "-e", ""],
    cwd: process.cwd(),
    env: {},
    timeoutMs: 30_000,
  });

it.each<[string, Array<number | null>, boolean | null]>([
  ["one more kill after the run as a kill", [0, 1], true],
  ["a kill from before the run only as none", [2, 2], false],
  ["a count it cannot read before the run as unknown", [null, 1], null],
  ["a count it cannot read after the run as unknown", [0, null], null],
])("reads %s", async (_, seen, oomKilled) => {
  counts.seen = [...seen];
  expect((await run()).oomKilled).toBe(oomKilled);
});
