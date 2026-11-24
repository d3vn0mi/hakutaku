// Checks over the files of this repository: what git tracks, plus untracked files that
// .gitignore does not exclude. They keep stores, images and home-directory paths out of
// a public tree, and check that CI runs every test file, with the live sandbox tests' tools
// set up before its first test run.
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runLines } from "../../src/manifests/ci.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const STORE_OR_INDEX = /\.(sqlite(-wal|-shm|-journal)?|db|scip)$/;
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|tiff?)$/i;
const HOME_PATH = /\/(?:home|Users)\/[A-Za-z0-9._-]+/;
const BINARY_SNIFF_BYTES = 8000;

function treeFiles(): string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  return [...new Set(out.split("\0").filter((p) => p !== ""))];
}

// The text git would store for a path: a symlink's target, or a regular file's content.
// Undefined for a binary file (a NUL byte in its first 8,000 bytes), for a path that no
// longer exists in the work tree, and for anything else, such as a submodule.
function textOf(path: string): string | undefined {
  const abs = join(ROOT, path);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(abs);
  } catch {
    return undefined;
  }
  if (stat.isSymbolicLink()) return readlinkSync(abs, "utf8");
  if (!stat.isFile()) return undefined;
  const bytes = readFileSync(abs);
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return undefined;
  return bytes.toString("utf8");
}

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
// vitest's subcommands that are not a plain run of its tests
const NOT_A_RUN = ["related", "watch", "dev", "bench", "init", "list"];

