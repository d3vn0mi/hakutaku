// The observatory sample's generator, fixtures/observatory/make.mjs, with git alone and no
// engine: the repository it writes is the same on every run, its size and history are what the
// sample promises, its two assembled files hold values that no file of hakutaku's tree holds,
// and its last commit holds exactly tree/.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { findSecrets } from "../../../src/redact/index.js";
import { git } from "../../helpers/git.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SAMPLE = join(ROOT, "fixtures", "observatory");
const TREE = join(SAMPLE, "tree");
const MAKE_TIMEOUT = 120_000;

const CLIENT = "web/src/api/ephemeris-client.ts";
const ENV_FILE = "sim/.env";
const PLACEHOLDER = "__OBS_FAKE_KEY__";
const SUFFIX = ".fixture";
const HEAD_TIME = Date.parse("2026-09-01T12:00:00Z") / 1000;
const WEEKS_26 = 26 * 7 * 86_400;
const DAYS_180 = 180 * 86_400;

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// make.mjs run into a fresh directory: the repository it wrote, and what it printed.
function make(): { repo: string; printed: string } {
  const out = mkdtempSync(join(tmpdir(), "hakutaku-sample-"));
  made.push(out);
  const printed = execFileSync(
    process.execPath,
    [join(SAMPLE, "make.mjs"), out],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return { repo: join(out, "observatory"), printed };
}

let sample: { repo: string; printed: string };
beforeAll(() => {
  sample = make();
}, MAKE_TIMEOUT);

// The files under a directory, as paths relative to it with "/" separators, sorted.
function filesUnder(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnder(dir, path));
    else out.push(path);
  }
  return out.sort();
}

// The blob id git gives these bytes.
const blobId = (bytes: Uint8Array): string =>
  createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");

// The files of hakutaku's own tree: what git tracks, and untracked files .gitignore keeps.
function hakutakuFiles(): string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  return [...new Set(out.split("\0").filter((p) => p !== ""))];
}

// The fake key the client holds in the repository, and the value its .env assigns.
function assembled(repo: string): { key: string; envValue: string } {
  const client = git(repo, "show", `main:${CLIENT}`);
  const key = /\bapi_key: "([^"]+)"/.exec(client)?.[1];
  const envValue = /^EPHEMERIS_UPSTREAM_TOKEN=(\S+)$/m.exec(
    git(repo, "show", `main:${ENV_FILE}`),
  )?.[1];
  if (key === undefined || envValue === undefined) {
    throw new Error("the sample holds no assembled key or .env value");
  }
  return { key, envValue };
}

it(
  "is the same repo on every run",
  () => {
    expect(sample.printed).toMatch(/^[0-9a-f]{40}\n$/);
    expect(git(sample.repo, "rev-parse", "HEAD")).toBe(sample.printed.trim());
    expect(make().printed).toBe(sample.printed);
  },
  MAKE_TIMEOUT,
);

it("has 120 to 200 files, 30 or more commits over more than 26 weeks, and the rename", () => {
  const { repo } = sample;
  const files = git(repo, "ls-files").split("\n");
  expect(files.length).toBeGreaterThanOrEqual(120);
  expect(files.length).toBeLessThanOrEqual(200);

  // committer times, newest first
  const times = git(repo, "log", "--format=%ct", "main")
    .split("\n")
    .map(Number);
  expect(times.length).toBeGreaterThanOrEqual(30);
  expect(times[0]).toBe(HEAD_TIME);
  expect(times[0] - (times.at(-1) ?? times[0])).toBeGreaterThan(WEEKS_26);

  // exactly one rename in the whole history, within 180 days before the head
  const renames = git(
    repo,
    "log",
    "-M",
    "--diff-filter=R",
    "--name-status",
    "--format=commit %H %ct",
    "main",
  )
    .split("\n")
    .filter((line) => line !== "");
  expect(renames).toHaveLength(2);
  const [, sha, time] = renames[0]?.split(" ") ?? [];
  expect(renames[1]).toMatch(
    /^R\d+\tweb\/src\/orbits\/orbit\.ts\tweb\/src\/orbits\/kepler\.ts$/,
  );
  expect(HEAD_TIME - Number(time)).toBeLessThanOrEqual(DAYS_180);

  // The files that import kepler.ts in the rename commit import orbit.ts, under that name,
  // in the commit before it, and no file names kepler there.
  const importers = (rev: string, name: string): string[] => {
    const r = spawnSync(
      "git",
      [
        "grep",
        "-l",
        "-E",
        `["'](\\./|\\.\\./)+(orbits/)?${name}["']`,
        rev,
        "--",
        "web",
      ],
      { cwd: repo, encoding: "utf8" },
    );
    // git grep exits 1 when nothing matches
    if (r.status !== 0 && r.status !== 1) throw new Error(r.stderr);
    return r.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.slice(rev.length + 1))
      .sort();
  };
  const before = importers(`${sha}^`, "orbit");
  expect(before.length).toBeGreaterThan(0);
  expect(importers(`${sha}^`, "kepler")).toEqual([]);
  expect(importers(sha as string, "kepler")).toEqual(
    expect.arrayContaining(before),
  );
  expect(importers(sha as string, "orbit")).toEqual([]);
});

