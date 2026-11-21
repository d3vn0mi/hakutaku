// The observatory sample, exported and extracted against the installed engines: run
// `node dist/cli/main.js engines install --yes` once, and `npm run build` before this file,
// since one test runs dist/. The build is checked engine by engine, never through its result
// alone. Both tests need the Python the engines were installed with, since grimp must run:
// where it does not, they are skipped, and in CI they fail.
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { hakutakuDirs } from "../../src/registry/index.js";
import { openStore } from "../../src/store/index.js";
import { git } from "../helpers/git.js";
import { requireInCI } from "../helpers/live.js";
import {
  sampleEnv,
  samplePythonProbe,
  sampleRepo,
  sampleStore,
} from "../helpers/sample.js";

const TIMEOUT = 300_000;
const MAIN = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
const PYTHON = samplePythonProbe();

it(
  "builds the sample at standard detail with every gate passing",
  async (ctx) => {
    requireInCI(ctx, PYTHON);
    const s = openStore(await sampleStore());
    if ("code" in s) throw new Error(`the sample store: ${s.reason}`);
    try {
      expect(s.meta.repoId).toBe("observatory");
      expect(s.meta.commit).toBe(git(await sampleRepo(), "rev-parse", "HEAD"));
      expect(s.meta.detail).toBe("standard");
      expect(s.meta.coverage.tiers).toEqual({
        "ast-grep": "ran",
        "dependency-cruiser": "ran",
        grimp: "ran",
        "scip-typescript": "ran",
      });
      expect(s.meta.gates.map((g) => g.gate)).toEqual([
        "files-indexed",
        "unresolved-imports",
        "scip-duplicates",
        "denylist",
        "redaction",
      ]);
      expect(s.meta.gates.filter((g) => !g.ok)).toEqual([]);
      expect(s.meta.gates.every((g) => g.ok)).toBe(true);
      expect(s.meta.coverage.denied).toBe(1);
    } finally {
      s.close();
    }
  },
  TIMEOUT,
);

it(
  "serves the sample, built and fresh, from XDG directories of its own",
  async (ctx) => {
    requireInCI(ctx, PYTHON);
    const xdg = ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"];
    const before = xdg.map((name) => process.env[name]);
    const { env, dirs } = await sampleEnv();
    // this process's own environment is left as it was
    expect(xdg.map((name) => process.env[name])).toEqual(before);
    expect(dirs).toEqual(hakutakuDirs(env));
    for (const dir of Object.values(dirs)) {
      expect(dir.startsWith(join(tmpdir(), "hakutaku-sample-env-"))).toBe(true);
    }

    const head = git(await sampleRepo(), "rev-parse", "HEAD");
    const answer = JSON.parse(
      execFileSync(
        process.execPath,
        [MAIN, "query", "code_repos", "observatory"],
        {
          env,
          encoding: "utf8",
        },
      ),
    );
    expect(answer.repos).toHaveLength(1);
    expect(answer.repos[0]).toMatchObject({
      id: "observatory",
      ref: "main",
      builtCommit: head.slice(0, 12),
      headCommit: head.slice(0, 12),
      stale: false,
      detail: "standard",
    });
  },
  TIMEOUT,
);
