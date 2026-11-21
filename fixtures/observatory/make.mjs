#!/usr/bin/env node
// make.mjs: writes the observatory sample, a small synthetic project, as a git repository.
//
//   node fixtures/observatory/make.mjs <outDir>
//
// It writes the repository <outDir>/observatory/ and prints the commit its main branch ends at,
// then a newline. tree/ holds every file as the last commit has it, and history.mjs lists the
// commits that build the files up: each adds files from tree/, touches files already there, or
// renames one.
//
// Touches. A touch toggles a trailing line: "// churn" in TypeScript and JavaScript, "# churn"
// in Python and shell, an empty line in any other file. history.mjs touches each file an even
// number of times, so the last commit holds tree/'s content; this script checks that it does.
//
// The rename. history.mjs adds web/src/orbits/orbit.ts, which holds tree/'s kepler.ts, and one
// commit renames it to kepler.ts. Until that commit, every file importing it names it ./orbit
// or ../orbits/orbit; the rename commit rewrites each such file with tree/'s text.
//
// Put together at run time. sim/.env, which every analysis must leave out, and the api_key
// value in web/src/api/ephemeris-client.ts are joined here from fixed parts, so that no file of
// hakutaku's tree holds either value whole; tree/ holds the placeholder __OBS_FAKE_KEY__ where
// the value goes. A secret scan of the repository finds them, and hakutaku's own scan of
// hakutaku finds neither.
//
// Held under another name. tree/ holds the sample's three dependency manifests,
// web/package.json, sim/requirements.txt and sim/pyproject.toml, with the suffix ".fixture", so
// that GitHub's dependency graph does not read them, with their deliberately old pins, as
// hakutaku's own. history.mjs names each by its real name, and this script writes it there.
//
// Determinism. Two runs give the same commits on any machine: git runs with no system or global
// config, no templates and an explicit -c for each setting this script relies on; the author
// and committer are Sample Author <sample@example.invalid>, with each commit's fixed date; and
// file modes come from a fixed list.
//
// <outDir> may be missing, and is then made; <outDir>/observatory must not exist.
// Exit codes: 0 done; 1 a failure, with the reason on stderr; 2 a usage error.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMITS } from "./history.mjs";

const TREE = fileURLToPath(new URL("./tree/", import.meta.url));
const HEAD_DATE = "2026-09-01T12:00:00Z";
const AUTHOR_NAME = "Sample Author";
const AUTHOR_EMAIL = "sample@example.invalid";
// The only executable file; every other file is 100644.
const EXECUTABLE = new Set(["scripts/sync-sky.sh"]);
const RENAME = ["web/src/orbits/orbit.ts", "web/src/orbits/kepler.ts"];
const CLIENT = "web/src/api/ephemeris-client.ts";
const ENV_FILE = "sim/.env";
const PLACEHOLDER = "__OBS_FAKE_KEY__";
// The manifests, each held in tree/ with the suffix.
const MANIFESTS = new Set(["sim/pyproject.toml", "sim/requirements.txt", "web/package.json"]);
const SUFFIX = ".fixture";

// The two fake values, each joined from parts that are not one whole value anywhere in this
// tree.
const FAKE_KEY = ["obs", "Zq4tR9", "vWm2Lx", "K7pDh3", "NcY8bF"].join("");
const FAKE_UPSTREAM = ["Hx7Lq2", "Vn9TbR", "4kWc8D", "zM3pY"].join("");
const ENV_TEXT = [
  "# Local settings for the ephemeris service.",
  "EPHEMERIS_PORT=8080",
  "EPHEMERIS_CACHE_DIR=/var/cache/observatory",
  "EPHEMERIS_UPSTREAM_URL=https://ephemeris.example.org/v1",
  `EPHEMERIS_UPSTREAM_TOKEN=${FAKE_UPSTREAM}`,
  "",
].join("\n");

// The trailing line a touch toggles, by file name.
const CHURN = [
  [/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, "// churn\n"],
  [/\.(py|sh|bash)$/, "# churn\n"],
];
const churnLine = (path) => CHURN.find(([re]) => re.test(path))?.[1] ?? "\n";

