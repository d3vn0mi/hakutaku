import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterAll, expect, it } from "vitest";
import { removeTree } from "../../../src/export/index.js";
import { cleanupStale, markStage, swapIn } from "../../../src/extract/swap.js";
import {
  openStore,
  readAttempt,
  writeStore,
} from "../../../src/store/index.js";
import { emptyContent } from "../../helpers/mini-store.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) removeTree(dir);
});

// A fresh directory under the OS temp directory, removed after the file's last test.
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-swap-"));
  made.push(dir);
  return dir;
};

const A = "a".repeat(40);
const commitOf = (n: number): string => n.toString(16).padStart(40, "0");

// Writes a store whose meta names commit.
function storeAt(path: string, commit: string): void {
  const content = emptyContent();
  writeStore(path, {
    ...content,
    meta: content.meta.map((row) => ({ ...row, commit_sha: commit })),
  });
}

function commitIn(path: string): string {
  const store = openStore(path);
  if ("code" in store) throw new Error(`${path}: ${store.reason}`);
  store.close();
  return store.meta.commit;
}

// Every temporary name a build with this pid can leave in a store directory.
const tempNames = (pid: number): string[] => [
  `attempt.tmp-${pid}.json`,
  `build.tmp-${pid}.json`,
  `store.prev.tmp-${pid}.sqlite`,
  `store.tmp-${pid}.sqlite`,
  `store.tmp-${pid}.sqlite-journal`,
  `work.tmp-${pid}`,
];

// Leaves each of them in dir. The work directory holds an engine's output in a read-only
// directory, which a plain recursive removal could not empty.
function leaveTemps(dir: string, pid: number): void {
  for (const name of tempNames(pid)) {
    if (name.startsWith("work.")) {
      const out = join(dir, name, "tmp", "out");
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "index.scip"), "");
      chmodSync(out, 0o555);
    } else {
      writeFileSync(join(dir, name), "");
    }
  }
}

// In a worker thread: polls existsSync(store) in a tight loop, from its first message until the
// main thread sets flags[0], then posts how often it polled and how often the store was missing.
const POLLER = `
const { parentPort, workerData } = require("node:worker_threads");
const { existsSync } = require("node:fs");
const flags = new Int32Array(workerData.flags);
let polls = 0;
let missing = 0;
parentPort.postMessage("polling");
while (Atomics.load(flags, 0) === 0) {
  polls++;
  if (!existsSync(workerData.store)) missing++;
}
parentPort.postMessage({ polls, missing });
`;

it("keeps the previous store and never leaves the path missing", async () => {
  const dir = tmp();
  const store = join(dir, "store.sqlite");
  storeAt(store, commitOf(0));
  const next = Array.from({ length: 50 }, (_, i) => {
    const path = join(dir, `next-${i + 1}.sqlite`);
    storeAt(path, commitOf(i + 1));
    return path;
  });
  const flags = new SharedArrayBuffer(4);
  const worker = new Worker(POLLER, {
    eval: true,
    workerData: { store, flags },
  });
  try {
    await once(worker, "message"); // polling
    const finished = once(worker, "message");
    for (const path of next) swapIn(path, store);
    Atomics.store(new Int32Array(flags), 0, 1);
    const [{ polls, missing }] = (await finished) as [
      { polls: number; missing: number },
    ];
    expect(missing).toBe(0);
    expect(polls).toBeGreaterThan(0);
  } finally {
    await worker.terminate();
  }
  expect(commitIn(store)).toBe(commitOf(50));
  expect(commitIn(join(dir, "store.prev.sqlite"))).toBe(commitOf(49));
  expect(readdirSync(dir).sort()).toEqual([
    "store.prev.sqlite",
    "store.sqlite",
  ]);
});

it("renames the new store into place when there is no current store", () => {
  const dir = tmp();
  const store = join(dir, "store.sqlite");
  storeAt(join(dir, "next.sqlite"), commitOf(1));
  swapIn(join(dir, "next.sqlite"), store);
  expect(commitIn(store)).toBe(commitOf(1));
  expect(readdirSync(dir)).toEqual(["store.sqlite"]);
});

it("refuses a new store that does not exist, leaving the current and previous stores as they were", () => {
  const dir = tmp();
  const store = join(dir, "store.sqlite");
  storeAt(store, commitOf(0));
  storeAt(join(dir, "next.sqlite"), commitOf(1));
  swapIn(join(dir, "next.sqlite"), store);
  expect(() => swapIn(join(dir, "missing.sqlite"), store)).toThrow(/ENOENT/);
  expect(commitIn(store)).toBe(commitOf(1));
  expect(commitIn(join(dir, "store.prev.sqlite"))).toBe(commitOf(0));
  expect(readdirSync(dir).sort()).toEqual([
    "store.prev.sqlite",
    "store.sqlite",
  ]);
});

it("replaces a link name that an earlier process with this pid left", () => {
  const dir = tmp();
  const store = join(dir, "store.sqlite");
  storeAt(store, commitOf(0));
  writeFileSync(join(dir, `store.prev.tmp-${process.pid}.sqlite`), "left");
  storeAt(join(dir, "next.sqlite"), commitOf(1));
  swapIn(join(dir, "next.sqlite"), store);
  expect(commitIn(store)).toBe(commitOf(1));
  expect(commitIn(join(dir, "store.prev.sqlite"))).toBe(commitOf(0));
  expect(readdirSync(dir).sort()).toEqual([
    "store.prev.sqlite",
    "store.sqlite",
  ]);
});

it("removes a dead pid's temporary files and keeps a live one's", () => {
  const dir = tmp();
  const dead = spawnSync(process.execPath, ["-e", ""]).pid; // a child that has exited
  const live = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
  });
  try {
    const livePid = live.pid ?? 0;
    expect(livePid).toBeGreaterThan(0);
    leaveTemps(dir, dead);
    leaveTemps(dir, livePid);
    // names no build writes: kept whatever their number says
    const others = [
      "store.sqlite",
      "store.prev.sqlite",
      "attempt.json",
      "build.json",
      "notes.txt",
      "work.tmp-",
      "store.tmp-0.sqlite",
      `store.tmp-0${dead}.sqlite`,
      "store.tmp-12x.sqlite",
      "store.tmp-99999999999.sqlite",
      "attempt.tmp-1.sqlite",
    ];
    for (const name of others) writeFileSync(join(dir, name), "");
    cleanupStale(dir);
    expect(readdirSync(dir).sort()).toEqual(
      [...tempNames(livePid), ...others].sort(),
    );
  } finally {
    live.kill("SIGKILL");
  }
});

it("removes the temporary files named with this process's own pid, which an earlier process left", () => {
  const dir = tmp();
  leaveTemps(dir, process.pid);
  cleanupStale(dir);
  expect(readdirSync(dir)).toEqual([]);
});

it("writes a provisional failed attempt for a stage", () => {
  const store = join(tmp(), "store.sqlite");
  markStage(store, A, "writing the store");
  expect(readAttempt(store)).toMatchObject({
    commit: A,
    result: "failed",
    reason: `interrupted or still running (pid ${process.pid}): writing the store`,
  });
});

it("replaces the provisional attempt at each stage, stamped in UTC", () => {
  const store = join(tmp(), "store.sqlite");
  markStage(store, A, "running ast-grep");
  markStage(store, A, "checking the gates");
  const attempt = readAttempt(store);
  expect(attempt?.reason).toBe(
    `interrupted or still running (pid ${process.pid}): checking the gates`,
  );
  expect(attempt?.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});
