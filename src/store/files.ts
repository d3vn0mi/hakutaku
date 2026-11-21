// The files beside a store, all in its directory: the previous store, a build's
// temporary store and work directory, build.json and attempt.json. The two JSON files are
// written to a temporary file and renamed, so a reader finds the old file or the new one, never
// a part of either; a reader answers null for a file that is missing, not JSON, or not of its
// type's shape. Only a build writes them, and never as links: a link in their place is read as
// unreadable and written over, never followed.
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import {
  arrayOf,
  engineMapOf,
  type Guard,
  isNumber,
  isString,
  oneOf,
  optional,
  orNull,
  shape,
} from "./read.js";
import type { Attempt, BuildFacts } from "./types.js";

export function besideStore(storePath: string): {
  dir: string;
  prev: string;
  build: string;
  attempt: string;
  tmp(pid: number): string;
  work(pid: number): string;
} {
  const dir = dirname(storePath);
  return {
    dir,
    prev: join(dir, "store.prev.sqlite"),
    build: join(dir, "build.json"),
    attempt: join(dir, "attempt.json"),
    tmp: (pid) => join(dir, `store.tmp-${pid}.sqlite`),
    work: (pid) => join(dir, `work.tmp-${pid}`),
  };
}

const isAttempt = shape<Attempt>({
  at: isString,
  commit: isString,
  result: oneOf<Attempt["result"]>({
    built: true,
    skipped: true,
    "gates-failed": true,
    failed: true,
  }),
  reason: optional(isString),
});

type EngineRun = NonNullable<BuildFacts["engines"]["grimp"]>;

const isBuildFacts = shape<BuildFacts>({
  commit: isString,
  ref: isString,
  contentHash: isString,
  startedAt: isString,
  finishedAt: isString,
  wallMs: isNumber,
  peakRssBytes: orNull(isNumber),
  sandbox: oneOf<BuildFacts["sandbox"]>({
    bubblewrap: true,
    "systemd-run": true,
    none: true,
    unavailable: true,
  }),
  engines: engineMapOf(
    shape<EngineRun>({
      status: oneOf<EngineRun["status"]>({
        ran: true,
        skipped: true,
        failed: true,
        "timed-out": true,
        fallback: true,
      }),
      wallMs: isNumber,
      cpuMs: orNull(isNumber),
      peakRssBytes: orNull(isNumber),
      exitCode: orNull(isNumber),
    }),
  ),
  warnings: arrayOf(isString),
});

export function readAttempt(storePath: string): Attempt | null {
  return readJson(besideStore(storePath).attempt, isAttempt);
}

export function readBuildFacts(storePath: string): BuildFacts | null {
  return readJson(besideStore(storePath).build, isBuildFacts);
}

export function writeAttempt(storePath: string, a: Attempt): void {
  writeJson(besideStore(storePath).attempt, a);
}

export function writeBuildFacts(storePath: string, f: BuildFacts): void {
  writeJson(besideStore(storePath).build, f);
}

// The most bytes a JSON file beside a store may hold. A larger one reads as unreadable.
export const MAX_JSON_BYTES = 64 * 1024 * 1024;

function readJson<T>(path: string, guard: Guard<T>): T | null {
  const bytes = readRegularFile(path, MAX_JSON_BYTES);
  if (bytes === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  return guard(value) ? value : null;
}

// The bytes of a regular file, opened without following a link at its last component and
// without blocking on a FIFO; null when it is missing, a link or anything but a regular file,
// or larger than max bytes.
export function readRegularFile(path: string, max: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return null;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > max) return null;
    // Read to the end, but never past max: a file that grew since fstat is refused. The first
    // read asks for one byte more than fstat's size, and a short read is followed by a read of
    // one byte, which finds the end without another large buffer.
    const chunks: Buffer[] = [];
    let total = 0;
    let size = Math.min(stats.size, max) + 1;
    for (;;) {
      const chunk = Buffer.allocUnsafe(size);
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      total += n;
      if (total > max) return null;
      chunks.push(chunk.subarray(0, n));
      size = n < chunk.length ? 1 : Math.min(1024 * 1024, max + 1 - total);
    }
    return Buffer.concat(chunks, total);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

// The temporary file is named like the store's, <name>.tmp-<pid>.json, and sits in the same
// directory, so the rename never crosses a file system. Whatever is at that name is removed
// first, and the file is created only where nothing is, so a link there is never written
// through. The directory is made when missing, so that a build that fails before anything else
// made it can still record why.
function writeJson(path: string, value: unknown): void {
  const dir = dirname(path);
  const ext = extname(path);
  const tmp = join(dir, `${basename(path, ext)}.tmp-${process.pid}${ext}`);
  mkdirSync(dir, { recursive: true });
  try {
    rmSync(tmp, { force: true });
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