// A quoted relative specifier that names kepler, as "./kepler" or "../orbits/kepler": before the
// rename, it names orbit.
const KEPLER_SPECIFIER = /(["'])((?:\.\.?\/)+(?:orbits\/)?)kepler\1/g;

const GIT_CONFIG = [
  "-c",
  "init.defaultBranch=main",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.fileMode=true",
  "-c",
  "gc.auto=0",
];
const GIT_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: "/nonexistent",
  LANG: "C",
  LC_ALL: "C",
  TZ: "UTC",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: AUTHOR_NAME,
  GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
  GIT_COMMITTER_NAME: AUTHOR_NAME,
  GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
};

class UsageError extends Error {}

function fail(message) {
  throw new Error(message);
}

// git in the repository, with the commit date when one is given; its standard output.
function git(repo, args, date) {
  const env =
    date === undefined
      ? GIT_ENV
      : { ...GIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const r = spawnSync("git", [...GIT_CONFIG, ...args], {
    cwd: repo,
    env,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  if (r.error !== undefined || r.status !== 0) {
    fail(`git ${args.join(" ")}: ${r.error?.message ?? r.stderr.trim()}`);
  }
  return r.stdout.trim();
}

// The files under tree/, as paths with "/" separators, sorted.
function storedFiles(prefix = "") {
  const out = [];
  for (const entry of readdirSync(join(TREE, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...storedFiles(path));
    else if (entry.isFile()) out.push(path);
    else fail(`tree/${path} is neither a file nor a directory`);
  }
  return out.sort();
}

// The files under tree/ as the commits name them, each manifest by its real name, sorted.
function treeFiles() {
  const out = [];
  for (const path of storedFiles()) {
    if (MANIFESTS.has(path)) fail(`tree/ must hold ${path} as ${path}${SUFFIX}`);
    const real = path.endsWith(SUFFIX) ? path.slice(0, -SUFFIX.length) : path;
    if (real !== path && !MANIFESTS.has(real)) {
      fail(`tree/${path} is not one of the manifests this script writes back`);
    }
    out.push(real);
  }
  return out.sort();
}

// The file under tree/ that holds a path: the path, with the suffix for a manifest.
const storedAs = (path) => (MANIFESTS.has(path) ? `${path}${SUFFIX}` : path);

// The file under tree/ whose text a path holds: tree/'s kepler.ts for orbit.ts.
const sourceOf = (path) => storedAs(path === RENAME[0] ? RENAME[1] : path);

// A file's text as a commit holds it: tree/'s, with the fake key in place of the placeholder,
// and with orbit for kepler in its specifiers until the rename.
function textOf(path, renamed) {
  if (path === ENV_FILE) return ENV_TEXT;
  let text = readFileSync(join(TREE, sourceOf(path)), "utf8");
  if (path === CLIENT) text = text.replace(PLACEHOLDER, FAKE_KEY);
  return renamed ? text : text.replace(KEPLER_SPECIFIER, "$1$2orbit$1");
}

// git's date for an ISO 8601 UTC time: seconds since the epoch, at UTC.
function gitDate(iso) {
  const ms = Date.parse(iso);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(iso) || Number.isNaN(ms)) {
    fail(`not a UTC time: ${iso}`);
  }
  return `@${ms / 1000} +0000`;
}

// The checks history.mjs and tree/ must pass before anything is written.
function checkInputs(files) {
  const withPlaceholder = files.filter((path) =>
    readFileSync(join(TREE, storedAs(path)), "utf8").includes(PLACEHOLDER),
  );
  const placeholders = readFileSync(join(TREE, CLIENT), "utf8").split(PLACEHOLDER).length - 1;
  if (withPlaceholder.join() !== CLIENT || placeholders !== 1) {
    fail(`tree/ must hold ${PLACEHOLDER} once, in ${CLIENT}`);
  }
  if (files.includes(ENV_FILE) || files.includes(RENAME[0])) {
    fail(`tree/ must not hold ${ENV_FILE} or ${RENAME[0]}`);
  }
  let last = 0;
  for (const commit of COMMITS) {
    const time = Date.parse(commit.date);
    gitDate(commit.date);
    if (!(time > last)) fail(`commits out of date order at ${commit.date}`);
    last = time;
    if (typeof commit.message !== "string" || commit.message === "") {
      fail(`the commit of ${commit.date} has no message`);
    }
  }
  if (COMMITS.at(-1)?.date !== HEAD_DATE) fail(`the last commit must be dated ${HEAD_DATE}`);
}

// Applies one commit's rename, adds and touches to the work tree.
function apply(repo, commit, state) {
  const write = (path) => {
    const file = join(repo, path);
    mkdirSync(dirname(file), { recursive: true });
    const churn = state.churned.get(path) ? churnLine(path) : "";
    writeFileSync(file, textOf(path, state.renamed) + churn);
    chmodSync(file, EXECUTABLE.has(path) ? 0o755 : 0o644);
  };
  if (commit.rename !== undefined) {
    const [from, to] = commit.rename;
    if (from !== RENAME[0] || to !== RENAME[1] || state.renamed) {
      fail(`the only rename is ${RENAME[0]} to ${RENAME[1]}, once`);
    }
    if (!state.churned.has(from) || state.churned.has(to)) {
      fail(`cannot rename ${from} to ${to} at ${commit.date}`);
    }
    renameSync(join(repo, from), join(repo, to));
    state.churned.set(to, state.churned.get(from));
    state.churned.delete(from);
    state.renamed = true;
    for (const path of state.churned.keys()) {
      if (textOf(path, false) !== textOf(path, true)) write(path);
    }
  }
  for (const path of commit.add ?? []) {
    if (state.churned.has(path)) fail(`${path} is added twice`);
    if (path !== ENV_FILE && !existsSync(join(TREE, sourceOf(path)))) {
      fail(`${path} is not in tree/`);
    }
    state.churned.set(path, false);
    write(path);
  }
  for (const path of commit.touch ?? []) {
    if (!state.churned.has(path)) fail(`${path} is touched at ${commit.date} before it is added`);
    state.churned.set(path, !state.churned.get(path));
    write(path);
  }
}

function make(outDir) {
  const files = treeFiles();
  checkInputs(files);
  const repo = join(outDir, "observatory");
  if (existsSync(repo)) throw new UsageError(`${repo} already exists`);
  mkdirSync(repo, { recursive: true });
  try {
    git(repo, ["init", "--quiet", "--template=", "."]);
    const state = { churned: new Map(), renamed: false };
    for (const commit of COMMITS) {
      apply(repo, commit, state);
      git(repo, ["add", "--all", "--force", "--", "."]);
      git(repo, ["commit", "--quiet", "--no-verify", "-m", commit.message], gitDate(commit.date));
    }
    const expected = [...files, ENV_FILE].sort();
    const present = [...state.churned.keys()].sort();
    if (!state.renamed || present.join("\n") !== expected.join("\n")) {
      fail("the last commit does not hold exactly tree/ and sim/.env");
    }
    const odd = present.filter((path) => state.churned.get(path));
    if (odd.length > 0) fail(`touched an odd number of times: ${odd.join(", ")}`);
    return git(repo, ["rev-parse", "HEAD"]);
  } catch (error) {
    rmSync(repo, { recursive: true, force: true });
    throw error;
  }
}

const args = process.argv.slice(2);
try {
  if (args.length !== 1 || args[0] === "") throw new UsageError("give exactly one <outDir>");
  const outDir = resolve(args[0]);
  if (existsSync(outDir) && !statSync(outDir).isDirectory()) {
    throw new UsageError(`${outDir} is not a directory`);
  }
  process.stdout.write(`${make(outDir)}\n`);
} catch (error) {
  process.stderr.write(`make.mjs: ${error instanceof Error ? error.message : error}\n`);
  if (error instanceof UsageError) {
    process.stderr.write("usage: node fixtures/observatory/make.mjs <outDir>\n");
    process.exit(2);
  }
  process.exit(1);
}
