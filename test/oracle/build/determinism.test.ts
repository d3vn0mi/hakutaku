// One commit, one content hash. Each build exports the sample into a directory of its own and
// extracts it into a store of its own; the hash is worked out again from the store's content
// tables, never only read from run, which keeps the ref outside the hash. The standard build's
// hash goes to the file HAKUTAKU_HASH_OUT names, when set: CI compares it across the Node
// versions it runs, each bundling its own SQLite. Every build is checked engine by engine, so
// the tests need the Python the engines were installed with: where it does not start, they are
// skipped, and in CI they fail. Run `node dist/cli/main.js engines install --yes` once.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { defaultEnginesDir } from "../../../src/engines/index.js";
import { exportRepo, removeTree } from "../../../src/export/index.js";
import { extractSnapshot } from "../../../src/extract/index.js";
import type { Detail } from "../../../src/model/index.js";
import {
  contentHash,
  openStore,
  type Store,
} from "../../../src/store/index.js";
import { git } from "../../helpers/git.js";
import { requireInCI } from "../../helpers/live.js";
import { samplePythonProbe, sampleRepo } from "../../helpers/sample.js";

const TIMEOUT = 300_000;
const PROFILE = fileURLToPath(
  new URL("../../../fixtures/observatory/profile.json", import.meta.url),
);
const ENGINES_DIR = defaultEnginesDir();
const PYTHON = samplePythonProbe();
// What runs at each detail: scip-typescript starts at standard, scip-python at deep.
const TIERS: Partial<Record<Detail, Store["meta"]["coverage"]["tiers"]>> = {
  quick: {
    "ast-grep": "ran",
    "dependency-cruiser": "ran",
    grimp: "ran",
    "scip-typescript": "skipped",
    "scip-python": "skipped",
  },
  standard: {
    "ast-grep": "ran",
    "dependency-cruiser": "ran",
    grimp: "ran",
    "scip-typescript": "ran",
    "scip-python": "skipped",
  },
};

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) removeTree(dir);
});

// The sample at ref, exported into a fresh directory and built into a fresh store at detail:
// the store's commit, its run row, and the hash of its content tables.
async function build(
  ref: string,
  detail: Detail,
): Promise<{ commit: string; run: Store["run"]; hash: string }> {
  const root = mkdtempSync(join(tmpdir(), "hakutaku-oracle-determinism-"));
  made.push(root);
  const dir = join(root, "export");
  await exportRepo({
    repo: await sampleRepo(),
    ref,
    out: dir,
    id: "observatory",
    profile: PROFILE,
  });
  const out = join(root, "store", "store.sqlite");
  const result = await extractSnapshot({
    dir,
    out,
    enginesDir: ENGINES_DIR,
    detail,
    sandbox: "none",
  });
  expect(result.result).toBe("built");
  const store = openStore(out);
  if ("code" in store) throw new Error(`${out}: ${store.reason}`);
  try {
    expect(store.meta.detail).toBe(detail);
    expect(store.meta.coverage.tiers).toEqual(TIERS[detail]);
    const hash = contentHash(store.db);
    // what the build recorded is what its content hashes to
    expect(store.run.contentHash).toBe(hash);
    expect(result.contentHash).toBe(hash);
    return { commit: store.meta.commit, run: store.run, hash };
  } finally {
    store.close();
  }
}

it(
  "gives one content hash for two refs naming one commit, from two export directories",
  async (ctx) => {
    requireInCI(ctx, PYTHON);
    const head = git(await sampleRepo(), "rev-parse", "HEAD");
    const a = await build("main", "standard");
    const b = await build("HEAD", "standard");
    expect([a.commit, b.commit]).toEqual([head, head]);
    expect(a.hash).toBe(b.hash);
    expect(a.run.ref).toBe("main");
    expect(b.run.ref).toBe("HEAD");
    if (process.env.HAKUTAKU_HASH_OUT) {
      writeFileSync(process.env.HAKUTAKU_HASH_OUT, `${a.hash}\n`);
    }
  },
  TIMEOUT,
);

it(
  "gives one content hash for two builds at quick detail",
  async (ctx) => {
    requireInCI(ctx, PYTHON);
    const a = await build("main", "quick");
    const b = await build("main", "quick");
    expect(a.commit).toBe(b.commit);
    expect(a.hash).toBe(b.hash);
  },
  TIMEOUT,
);
