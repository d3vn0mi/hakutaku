import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { hakutakuDirs, withBuildLock } from "../../../src/registry/index.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Each test points the XDG variables at a fresh root under the OS temp directory, with its data
// directory made; afterEach restores them.
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "hakutaku-lock-"));
  made.push(root);
  vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
  mkdirSync(hakutakuDirs().data, { recursive: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const lockFile = (): string => join(hakutakuDirs().data, "build.lock");

// The pid of a child that has exited and been reaped.
const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid;

// A test that would wait forever if the lock were not broken fails within this many ms.
const SHORT = 5000;

it("runs two callers one after the other", async () => {
  const spans: Array<[number, number]> = [];
  const job = () =>
    withBuildLock(async () => {
      const s = Date.now();
      await sleep(300);
      spans.push([s, Date.now()]);
    });
  await Promise.all([job(), job()]);
  expect(spans[1][0]).toBeGreaterThanOrEqual(spans[0][1]);
});

it("breaks the lock of a dead pid", async () => {
  writeFileSync(lockFile(), JSON.stringify({ pid: deadPid() })); // a child that has exited
  await expect(withBuildLock(async () => 7)).resolves.toBe(7);
});

it("releases the lock when the job throws", async () => {
  await expect(
    withBuildLock(async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(existsSync(lockFile())).toBe(false);
});

it('holds {"pid":<pid>} in <data>/build.lock while the job runs, in a data directory it makes', async () => {
  rmSync(hakutakuDirs().data, { recursive: true });
  const held = await withBuildLock(async () =>
    readFileSync(lockFile(), "utf8"),
  );
  expect(held).toBe(`{"pid":${process.pid}}`);
  expect(readdirSync(hakutakuDirs().data)).toEqual([]);
});

it("waits while a live process holds the lock, and starts once it is gone", async () => {
  const holder = `{"pid":${process.ppid}}`; // the test runner, alive
  writeFileSync(lockFile(), holder);
  let started = 0;
  const run = withBuildLock(async () => {
    started = Date.now();
  });
  await sleep(600);
  expect(started).toBe(0);
  expect(readFileSync(lockFile(), "utf8")).toBe(holder);
  const freed = Date.now();
  rmSync(lockFile());
  await run;
  expect(started).toBeGreaterThanOrEqual(freed);
});

it(
  "breaks a lock left by an earlier process that had this process's pid",
  async () => {
    writeFileSync(lockFile(), JSON.stringify({ pid: process.pid }));
    await expect(withBuildLock(async () => 7)).resolves.toBe(7);
  },
  SHORT,
);

it.each([
  "",
  "not json",
  "{}",
  '{"pid":0}',
  '{"pid":-1}',
  '{"pid":1.5}',
  '{"pid":"7"}',
  '{"pid":4294967296}',
])(
  "breaks a lock that holds %j, which names no process",
  async (text) => {
    writeFileSync(lockFile(), text);
    await expect(
      withBuildLock(async () => readFileSync(lockFile(), "utf8")),
    ).resolves.toBe(`{"pid":${process.pid}}`);
  },
  SHORT,
);

it(
  "breaks a lock that is a FIFO or a symbolic link, without reading or following it",
  async () => {
    execFileSync("mkfifo", [lockFile()]);
    await expect(withBuildLock(async () => 7)).resolves.toBe(7);
    symlinkSync("nowhere", lockFile());
    await expect(withBuildLock(async () => 8)).resolves.toBe(8);
  },
  SHORT,
);

it("leaves a lock in place that no longer names this process", async () => {
  const other = `{"pid":${process.ppid}}`;
  await withBuildLock(async () => {
    writeFileSync(lockFile(), other);
  });
  expect(readFileSync(lockFile(), "utf8")).toBe(other);
});
