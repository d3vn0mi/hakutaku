// Runs the sky map's unit tests with the clock in UTC, so that the times in their expectations
// hold on every machine. Arguments go on to vitest.
//
//   npm test -- src/orbits
import { spawnSync } from "node:child_process";

const result = spawnSync("npx", ["vitest", "run", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, TZ: "UTC" },
});
process.exit(result.status ?? 1);
