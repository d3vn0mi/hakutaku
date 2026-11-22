#!/usr/bin/env node
// bigfile.mjs: writes the big-file sample, a small git repository whose files stretch the
// viewer's source view.
//
//   node test/e2e/fixtures/bigfile.mjs <outDir>
//
// It writes the repository <outDir>/bigfile/ in one commit and prints that commit, then a
// newline. Its files:
// - package.json;
// - src/big.ts, 6,000 lines: `export function target(n: number): number` at line 10, a block
//   comment over lines 499 to 503, `function caller()` at line 2990 calling target(1) at line
//   3000, and at line 4000 a line of 5,000 characters, a string literal. That is the longest line
//   the export keeps the text of: in a file over 10,000 bytes, a longer line marks the file as
//   minified, and the store holds no source for it;
// - src/huge.js, 1.2 MB of plain statements: over the 1 MiB source cap, so it is stored without
//   source;
// - src/crlf.ts, 20 lines that end in CRLF;
// - src/empty.ts, 0 bytes.
//
// Determinism. git runs with no system or global config, no templates and an explicit -c for
// each setting this script relies on (core.autocrlf=false keeps the CRLF endings as written); the
// author and committer are Sample Author <sample@example.invalid>, and both dates are
// 2026-01-05T12:00:00Z. Two runs give the same commit on any machine.
//
// <outDir> may be missing, and is then made; <outDir>/bigfile must not exist.
// Exit codes: 0 done; 1 a failure, with the reason on stderr; 2 a usage error.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const DATE = "2026-01-05T12:00:00Z";
const AUTHOR_NAME = "Sample Author";
const AUTHOR_EMAIL = "sample@example.invalid";
const BIG_LINES = 6000;
const LONG_LINE_CHARS = 5000;
const HUGE_BYTES = 1_200_000;

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
  GIT_AUTHOR_DATE: DATE,
  GIT_COMMITTER_DATE: DATE,
};

class UsageError extends Error {}

function git(repo, args) {
  const r = spawnSync("git", [...GIT_CONFIG, ...args], {
    cwd: repo,
    env: GIT_ENV,
    encoding: "utf8",
  });
  if (r.error !== undefined || r.status !== 0) {
    throw new Error(
      `git ${args.join(" ")}: ${r.error?.message ?? r.stderr.trim()}`,
    );
  }
  return r.stdout.trim();
}

// big.ts's lines, numbered from 1: every line not named here adds its own number to a total, so
// the file holds no definition or call beyond the ones the viewer's tests look for.
function bigLines() {
  const named = new Map([
    [
      1,
      "// A long file for the source view: definitions, a comment and a call far apart.",
    ],
    [2, "let total = 0;"],
    [10, "export function target(n: number): number {"],
    [11, "  return n + total;"],
    [12, "}"],
    [499, "/*"],
    [500, " * A block comment over five lines, from line 499 to line 503,"],
    [501, " * so that it runs across the end of the first 500 lines."],
    [502, " * Its middle lines are comment text too."],
    [503, " */"],
    [2990, "function caller(): number {"],
    [3000, "  return target(1);"],
    [3001, "}"],
  ]);
  const prefix = 'export const longLine = "';
  const suffix = '";';
  named.set(
    4000,
    `${prefix}${"a".repeat(LONG_LINE_CHARS - prefix.length - suffix.length)}${suffix}`,
  );
  const lines = [];
  for (let n = 1; n <= BIG_LINES; n++) {
    const inCaller = n > 2990 && n < 3000;
    lines.push(
      named.get(n) ?? (inCaller ? `  total += ${n};` : `total += ${n};`),
    );
  }
  if (lines[3999].length !== LONG_LINE_CHARS)
    throw new Error("line 4000 has the wrong length");
  return `${lines.join("\n")}\n`;
}

function hugeText() {
  const lines = [];
  let bytes = 0;
  for (let n = 0; bytes < HUGE_BYTES; n++) {
    const line = `count = count + ${n};\n`;
    lines.push(line);
    bytes += line.length;
  }
  return `var count = 0;\n${lines.join("")}`;
}

function crlfText() {
  const lines = [];
  for (let n = 1; n <= 20; n++) lines.push(`export const line${n} = ${n};\r\n`);
  return lines.join("");
}

const FILES = {
  "package.json": `${JSON.stringify({ name: "bigfile", version: "0.0.0", private: true, type: "module" }, null, 2)}\n`,
  "src/big.ts": bigLines(),
  "src/huge.js": hugeText(),
  "src/crlf.ts": crlfText(),
  "src/empty.ts": "",
};

function make(outDir) {
  const repo = join(outDir, "bigfile");
  if (existsSync(repo)) throw new UsageError(`${repo} already exists`);
  mkdirSync(repo, { recursive: true });
  try {
    git(repo, ["init", "--quiet", "--template=", "."]);
    for (const [path, text] of Object.entries(FILES)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
    git(repo, ["add", "--all", "--force", "--", "."]);
    git(repo, [
      "commit",
      "--quiet",
      "--no-verify",
      "-m",
      "Add the big-file sample",
    ]);
    return git(repo, ["rev-parse", "HEAD"]);
  } catch (error) {
    rmSync(repo, { recursive: true, force: true });
    throw error;
  }
}

const args = process.argv.slice(2);
try {
  if (args.length !== 1 || args[0] === "")
    throw new UsageError("give exactly one <outDir>");
  const outDir = resolve(args[0]);
  if (existsSync(outDir) && !statSync(outDir).isDirectory()) {
    throw new UsageError(`${outDir} is not a directory`);
  }
  process.stdout.write(`${make(outDir)}\n`);
} catch (error) {
  process.stderr.write(
    `bigfile.mjs: ${error instanceof Error ? error.message : error}\n`,
  );
  if (error instanceof UsageError) {
    process.stderr.write(
      "usage: node test/e2e/fixtures/bigfile.mjs <outDir>\n",
    );
    process.exit(2);
  }
  process.exit(1);
}
