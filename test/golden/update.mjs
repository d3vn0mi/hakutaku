// Rewrites the golden files from the sample's stores: runs the golden test with
// HAKUTAKU_GOLDEN_UPDATE=1, which writes each case's file instead of comparing it. Read every
// diff before committing it.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const run = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", "test/golden"],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, HAKUTAKU_GOLDEN_UPDATE: "1" },
  },
);
if (run.error !== undefined) {
  console.error(`golden:update: cannot run vitest: ${run.error.message}`);
}
process.exit(run.status ?? 1);
