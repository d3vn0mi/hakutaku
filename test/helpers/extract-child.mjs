// One build that dies part-way, for the tests of interrupted builds:
//
//   node test/helpers/extract-child.mjs <exportDir> <storePath> <enginesDir> <stage>
//
// It takes the build lock, then extracts the export directory into the store with no sandbox,
// from the built package (run `npm run build` first). When the build reaches <stage> (one of
// extractSnapshot's stages, such as engine:scip-typescript, write-store or swap), it sends
// SIGKILL to its own process group, so any engine it is running dies with it, as when the
// machine stops a build with no warning. Start it detached, so that it leads a process group of
// its own and the signal reaches nothing else. A build that ends without reaching <stage>
// exits 1, saying so; a usage error exits 2.
import { extractSnapshot } from "../../dist/build.js";
import { withBuildLock } from "../../dist/registry/index.js";

const args = process.argv.slice(2);
if (args.length !== 4 || args.some((arg) => arg === "")) {
  process.stderr.write(
    "usage: node test/helpers/extract-child.mjs <exportDir> <storePath> <enginesDir> <stage>\n",
  );
  process.exit(2);
}
const [dir, out, enginesDir, stage] = args;

const result = await withBuildLock(() =>
  extractSnapshot(
    { dir, out, enginesDir, sandbox: "none" },
    {
      onStage(reached) {
        if (reached === stage) process.kill(-process.pid, "SIGKILL");
      },
    },
  ),
);
process.stderr.write(
  `extract-child: the build ended (${result.result}) without reaching ${stage}\n`,
);
process.exit(1);
