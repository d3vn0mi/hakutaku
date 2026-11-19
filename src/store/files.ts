// The files beside a store, all in its directory: the previous store, a build's
// temporary store and work directory, build.json and attempt.json. The two JSON files are
// written to a temporary file and renamed, so a reader finds the old file or the new one, never
// a part of either; a reader answers null for a file that is missing, not JSON, or not of its
// type's shape.
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
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

// A file that is not a regular one is never read: a read of a FIFO would block until a writer
// opened it.
function readJson<T>(path: string, guard: Guard<T>): T | null {
  let value: unknown;
  try {
    if (!statSync(path).isFile()) return null;
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  return guard(value) ? value : null;
}

// The temporary file is named like the store's, <name>.tmp-<pid>.json, and sits in the same
// directory, so the rename never crosses a file system. The directory is made when missing, so
// that a build that fails before anything else made it can still record why.
function writeJson(path: string, value: unknown): void {
  const dir = dirname(path);
  const ext = extname(path);
  const tmp = join(dir, `${basename(path, ext)}.tmp-${process.pid}${ext}`);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
