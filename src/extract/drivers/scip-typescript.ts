// The scip-typescript driver: runs scip-typescript from the engine lock over the snapshot with
// the export's generated tsconfig, and reads its index into SCIP facts, the compiler's binding
// of each TypeScript and JavaScript use to a definition. It runs at standard and deep detail.
//
// scip-typescript 0.5.2, as probed:
// - it names each symbol after the nearest package.json above the file, looking upwards until
//   it reaches its project. Given the tsconfig file as its project it never reaches it, and
//   climbs to "/", so every symbol of a repo without a root package.json would hold the export
//   directory's absolute path. Given the export directory, the tsconfig's own directory, it
//   stops there, and such a symbol reads "scip-typescript npm . . snapshot/<path>/...";
// - it writes one Index message per document after one holding the metadata, with positions
//   in TypeScript's UTF-16 code units, the encoding left unspecified, and every range in the
//   packed range field;
// - it writes a document for every file in its tsconfig's list, an empty file included, but
//   skips a file larger than --max-file-byte-size, whose default "1mb" is 1,000,000 bytes;
// - it exits 1, with an error line on stdout, when it indexed no file;
// - it catches an error it meets in one file, prints it on stderr, and goes on to exit 0,
//   leaving that file's document partial or missing.
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { readLock, resolveBin } from "../../engines/index.js";
import { SOURCE_CAP } from "../../export/source-policy.js";
import type { EngineDriver, ExtractContext } from "../context.js";
import { hasTsconfigInput } from "../resolve/ts.js";
import { type EngineRunResult, engineEnv, runEngine } from "../run.js";
import { decodeScipIndex } from "../scip/decode.js";
import { type ScipFacts, scipFacts } from "../scip/facts.js";

export type { ScipFacts } from "../scip/facts.js";

const TIMEOUT_MS = 600_000;
const DEEP_TIMEOUT_MS = 3_600_000;
const DEFAULT_MEMORY_MAX = "3G";
const LINE_CACHE = 16;

// How scip-typescript reports a file it could not index, when it goes on without it.
const FILE_ERROR = "unexpected error indexing";

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

export const scipTypescriptDriver: EngineDriver<ScipFacts> = {
  name: "scip-typescript",
  minDetail: "standard",
  // With no file in the tsconfig's list, scip-typescript indexes nothing and exits 1.
  applies: (ctx) => ctx.detail !== "quick" && hasTsconfigInput(ctx.manifest),
  run: runScipTypescript,
};

async function runScipTypescript(ctx: ExtractContext): Promise<ScipFacts> {
  const snapshotDir = resolve(ctx.snapshotDir);
  const workDir = resolve(ctx.workDir);
  const heap = heapMiB(ctx.memoryMax ?? DEFAULT_MEMORY_MAX);
  const bin = resolveBin(
    ctx.enginesDir,
    readLock().lock.engines["scip-typescript"].bin,
  );
  const output = join(workDir, "index.scip");
  const timeoutMs = ctx.detail === "deep" ? DEEP_TIMEOUT_MS : TIMEOUT_MS;
  try {
    const result = await runEngine({
      engine: "scip-typescript",
      argv: [
        process.execPath,
        `--max-old-space-size=${heap}`,
        bin,
        "index",
        "--cwd",
        snapshotDir,
        "--output",
        output,
        "--no-global-caches",
        "--no-progress-bar",
        // Three times hakutaku's own cap, so that it skips no file under that cap, even one
        // whose invalid bytes it reads as three-byte U+FFFD; export keeps larger files out of
        // the tsconfig's list.
        "--max-file-byte-size",
        String(3 * SOURCE_CAP),
        resolve(ctx.exportDir),
      ],
      cwd: workDir,
      env: engineEnv(ctx, false),
      timeoutMs,
    });
    const failure = failureOf(result, timeoutMs);
    if (failure !== null) throw new Error(`scip-typescript failed: ${failure}`);
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(output);
    } catch (error) {
      throw new Error(
        `scip-typescript failed: cannot read its index (${messageOf(error)})`,
      );
    }
    return scipFacts(decodeScipIndex(bytes), snapshotLines(snapshotDir));
  } finally {
    rmSync(output, { force: true });
  }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Why a run failed, or null: a timeout, any exit but 0, or a file scip-typescript could not
// index and went on without.
function failureOf(r: EngineRunResult, timeoutMs: number): string | null {
  const tail = r.stderrTail.trim();
  if (r.timedOut) {
    return `timed out after ${timeoutMs / 1000} s${tail === "" ? "" : `\n${tail}`}`;
  }
  if (r.exitCode !== 0) {
    if (tail !== "") return tail;
    const said = r.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("error:"))
      .pop();
    if (said !== undefined) return said;
    return r.signal !== null
      ? `stopped by ${r.signal}`
      : `exit code ${r.exitCode}`;
  }
  const at = tail.indexOf(FILE_ERROR);
  return at === -1 ? null : tail.slice(at);
}

// The store's lines of a snapshot file: the file decoded as the store decodes text (each
// invalid UTF-8 sequence one U+FFFD, a byte order mark kept), split at LF, each line without
// the CR of a CRLF. A few files are kept, as the facts are read one document at a time.
function snapshotLines(
  snapshotDir: string,
): (file: string, line0: number) => string {
  const cache = new Map<string, string[]>();
  return (file, line0) => {
    let lines = cache.get(file);
    if (lines === undefined) {
      lines = decoder.decode(readFileSync(join(snapshotDir, file))).split("\n");
      if (cache.size >= LINE_CACHE) {
        cache.delete(cache.keys().next().value as string);
      }
      cache.set(file, lines);
    }
    const line = lines[line0];
    if (line === undefined) {
      throw new Error(
        `scip-typescript reported line ${line0 + 1} of ${file}, past its end`,
      );
    }
    return line.endsWith("\r") ? line.slice(0, -1) : line;
  };
}

// systemd's size syntax, as MemoryMax takes it: bytes, or K, M, G, T, P or E, each 1024 times
// the one before, with an optional fraction.
const SIZE = /^(\d+(?:\.\d+)?)([KMGTPE]?)$/;
const POWERS = "KMGTPE";

// Node's heap for a memory cap, in MiB: 80% of the cap, which leaves room for the memory Node
// holds outside its heap, so that a build too large for the cap stops with Node's own error.
export function heapMiB(memoryMax: string): number {
  const m = SIZE.exec(memoryMax);
  if (m === null) {
    throw new Error(
      `scip-typescript: cannot read the memory cap ${JSON.stringify(memoryMax)}`,
    );
  }
  const unit = m[2] ?? "";
  const bytes =
    Number(m[1]) * 1024 ** (unit === "" ? 0 : POWERS.indexOf(unit) + 1);
  const mib = Math.floor((bytes * 4) / (5 * 1024 * 1024));
  if (mib < 1) {
    throw new Error(
      `scip-typescript: the memory cap ${JSON.stringify(memoryMax)} leaves Node no heap`,
    );
  }
  return mib;
}
