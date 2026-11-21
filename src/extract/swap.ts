// What a build does to the files beside its store: the atomic swap that
// keeps the previous store, the removal of what dead builds left, and the provisional attempt
// that explains a build that dies.
import {
  existsSync,
  linkSync,
  lstatSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { removeTree } from "../export/index.js";
import { besideStore, writeAttempt } from "../store/index.js";

// The largest pid process.kill accepts.
const MAX_PID = 2 ** 31 - 1;

// The temporary names a build leaves in its store's directory, each holding its pid.
const TEMP_NAMES: readonly RegExp[] = [
  /^store\.tmp-(\d+)\.sqlite(?:-journal)?$/, // the store being built, and SQLite's journal
  /^store\.prev\.tmp-(\d+)\.sqlite$/, // swapIn's link to the store it replaces
  /^(?:attempt|build)\.tmp-(\d+)\.json$/, // attempt.json or build.json being written
  /^work\.tmp-(\d+)$/, // the engines' scratch directory
];

// Puts the store at tmpPath in place. The current store is first hard-linked to
// store.prev.sqlite, through a temporary name and a rename, then tmpPath is renamed over it, so
// a reader finds the store, and the previous one, at every moment. Without a current store, it
// only renames.
export function swapIn(tmpPath: string, storePath: string): void {
  if (!lstatSync(tmpPath).isFile()) {
    throw new Error(`swapIn: ${tmpPath} is not a regular file`);
  }
  const { dir, prev } = besideStore(storePath);
  if (existsSync(storePath)) {
    const link = join(dir, `store.prev.tmp-${process.pid}.sqlite`);
    rmSync(link, { force: true });
    linkSync(storePath, link);
    renameSync(link, prev);
  }
  renameSync(tmpPath, storePath);
}

// Removes each temporary file or directory in storeDir whose build's pid is not alive. A build
// calls it before it makes any temporary file of its own.
export function cleanupStale(storeDir: string): void {
  let names: string[];
  try {
    names = readdirSync(storeDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    const pid = pidIn(name);
    if (pid !== null && !isAlive(pid)) removeTree(join(storeDir, name));
  }
}

// Records the stage a build has reached as a failed attempt, so that a build that dies is
// explained without anything written after it, and a running build reads as stale. The stages
// are "running <engine>", "writing the store", "checking the gates" and "swapping the store",
// and, while a sandbox builds, "building in the <sandbox> sandbox".
export function markStage(
  storePath: string,
  commit: string,
  stage: string,
): void {
  writeAttempt(storePath, {
    at: new Date().toISOString(),
    commit,
    result: "failed",
    reason: `interrupted or still running (pid ${process.pid}): ${stage}`,
  });
}

// The pid in a temporary name: an integer from 1 to MAX_PID with no leading zero, as a build
// writes it; null for any other name.
function pidIn(name: string): number | null {
  for (const pattern of TEMP_NAMES) {
    const digits = pattern.exec(name)?.[1];
    if (digits === undefined) continue;
    if (!/^[1-9]\d*$/.test(digits)) return null;
    const pid = Number(digits);
    return pid <= MAX_PID ? pid : null;
  }
  return null;
}

// This process's own pid counts as dead: cleanupStale runs before the build makes a temporary
// file, so a name holding it was left by an earlier process with the same pid. Successive
// containers' processes often share pids, and every build re-run inside bubblewrap is pid 2 of
// its own namespace.
function isAlive(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process. EPERM: a live process of another user.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
