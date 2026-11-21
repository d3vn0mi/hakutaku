import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { MAX_JSON_BYTES } from "../../../src/store/files.js";
import {
  type Attempt,
  type BuildFacts,
  besideStore,
  readAttempt,
  readBuildFacts,
  writeAttempt,
  writeBuildFacts,
} from "../../../src/store/index.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A fresh directory under the OS temp directory, removed after the file's last test.
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-files-"));
  made.push(dir);
  return dir;
};

const attempt: Attempt = {
  at: "2026-01-01T00:00:00Z",
  commit: "a".repeat(40),
  result: "gates-failed",
  reason: "denylist: 1 denylisted path: sim/.env",
};

// Every field, with a null, a number and each engine status where the type allows one.
const facts: BuildFacts = {
  commit: "a".repeat(40),
  ref: "main",
  contentHash: "c".repeat(64),
  startedAt: "2026-01-01T00:00:00Z",
  finishedAt: "2026-01-01T00:00:25Z",
  wallMs: 25000,
  peakRssBytes: null,
  sandbox: "bubblewrap",
  engines: {
    "ast-grep": {
      status: "ran",
      wallMs: 1200,
      cpuMs: 3400,
      peakRssBytes: 104857600,
      exitCode: 0,
    },
    "dependency-cruiser": {
      status: "failed",
      wallMs: 800,
      cpuMs: 900,
      peakRssBytes: null,
      exitCode: 1,
    },
    grimp: {
      status: "fallback",
      wallMs: 0,
      cpuMs: null,
      peakRssBytes: null,
      exitCode: null,
    },
    "scip-typescript": {
      status: "timed-out",
      wallMs: 600000,
      cpuMs: null,
      peakRssBytes: null,
      exitCode: null,
    },
    "scip-python": {
      status: "skipped",
      wallMs: 0,
      cpuMs: null,
      peakRssBytes: null,
      exitCode: null,
    },
  },
  warnings: ["no memory cap: systemd-run is unavailable"],
};

it("reads null for a missing or malformed attempt.json and build.json", () => {
  const path = join(tmp(), "store.sqlite");
  expect(readAttempt(path)).toBeNull();
  expect(readBuildFacts(path)).toBeNull();
  writeFileSync(besideStore(path).attempt, "{");
  expect(readAttempt(path)).toBeNull();
  writeFileSync(besideStore(path).build, "{");
  expect(readBuildFacts(path)).toBeNull();
});

it("round-trips an attempt and build facts through their files", () => {
  const path = join(tmp(), "store.sqlite");
  const a: Attempt = attempt;
  writeAttempt(path, a);
  expect(readAttempt(path)).toEqual(a);
  writeBuildFacts(path, facts);
  expect(readBuildFacts(path)).toEqual(facts);
  // an attempt without a reason
  const built: Attempt = { at: a.at, commit: a.commit, result: "built" };
  writeAttempt(path, built);
  expect(readAttempt(path)).toStrictEqual(built);
});

it("names the files beside a store in its directory", () => {
  const dir = join("data", "observatory");
  const beside = besideStore(join(dir, "store.sqlite"));
  expect({
    dir: beside.dir,
    prev: beside.prev,
    build: beside.build,
    attempt: beside.attempt,
    tmp: beside.tmp(4242),
    work: beside.work(4242),
  }).toEqual({
    dir,
    prev: join(dir, "store.prev.sqlite"),
    build: join(dir, "build.json"),
    attempt: join(dir, "attempt.json"),
    tmp: join(dir, "store.tmp-4242.sqlite"),
    work: join(dir, "work.tmp-4242"),
  });
});

it("reads null for JSON without the shape of its type", () => {
  const path = join(tmp(), "store.sqlite");
  const attempts: unknown[] = [
    null,
    [],
    {},
    { ...attempt, at: undefined },
    { ...attempt, commit: 40 },
    { ...attempt, result: "passed" },
    { ...attempt, reason: null },
  ];
  for (const value of attempts) {
    writeFileSync(besideStore(path).attempt, JSON.stringify(value));
    expect(readAttempt(path), JSON.stringify(value)).toBeNull();
  }
  const ran = facts.engines["ast-grep"];
  const builds: unknown[] = [
    null,
    [],
    { ...facts, warnings: undefined },
    { ...facts, warnings: [1] },
    { ...facts, wallMs: "25000" },
    { ...facts, peakRssBytes: undefined },
    { ...facts, sandbox: "chroot" },
    { ...facts, engines: [] },
    { ...facts, engines: { "scip-go": ran } },
    { ...facts, engines: { grimp: { ...ran, status: "crashed" } } },
    { ...facts, engines: { grimp: { ...ran, exitCode: undefined } } },
  ];
  for (const value of builds) {
    writeFileSync(besideStore(path).build, JSON.stringify(value));
    expect(readBuildFacts(path), JSON.stringify(value)).toBeNull();
  }
});

