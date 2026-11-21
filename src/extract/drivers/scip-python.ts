// The scip-python driver: runs scip-python from the engine lock over the snapshot, at deep
// detail only, and reads its index into SCIP facts, Pyright's binding of each Python use to a
// definition, which the merge joins to the outline as it joins scip-typescript's.
//
// scip-python 0.6.8, as probed:
// - its project is the directory --cwd names, whose pyrightconfig.json it reads before it looks
//   anywhere else. It runs from the export directory, whose pyrightconfig.json export writes, so
//   neither a repository's own config (removed at export) nor its pyproject.toml's
//   [tool.pyright] is read. --target-only names its documents below the snapshot, as repo paths;
// - without a project name and version it looks for a pyproject.toml in its project and in each
//   directory above it, and asks git for the commit; both are given, so it does neither;
// - without --environment it runs pip to list the installed packages; the export's
//   empty-env.json lists none;
// - Pyright asks python3, then python, on PATH for its version and its search paths, and no
//   option names another interpreter: PATH is the work directory's bin/ alone, whose python3 and
//   python are the pinned interpreter;
// - it writes one Index message per document, with positions in UTF-16 code units of the text
//   as Pyright reads it (a byte order mark counted, a line ended at LF, CR and CRLF only), the
//   encoding left unspecified, and every range in the packed range field. Every file it indexes
//   gets a document, its module defined at its start;
// - it catches a failure of its analysis, reports it among its progress lines on stdout, and
//   goes on to exit 0 with what it could index;
// - it indexes each repo file that a file it indexes imports, even one its config leaves out,
//   after Pyright has read it: a metadata-only file's document is dropped, so that it adds no
//   fact, as no engine's input holds it.
import { lstatSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { readLock, resolveBin } from "../../engines/index.js";
import { pyrightReads } from "../../export/configs.js";
import type { ExportManifest } from "../../export/index.js";
import type { EngineDriver, ExtractContext } from "../context.js";
import {
  EngineFailure,
  engineEnv,
  excerptOf,
  failureContext,
  runEngine,
  runFailure,
} from "../run.js";
import { decodeScipIndex } from "../scip/decode.js";
import { type ScipFacts, scipFacts } from "../scip/facts.js";
import { heapMiB, snapshotLines } from "./scip-typescript.js";

const DEEP_TIMEOUT_MS = 3_600_000;
const DEFAULT_MEMORY_MAX = "3G";

// How scip-python reports a part of its analysis that failed, before it goes on without it.
const ANALYSIS_FAILED = "Analysis partially failed";

// What export writes beside the snapshot for scip-python.
const CONFIG = "pyrightconfig.json";
const ENVIRONMENT = "empty-env.json";

export const scipPythonDriver: EngineDriver<ScipFacts> = {
  name: "scip-python",
  minDetail: "deep",
  applies: (ctx) => ctx.detail === "deep" && hasPyrightInput(ctx.manifest),
  run: runScipPython,
};

// Whether the tree holds a file Pyright reads: a regular one, not metadata-only, that the
// export's pyrightconfig.json leaves in.
function hasPyrightInput(
  manifest: Pick<ExportManifest, "tree" | "metadataOnly">,
): boolean {
  const skipped = new Set(manifest.metadataOnly.map((m) => m.path));
  return manifest.tree.some(
    (e) =>
      (e.mode === "100644" || e.mode === "100755") &&
      !skipped.has(e.path) &&
      pyrightReads(e.path),
  );
}

const isRegularFile = (path: string): boolean =>
  lstatSync(path, { throwIfNoEntry: false })?.isFile() === true;

async function runScipPython(ctx: ExtractContext): Promise<ScipFacts> {
  const exportDir = resolve(ctx.exportDir);
  const snapshotDir = resolve(ctx.snapshotDir);
  const workDir = resolve(ctx.workDir);
  // Without a config of the export's own, Pyright would look for one in each directory above
  // the export, and take the first pyproject.toml it finds there.
  for (const name of [CONFIG, ENVIRONMENT]) {
    if (!isRegularFile(join(exportDir, name))) {
      throw new Error(
        `scip-python failed: the export has no ${name} of its own; export the repository again`,
      );
    }
  }
  const entry = readLock().lock.engines["scip-python"];
  if (entry === undefined) {
    throw new Error("scip-python failed: the engine lock holds no scip-python");
  }
  const heap = heapMiB(ctx.memoryMax ?? DEFAULT_MEMORY_MAX);
  const output = join(workDir, "index.scip");
  const timeoutMs = ctx.timeoutMs ?? DEEP_TIMEOUT_MS;
  try {
    const result = await (ctx.runner ?? runEngine)({
      engine: "scip-python",
      argv: [
        process.execPath,
        `--max-old-space-size=${heap}`,
        resolveBin(ctx.enginesDir, entry.bin),
        "index",
        "--cwd",
        exportDir,
        "--target-only",
        snapshotDir,
        "--project-name",
        ctx.manifest.id,
        "--project-version",
        ".",
        "--output",
        output,
        "--environment",
        join(exportDir, ENVIRONMENT),
      ],
      cwd: exportDir,
      env: engineEnv(ctx, true),
      timeoutMs,
    });
    // Its heap is cut from the memory cap, as scip-typescript's is, so a larger cap repairs a
    // heap that ran out: Node's own limit would stop it far below the cap of a deep build.
    const f = failureContext(ctx, timeoutMs, { heap: true });
    const failure = runFailure(result, f);
    if (failure !== null) {
      throw new EngineFailure(
        `scip-python failed: ${failure.text}`,
        failure.end,
      );
    }
    // A progress line starts with the time it was written, which the message leaves out.
    const partial = result.stdout
      .split("\n")
      .find((line) => line.includes(ANALYSIS_FAILED));
    if (partial !== undefined) {
      throw new Error(
        `scip-python failed: its analysis failed part-way\n${excerptOf(
          partial.slice(partial.indexOf(ANALYSIS_FAILED)),
          false,
          f.clean,
        )}`,
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(output);
    } catch (error) {
      throw new Error(
        `scip-python failed: cannot read its index (${messageOf(error)})`,
      );
    }
    const skipped = new Set(ctx.manifest.metadataOnly.map((m) => m.path));
    const index = decodeScipIndex(bytes);
    return scipFacts(
      {
        ...index,
        documents: index.documents.filter((d) => !skipped.has(d.relativePath)),
      },
      snapshotLines(snapshotDir, "scip-python"),
      "pyright",
    );
  } finally {
    rmSync(output, { force: true });
  }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
