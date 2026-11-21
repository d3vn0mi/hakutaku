// extractSnapshot with an engine killed as the kernel kills one at the memory cap, where the
// cgroup's OOM kill count cannot be read, as inside bubblewrap. Needs the installed engines, as
// extract.test.ts does.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { exportRepo, removeTree } from "../../../src/export/index.js";
import { extractSnapshot } from "../../../src/extract/index.js";
import { compilerTier } from "../../../src/query/tiers.js";
import { openStore, readBuildFacts } from "../../../src/store/index.js";
import { standInEnginesDir } from "../../helpers/engines.js";
import { makeRepo } from "../../helpers/git.js";

vi.mock("../../../src/extract/cgroup.js", async (original) => ({
  ...(await original<typeof import("../../../src/extract/cgroup.js")>()),
  oomKills: () => null,
}));

const TIMEOUT = 300_000;

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) removeTree(dir);
});

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-oracle-cap-"));
  made.push(dir);
  return dir;
};

const CAP = "reached the 3G memory cap; rebuild with a larger --memory-max";

it(
  "says an engine killed under the sandbox's memory cap reached it, with its repair, and only under a cap",
  async () => {
    const repo = await makeRepo({
      commits: [
        {
          date: "2026-03-02T10:00:00Z",
          files: {
            "web/src/orbit.ts": "export const solve = (t: number) => t * 2;\n",
            "web/src/sky.ts":
              'import { solve } from "./orbit";\nexport const day = solve(1);\n',
          },
        },
      ],
    });
    const dir = join(tmp(), "export");
    await exportRepo({ repo, ref: "HEAD", out: dir });
    // killed by SIGKILL, as the kernel kills the largest process at the cap; no core is dumped
    const enginesDir = standInEnginesDir("scip-typescript", {
      node: 'process.kill(process.pid, "SIGKILL");\n',
    });
    const build = async (memoryCapped: boolean) => {
      const out = join(tmp(), "store", "store.sqlite");
      const r = await extractSnapshot({
        dir,
        out,
        enginesDir,
        sandbox: "none",
        memoryCapped,
      });
      expect(r.result).toBe("built");
      const store = openStore(out);
      if ("code" in store) throw new Error(store.reason);
      try {
        return {
          outOfMemory: store.meta.coverage.outOfMemory,
          tier: compilerTier(store, "typescript"),
          warnings: readBuildFacts(out)?.warnings ?? [],
        };
      } finally {
        store.close();
      }
    };

    const capped = await build(true);
    expect(capped.outOfMemory).toEqual({
      memoryMax: "3G",
      tiers: { "scip-typescript": CAP },
    });
    expect(capped.tier).toEqual({
      ran: false,
      reason: `scip-typescript ${CAP}`,
    });
    expect(capped.warnings).toContain(`scip-typescript failed: ${CAP}`);

    // the control: with nothing capping the build, the same kill is only a signal
    const uncapped = await build(false);
    expect(uncapped.outOfMemory).toBeUndefined();
    expect(uncapped.tier).toEqual({
      ran: false,
      reason: "scip-typescript fell back",
    });
    expect(uncapped.warnings).toContain(
      "scip-typescript failed: stopped by SIGKILL",
    );
  },
  TIMEOUT,
);
