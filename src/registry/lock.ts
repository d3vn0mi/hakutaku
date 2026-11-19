// The build lock: one build at a time on this machine. withBuildLock creates <data>/build.lock
// holding {"pid":<pid>}, runs the job, and then removes the file, only while it still names this
// process. A lock that names a dead process, or none, is removed and the creation retried; one
// that names a live process is polled every 250 ms.
//
// The lock is per process. Callers in one process wait on each other through `held`, so a call
// made from inside the job waits for itself forever.
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { hakutakuDirs } from "./dirs.js";

const POLL_MS = 250;

// The largest pid process.kill accepts.
const MAX_PID = 2 ** 31 - 1;

// Whether this process holds the lock. A lock that names this process's pid while it does not
// was left by an earlier process with the same pid, as successive containers' processes often
// have: kill(pid, 0) would find it alive, and the wait would never end.
let held = false;

export async function withBuildLock<T>(fn: () => Promise<T>): Promise<T> {
  const dir = hakutakuDirs(process.env).data;
  const lock = join(dir, "build.lock");
  mkdirSync(dir, { recursive: true });
  // Each pass runs synchronously up to its sleep, so no other caller in this process acts
  // between a read of the lock and what is done on it.
  while (!tryLock(dir, lock)) {
    if (!breakStale(lock)) await sleep(POLL_MS);
  }
  try {
    return await fn();
  } finally {
    release(lock);
  }
}

// Writes {"pid":<pid>} to a temporary file and links it to the lock's name. The link fails when
// a lock exists, so the lock is created exclusively, and whole: no reader ever finds it empty.
function tryLock(dir: string, lock: string): boolean {
  const tmp = join(dir, `build.tmp-${process.pid}.lock`);
  writeFileSync(tmp, JSON.stringify({ pid: process.pid }));
  try {
    linkSync(tmp, lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(tmp, { force: true });
  }
  held = true;
  return true;
}

// Removes a lock that names no live process. Answers false while a live process holds the lock,
// and true when the lock is gone, so the caller tries again at once.
function breakStale(lock: string): boolean {
  const text = readLock(lock);
  if (text === undefined) return true;
  const pid = pidOf(text);
  if (pid !== null && isAlive(pid)) return false;
  // Only the file just read: a lock that replaced it since names a live process. Another
  // process can still replace it between this read and the unlink, a window of one call.
  if (readLock(lock) === text) {
    try {
      unlinkSync(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return true;
}

// Best effort, so that a failure never replaces the job's answer or its error. A lock it fails
// to remove names this process, which no longer holds it, so the next caller breaks it.
function release(lock: string): void {
  held = false;
  try {
    if (pidOf(readLock(lock) ?? null) === process.pid) unlinkSync(lock);
  } catch {
    // left for the next caller to break
  }
}

function isAlive(pid: number): boolean {
  if (pid === process.pid) return held;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process. EPERM: a live process of another user.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// The pid a lock names: an integer from 1 to MAX_PID, else null. A pid of 0 or -1 would make
// kill(pid, 0) signal a process group or every process, and so always find it alive.
function pidOf(text: string | null): number | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const pid =
    typeof value === "object" && value !== null
      ? (value as { pid?: unknown }).pid
      : undefined;
  return typeof pid === "number" &&
    Number.isInteger(pid) &&
    pid >= 1 &&
    pid <= MAX_PID
    ? pid
    : null;
}

// The lock's text: undefined when there is no lock, null when it is not a regular file or
// cannot be read. It is opened without following a link and without blocking, so a FIFO never
// stalls the read.
function readLock(lock: string): string | null | undefined {
  let fd: number;
  try {
    fd = openSync(
      lock,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? undefined
      : null;
  }
  try {
    return fstatSync(fd).isFile() ? readFileSync(fd, "utf8") : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