it("replaces each file by a rename, leaving no temporary file, in a directory it makes", () => {
  const dir = join(tmp(), "observatory");
  const path = join(dir, "store.sqlite");
  writeAttempt(path, attempt);
  writeBuildFacts(path, facts);
  const inodes = [statSync(join(dir, "attempt.json")).ino];
  inodes.push(statSync(join(dir, "build.json")).ino);
  writeAttempt(path, { ...attempt, result: "failed" });
  writeBuildFacts(path, { ...facts, ref: "HEAD" });
  expect(statSync(join(dir, "attempt.json")).ino).not.toBe(inodes[0]);
  expect(statSync(join(dir, "build.json")).ino).not.toBe(inodes[1]);
  expect(readdirSync(dir).sort()).toEqual(["attempt.json", "build.json"]);
  expect(readAttempt(path)?.result).toBe("failed");
  expect(readBuildFacts(path)?.ref).toBe("HEAD");
});

// A read of a FIFO blocks until a writer opens it, which would hang every later call.
it.skipIf(process.platform === "win32")(
  "reads null for an attempt.json or build.json that is not a regular file",
  () => {
    const path = join(tmp(), "store.sqlite");
    execFileSync("mkfifo", [besideStore(path).attempt]);
    execFileSync("mkfifo", [besideStore(path).build]);
    expect(readAttempt(path)).toBeNull();
    expect(readBuildFacts(path)).toBeNull();
    const dir = join(tmp(), "store.sqlite");
    mkdirSync(besideStore(dir).attempt, { recursive: true });
    mkdirSync(besideStore(dir).build, { recursive: true });
    expect(readAttempt(dir)).toBeNull();
    expect(readBuildFacts(dir)).toBeNull();
  },
);

// Only a build writes these files, and never as links: a link in their place is never followed,
// whatever it names.
it.skipIf(process.platform === "win32")(
  "reads null for an attempt.json or build.json that is a link, even to a valid file",
  () => {
    const elsewhere = join(tmp(), "store.sqlite");
    writeAttempt(elsewhere, attempt);
    writeBuildFacts(elsewhere, facts);
    expect(readAttempt(elsewhere)).toEqual(attempt);
    const path = join(tmp(), "store.sqlite");
    symlinkSync(besideStore(elsewhere).attempt, besideStore(path).attempt);
    symlinkSync(besideStore(elsewhere).build, besideStore(path).build);
    expect(readAttempt(path)).toBeNull();
    expect(readBuildFacts(path)).toBeNull();
  },
);

it("reads null for a file larger than the limit, however valid its JSON", () => {
  const path = join(tmp(), "store.sqlite");
  const text = JSON.stringify(attempt);
  // JSON allows whitespace after the value
  writeFileSync(
    besideStore(path).attempt,
    text.padEnd(MAX_JSON_BYTES + 1, " "),
  );
  expect(readAttempt(path)).toBeNull();
  writeFileSync(besideStore(path).attempt, text.padEnd(MAX_JSON_BYTES, " "));
  expect(readAttempt(path)).toEqual(attempt);
});

it.skipIf(process.platform === "win32")(
  "writes each file without following a link at its temporary name",
  () => {
    const dir = tmp();
    const path = join(dir, "store.sqlite");
    const canary = join(tmp(), "canary.txt");
    writeFileSync(canary, "canary\n");
    symlinkSync(canary, join(dir, `attempt.tmp-${process.pid}.json`));
    symlinkSync(canary, join(dir, `build.tmp-${process.pid}.json`));
    writeAttempt(path, attempt);
    writeBuildFacts(path, facts);
    expect(readFileSync(canary, "utf8")).toBe("canary\n");
    expect(readAttempt(path)).toEqual(attempt);
    expect(readBuildFacts(path)).toEqual(facts);
    expect(readdirSync(dir).sort()).toEqual(["attempt.json", "build.json"]);
  },
);