it("holds the assembled .env and secret in the repo, and neither in hakutaku's tree", () => {
  const { repo } = sample;
  expect(git(repo, "ls-files", "--", ENV_FILE)).toBe(ENV_FILE);
  const client = git(repo, "show", `main:${CLIENT}`);
  expect(client).not.toContain(PLACEHOLDER);
  // the key is a secret by the redaction rules, found once, on its own line
  const { key, envValue } = assembled(repo);
  const keyLine = client.split("\n").findIndex((l) => l.includes(key)) + 1;
  expect(findSecrets(client)).toEqual([
    { line: keyLine, rule: "assigned-secret" },
  ]);

  const holders: string[] = [];
  for (const path of hakutakuFiles()) {
    const abs = join(ROOT, path);
    let isFile = false;
    try {
      isFile = lstatSync(abs).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) continue;
    const text = readFileSync(abs, "latin1");
    if (text.includes(key) || text.includes(envValue)) holders.push(path);
  }
  expect(holders).toEqual([]);
});

it("has HEAD's content equal to tree/ apart from the two assembled files", () => {
  const { repo } = sample;
  const { key } = assembled(repo);
  // mode, type, blob and path of each of HEAD's files
  const head = new Map<string, { mode: string; blob: string }>();
  for (const entry of git(repo, "ls-tree", "-r", "-z", "main").split("\0")) {
    if (entry === "") continue;
    const [info = "", path = ""] = entry.split("\t");
    const [mode = "", , blob = ""] = info.split(" ");
    head.set(path, { mode, blob });
  }
  // tree/ holds the dependency manifests with the suffix ".fixture", HEAD by their real names
  const tree = filesUnder(TREE);
  const realName = (path: string): string =>
    path.endsWith(SUFFIX) ? path.slice(0, -SUFFIX.length) : path;
  expect([...head.keys()].filter((p) => p !== ENV_FILE).sort()).toEqual(
    tree.map(realName).sort(),
  );
  expect(head.has(ENV_FILE)).toBe(true);

  const differing: string[] = [];
  for (const path of tree) {
    let bytes: Uint8Array = readFileSync(join(TREE, path));
    if (path === CLIENT) {
      const text = Buffer.from(bytes).toString("utf8");
      expect(text.split(PLACEHOLDER)).toHaveLength(2);
      bytes = Buffer.from(text.replace(PLACEHOLDER, key), "utf8");
    }
    if (head.get(realName(path))?.blob !== blobId(bytes)) differing.push(path);
  }
  expect(differing).toEqual([]);
  // modes come from the fixed list: only scripts/sync-sky.sh is executable
  const executable = [...head]
    .filter(([, { mode }]) => mode === "100755")
    .map(([path]) => path);
  expect(executable).toEqual(["scripts/sync-sky.sh"]);
  expect(
    [...head.values()].every((e) => e.mode === "100644" || e.mode === "100755"),
  ).toBe(true);
});
