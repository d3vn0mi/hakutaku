// A store swapped under a running server: hakutaku mcp serves the observatory sample from its
// registered store, a build renames a new store over it between two calls, as extract does, and
// the next call answers from the new store, with no "database is locked" error. Run `npm run
// build` first; the sample is built with the engines' Python, and where that Python does not
// start the test is skipped, and in CI it fails.
import { copyFileSync, existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { storePathFor } from "../../src/registry/index.js";
import { requireInCI } from "../helpers/live.js";
import { call, readGolden, startStdioClient } from "../helpers/mcp-client.js";
import { emptyContent, miniStore } from "../helpers/mini-store.js";
import { sampleEnv, samplePythonProbe } from "../helpers/sample.js";

const PYTHON = samplePythonProbe();
const TIMEOUT = 600_000;
const REPO = "observatory";

// The store path of the repo under env's XDG directories.
function storePathUnder(env: NodeJS.ProcessEnv): string {
  vi.stubEnv("XDG_DATA_HOME", env.XDG_DATA_HOME ?? "");
  try {
    return storePathFor(REPO);
  } finally {
    vi.unstubAllEnvs();
  }
}

// What a code_overview call answers as builtCommit, and whether it is an error.
async function overview(client: Parameters<typeof call>[0]) {
  const r = await call(client, "code_overview", { repo: REPO });
  return { isError: r.isError, builtCommit: JSON.parse(r.text).builtCommit };
}

it(
  "answers from a store swapped between calls",
  async (ctx) => {
    requireInCI(ctx, PYTHON);
    // the sample's standard store, copied into place under the env by sampleEnv
    const { env } = await sampleEnv();
    const path = storePathUnder(env);
    expect(existsSync(path)).toBe(true);
    const golden = readGolden("code_overview/repo").result;
    if (!("answer" in golden))
      throw new Error("code_overview/repo is an error");
    const sampleCommit = (golden.answer as { builtCommit: string }).builtCommit;
    expect(sampleCommit).toMatch(/^[0-9a-f]{12}$/);
    expect(sampleCommit).not.toBe("ffffffffffff");

    const session = await startStdioClient({ args: ["mcp", REPO], env });
    try {
      expect(await overview(session.client)).toEqual({
        isError: false,
        builtCommit: sampleCommit,
      });
      // a build's swap: the new store written to a temporary file beside the served one, then
      // renamed over it
      const base = emptyContent(REPO);
      const meta = base.meta[0];
      if (meta === undefined) throw new Error("emptyContent has no meta row");
      const next = miniStore({
        ...base,
        meta: [{ ...meta, commit_sha: "f".repeat(40) }],
      });
      const temporary = join(dirname(path), "store.sqlite.next");
      copyFileSync(next, temporary);
      renameSync(temporary, path);
      expect(await overview(session.client)).toEqual({
        isError: false,
        builtCommit: "ffffffffffff",
      });
    } finally {
      await session.close();
    }
    expect(session.stderr()).not.toContain("database is locked");
  },
  TIMEOUT,
);