// The simple commands of a shell command line, each as its words: the line cut at a word that
// starts with #, split at ;, & and | (so at && and || too), each part split at blanks with
// quotes dropped, and the NAME=value words before its command left out.
function simpleCommands(line: string): string[][] {
  const out: string[][] = [];
  for (const part of line.replace(/(^|\s)#.*$/, "").split(/[;&|]+/)) {
    const words = part
      .trim()
      .split(/\s+/)
      .filter((w) => w !== "")
      .map((w) => w.replace(/^["']|["']$/g, ""));
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words.shift();
    if (words.length > 0) out.push(words);
  }
  return out;
}

type Runner = "vitest" | "playwright";

// The filters of each vitest run a command line starts, in order: run directly (vitest,
// npx vitest, a path ending /vitest), or through the package.json scripts that npm test and
// npm run name, whose extra arguments go to the end of the script's command, as npm passes
// them. A run of every test file has no filter. A vitest subcommand or flag this does not read
// throws, so that a new way of running vitest is taught here before it counts.
function vitestRuns(line: string, scripts: Record<string, string>): string[][] {
  return testRuns("vitest", line, scripts, []);
}

// The same for Playwright's test command (playwright test, npx playwright test, a path ending
// /playwright); its other commands, such as install, run no test. A flag throws, as vitest's do.
function playwrightRuns(
  line: string,
  scripts: Record<string, string>,
): string[][] {
  return testRuns("playwright", line, scripts, []);
}

function testRuns(
  runner: Runner,
  line: string,
  scripts: Record<string, string>,
  seen: string[],
): string[][] {
  const runs: string[][] = [];
  for (const words of simpleCommands(line)) {
    const [command, sub, ...rest] = words;
    if (command === "npm" && (sub === "test" || sub === "t")) {
      runs.push(...scriptRuns(runner, "test", rest, scripts, seen));
    } else if (command === "npm" && (sub === "run" || sub === "run-script")) {
      const [name = "", ...args] = rest;
      runs.push(...scriptRuns(runner, name, args, scripts, seen));
    } else {
      const at = command === "npx" ? 1 : 0;
      const bin = words[at] ?? "";
      if (
        runner === "vitest" &&
        (bin === "vitest" || bin.endsWith("/vitest"))
      ) {
        runs.push(vitestFilters(words.slice(at + 1)));
      } else if (
        runner === "playwright" &&
        (bin === "playwright" || bin.endsWith("/playwright")) &&
        words[at + 1] === "test"
      ) {
        runs.push(playwrightFilters(words.slice(at + 2)));
      }
    }
  }
  return runs;
}

function scriptRuns(
  runner: Runner,
  name: string,
  args: string[],
  scripts: Record<string, string>,
  seen: string[],
): string[][] {
  const script = scripts[name];
  if (script === undefined) {
    throw new Error(
      `CI runs the npm script ${name}, which package.json does not have`,
    );
  }
  if (seen.includes(name))
    throw new Error(`the npm script ${name} runs itself`);
  const extra = args[0] === "--" ? args.slice(1) : args;
  return testRuns(runner, [script, ...extra].join(" "), scripts, [
    ...seen,
    name,
  ]);
}

function playwrightFilters(args: string[]): string[] {
  for (const word of args) {
    if (word.startsWith("-")) {
      throw new Error(
        `the inventory does not read playwright's ${JSON.stringify(word)}`,
      );
    }
  }
  return args;
}

function vitestFilters(args: string[]): string[] {
  const words = args[0] === "run" ? args.slice(1) : args;
  for (const word of words) {
    if (word.startsWith("-") || NOT_A_RUN.includes(word)) {
      throw new Error(
        `the inventory does not read vitest's ${JSON.stringify(word)}`,
      );
    }
  }
  return words;
}

// Whether a vitest run with these filters runs the file at path: where it has none, or one names
// the file or a directory above it. Stricter than vitest, which runs every file whose path holds
// a filter anywhere, so a file counts as run only where a filter plainly names it.
function runsFile(filters: string[], path: string): boolean {
  return (
    filters.length === 0 ||
    filters.some((f) => {
      const named = f.replace(/^\.\//, "").replace(/\/+$/, "");
      return path === named || path.startsWith(`${named}/`);
    })
  );
}

// The test files among files that no CI test run collects: each *.test or *.spec JS or TS file
// outside fixtures/ (sample repositories, whose test files are data) that neither a vitest run
// collects (vitest's include, test/**/*.test.ts, and a run's filters naming it) nor a Playwright
// run does (under e2eDir, its testDir, whose default testMatch takes every *.test and *.spec
// file, and a run's filters naming it).
function missedTests(
  files: string[],
  runs: string[][],
  e2eRuns: string[][] = [],
  e2eDir = "test/e2e",
): string[] {
  const collected = (path: string): boolean =>
    path.startsWith("test/") && path.endsWith(".test.ts");
  const underE2e = (path: string): boolean => path.startsWith(`${e2eDir}/`);
  return files.filter(
    (p) =>
      TEST_FILE.test(p) &&
      !p.startsWith("fixtures/") &&
      !(collected(p) && runs.some((filters) => runsFile(filters, p))) &&
      !(underE2e(p) && e2eRuns.some((filters) => runsFile(filters, p))),
  );
}

// Each run: command line of the workflows, with the vitest and the Playwright runs it starts.
function ciLines(): Array<{
  file: string;
  line: number;
  command: string;
  runs: string[][];
  e2eRuns: string[][];
}> {
  const scripts: Record<string, string> =
    JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts ?? {};
  return treeFiles()
    .filter((p) => WORKFLOW.test(p))
    .flatMap((file) =>
      runLines(readFileSync(join(ROOT, file), "utf8")).map((l) => ({
        file,
        ...l,
        runs: vitestRuns(l.command, scripts),
        e2eRuns: playwrightRuns(l.command, scripts),
      })),
    );
}

it("holds no store or index file outside fixtures/", () => {
  const found = treeFiles().filter(
    (p) => !p.startsWith("fixtures/") && STORE_OR_INDEX.test(p),
  );
  expect(
    found,
    `store or index files outside fixtures/:\n${found.join("\n")}`,
  ).toEqual([]);
});

it("holds no image outside fixtures/ and docs/img/", () => {
  const found = treeFiles().filter(
    (p) =>
      !p.startsWith("fixtures/") && !p.startsWith("docs/img/") && IMAGE.test(p),
  );
  expect(
    found,
    `images outside fixtures/ and docs/img/:\n${found.join("\n")}`,
  ).toEqual([]);
});

it("holds no home-directory path in any text file", () => {
  const found: string[] = [];
  for (const path of treeFiles()) {
    const text = textOf(path);
    if (text === undefined) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (HOME_PATH.test(lines[i] ?? "")) found.push(`${path}:${i + 1}`);
    }
  }
  expect(
    found,
    `home-directory paths, as path:line:\n${found.join("\n")}`,
  ).toEqual([]);
});

it("reads the vitest runs a CI command line starts, directly or through package.json's scripts", () => {
  const scripts = {
    test: "vitest run test/unit",
    "test:oracle": "vitest run test/oracle",
    "test:all": "npm test && npm run test:oracle",
    lint: "biome check .",
    loop: "npm run loop",
  };
  expect(vitestRuns("npm test", scripts)).toEqual([["test/unit"]]);
  expect(vitestRuns("npm run test:all", scripts)).toEqual([
    ["test/unit"],
    ["test/oracle"],
  ]);
  expect(
    vitestRuns(
      "npm run lint && npx vitest run test/repo/a.test.ts './test/repo/b.test.ts'",
      scripts,
    ),
  ).toEqual([["test/repo/a.test.ts", "./test/repo/b.test.ts"]]);
  // arguments after the script's name go to the end of its command, as npm passes them
  expect(vitestRuns("CI=true npm test -- test/oracle/build", scripts)).toEqual([
    ["test/unit", "test/oracle/build"],
  ]);
  expect(vitestRuns("node_modules/.bin/vitest; npm ci", scripts)).toEqual([[]]);
  // a comment is no command, even where it reads like a second one
  expect(
    vitestRuns(
      "sudo apt-get install -y bubblewrap # && npx vitest run test/x; npm test",
      scripts,
    ),
  ).toEqual([]);
  expect(() => vitestRuns("npm run missing", scripts)).toThrow(
    "CI runs the npm script missing, which package.json does not have",
  );
  expect(() => vitestRuns("npm run loop", scripts)).toThrow(
    "the npm script loop runs itself",
  );
  expect(() =>
    vitestRuns("npx vitest run --exclude test/unit", scripts),
  ).toThrow('the inventory does not read vitest\'s "--exclude"');
  expect(() => vitestRuns("npx vitest related src/a.ts", scripts)).toThrow(
    'the inventory does not read vitest\'s "related"',
  );
});

it("reads the Playwright test runs a CI command line starts, and none of its other commands", () => {
  const scripts = {
    test: "vitest run test/unit",
    "test:e2e": "playwright test",
    "test:one": "playwright test test/e2e/a.spec.ts",
  };
  expect(
    playwrightRuns(
      "npx playwright install --with-deps chromium firefox && npm run test:e2e",
      scripts,
    ),
  ).toEqual([[]]);
  expect(
    playwrightRuns(
      "npm run test:one && node_modules/.bin/playwright test",
      scripts,
    ),
  ).toEqual([["test/e2e/a.spec.ts"], []]);
  expect(playwrightRuns("npm test && npx vitest run", scripts)).toEqual([]);
  expect(vitestRuns("npm run test:e2e", scripts)).toEqual([]);
  expect(() =>
    playwrightRuns("npx playwright test --grep smoke", scripts),
  ).toThrow('the inventory does not read playwright\'s "--grep"');
});

it("takes a file as run where a filter names it or a directory above it, or the run has none", () => {
  expect(runsFile([], "test/unit/a.test.ts")).toBe(true);
  expect(runsFile(["test/unit"], "test/unit/x/a.test.ts")).toBe(true);
  expect(runsFile(["./test/unit/"], "test/unit/a.test.ts")).toBe(true);
  expect(runsFile(["test/unit/a.test.ts"], "test/unit/a.test.ts")).toBe(true);
  // stricter than vitest, which runs every file whose path holds a filter anywhere
  expect(runsFile(["test/uni"], "test/unit/a.test.ts")).toBe(false);
  expect(runsFile(["unit"], "test/unit/a.test.ts")).toBe(false);
  expect(runsFile(["test/oracle"], "test/unit/a.test.ts")).toBe(false);
});

it("names each test file outside fixtures/ that no run collects: vitest's include and filters, or Playwright's testDir and filters", () => {
  const files = [
    "test/unit/a.test.ts",
    "test/b.test.ts",
    "test/oracle/c.test.ts",
    "test/unit/d.spec.ts",
    "test/unit/e.test.js",
    "test/unit/f.test.mts",
    "src/g.test.ts",
    "fixtures/web/h.test.ts",
    "test/helpers/i.ts",
    "README.md",
    "test/e2e/j.spec.ts",
    "test/e2e/k/l.spec.ts",
  ];
  expect(missedTests(files, [["test/unit"], ["test/b.test.ts"]])).toEqual([
    "test/oracle/c.test.ts",
    "test/unit/d.spec.ts",
    "test/unit/e.test.js",
    "test/unit/f.test.mts",
    "src/g.test.ts",
    "test/e2e/j.spec.ts",
    "test/e2e/k/l.spec.ts",
  ]);
  // a run of every file still leaves out what vitest's include does not collect
  expect(missedTests(files, [[]])).toEqual([
    "test/unit/d.spec.ts",
    "test/unit/e.test.js",
    "test/unit/f.test.mts",
    "src/g.test.ts",
    "test/e2e/j.spec.ts",
    "test/e2e/k/l.spec.ts",
  ]);
  // a Playwright run collects only under its testDir, and only what its filters name
  expect(missedTests(files, [[]], [[]], "test/e2e")).toEqual([
    "test/unit/d.spec.ts",
    "test/unit/e.test.js",
    "test/unit/f.test.mts",
    "src/g.test.ts",
  ]);
  expect(missedTests(files, [[]], [["test/e2e/k"]], "test/e2e")).toEqual([
    "test/unit/d.spec.ts",
    "test/unit/e.test.js",
    "test/unit/f.test.mts",
    "src/g.test.ts",
    "test/e2e/j.spec.ts",
  ]);
  expect(missedTests(files, [[]], [[]], "test/e2e/k")).toEqual([
    "test/unit/d.spec.ts",
    "test/unit/e.test.js",
    "test/unit/f.test.mts",
    "src/g.test.ts",
    "test/e2e/j.spec.ts",
  ]);
});

it("runs every test file in some CI vitest or Playwright run", () => {
  // vitest collects test/**/*.test.ts and nothing else; a change to its config is read here first
  const config = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
  expect(config).toMatch(/\binclude: \["test\/\*\*\/\*\.test\.ts"\],/);
  expect(config).not.toMatch(
    /\b(exclude|dir|root|projects|includeSource|typecheck)\s*:/,
  );
  // Playwright collects every *.spec and *.test file under its one testDir, by its default
  // testMatch; a config that sets another is read here first
  const playwright = readFileSync(join(ROOT, "playwright.config.ts"), "utf8");
  const testDirs = [...playwright.matchAll(/\btestDir\s*:\s*"([^"]*)"/g)].map(
    (m) => m[1],
  );
  expect(testDirs).toEqual(["test/e2e"]);
  expect(playwright).not.toMatch(/\b(testMatch|testIgnore)\s*:/);
  const lines = ciLines();
  const runs = lines.flatMap((l) => l.runs);
  expect(runs.length).toBeGreaterThan(0);
  const e2eRuns = lines.flatMap((l) => l.e2eRuns);
  expect(e2eRuns.length).toBeGreaterThan(0);
  const files = treeFiles();
  expect(files).toContain("test/repo/tree.test.ts");
  expect(files).toContain("test/e2e/smoke.spec.ts");
  const missed = missedTests(files, runs, e2eRuns, testDirs[0]);
  expect(
    missed,
    `test files no CI vitest or Playwright run collects:\n${missed.join("\n")}`,
  ).toEqual([]);
});

it("installs bubblewrap, allows user namespaces and keeps a user manager before CI's first test run", () => {
  const SETUP: Array<[string, RegExp]> = [
    ["installs bubblewrap", /\bapt-get install\b.*\bbubblewrap\b/],
    [
      "allows unprivileged user namespaces",
      /\bsysctl -w kernel\.apparmor_restrict_unprivileged_userns=0$/,
    ],
    ["keeps a user manager running", /\bloginctl enable-linger\b/],
    [
      "gives the later steps its runtime directory",
      /\bXDG_RUNTIME_DIR=.*\$GITHUB_ENV\b/,
    ],
  ];
  const lines = ciLines();
  const workflows = [...new Set(lines.map((l) => l.file))];
  expect(workflows.length).toBeGreaterThan(0);
  for (const file of workflows) {
    const own = lines.filter((l) => l.file === file);
    const first = own.find((l) => l.runs.length > 0);
    if (first === undefined) continue;
    const before = own.filter((l) => l.line < first.line);
    const missing = SETUP.filter(
      ([, pattern]) => !before.some((l) => pattern.test(l.command)),
    ).map(([what]) => what);
    expect(
      missing,
      `${file}: what CI must do before line ${first.line}, ${first.command}`,
    ).toEqual([]);
  }
});
