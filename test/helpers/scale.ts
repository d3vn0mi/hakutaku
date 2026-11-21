// The scale fixture for tests: a repository of a given number of files, written by
// fixtures/scale/generate.mjs, and its store, exported with the profile hakutaku generates for it
// and extracted with the installed engines and no sandbox. Each pair is cached under
// <OS temp>/hakutaku-test-cache/scale-<hash>/, where hash is a SHA-256 of the generator,
// hakutaku's src/, ast-grep/, python/ and engines.lock.json, the number of files and the detail,
// and is built as the sample is (sample.ts): in a temporary directory, renamed into place once
// complete. Neither the repository nor the store must be changed by a test.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultEnginesDir } from "../../src/engines/index.js";
import { exportRepo, removeTree } from "../../src/export/index.js";
import { extractSnapshot } from "../../src/extract/index.js";
import type { Detail } from "../../src/model/index.js";
import { openStore } from "../../src/store/index.js";
import { cached, hashOf } from "./sample.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GENERATE = join(ROOT, "fixtures", "scale", "generate.mjs");
const INPUTS = [
  "fixtures/scale/generate.mjs",
  "src",
  "ast-grep",
  "python",
  "engines.lock.json",
];
const GENERATE_TIMEOUT = 300_000;

// The installed engines, read when this module loads: a test may later point the XDG
// variables at a scratch root, where no engine is installed.
const ENGINES_DIR = defaultEnginesDir();

// The fixture of this many files: its repository, the store.sqlite of its main branch at this
// detail, and the commit main ends at. A build that did not pass its gates, or in which an
// engine failed or fell back, throws rather than being cached.
export async function scaleStore(
  files: number,
  detail: Detail = "standard",
): Promise<{ repo: string; store: string; commit: string }> {
  const name = `scale-${hashOf(INPUTS, `${files}:${detail}`)}`;
  const dir = await cached(name, async (tmp) => {
    const repo = join(tmp, "repo");
    const commit = execFileSync(
      process.execPath,
      [GENERATE, "--files", String(files), "--out", repo],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: GENERATE_TIMEOUT,
      },
    ).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) {
      throw new Error(`the scale generator printed ${JSON.stringify(commit)}`);
    }
    writeFileSync(join(tmp, "commit"), commit);
    const exported = join(tmp, "export");
    const out = join(tmp, "store", "store.sqlite");
    try {
      await exportRepo({ repo, ref: "main", out: exported, id: "scale" });
      const result = await extractSnapshot({
        dir: exported,
        out,
        enginesDir: ENGINES_DIR,
        detail,
        sandbox: "none",
      });
      if (result.result !== "built") {
        throw new Error(
          `the scale fixture of ${files} files did not build at ${detail} detail: ${result.result}${
            result.reason === undefined ? "" : `: ${result.reason}`
          }`,
        );
      }
    } finally {
      removeTree(exported);
    }
    checkEngines(out, `the scale fixture of ${files} files`, detail);
  });
  return {
    repo: join(dir, "repo"),
    store: join(dir, "store", "store.sqlite"),
    commit: readFileSync(join(dir, "commit"), "utf8"),
  };
}

// Each engine's own tier, never only the build's result: a failed engine or a fallback still
// builds a store, a lighter one than the fixture's.
function checkEngines(path: string, what: string, detail: Detail): void {
  const store = openStore(path);
  if ("code" in store) throw new Error(`${what}: ${store.reason}`);
  try {
    const bad = Object.entries(store.meta.coverage.tiers).filter(
      ([, tier]) => tier !== "ran" && tier !== "skipped",
    );
    if (bad.length > 0) {
      throw new Error(
        `${what} built at ${detail} detail with ${bad
          .map(([engine, tier]) => `${engine} ${tier}`)
          .join(", ")}`,
      );
    }
  } finally {
    store.close();
  }
}
