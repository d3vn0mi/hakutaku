import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { COMMANDS } from "../../../src/cli/commands/index.js";
import { main } from "../../../src/cli/main.js";
import { removeTree } from "../../../src/export/index.js";
import { git, makeRepo } from "../../helpers/git.js";
import { HOSTILE, HOSTILE_SHOWN, rawLines } from "../../helpers/terminal.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) removeTree(dir);
});

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-cli-export-"));
  made.push(dir);
  return dir;
};

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (s: string) => void out.push(s),
      stderr: (s: string) => void err.push(s),
      stdin: process.stdin,
      env: {},
      isTTY: false,
    },
  };
};

const DATE = "2026-03-01T10:00:00Z";
const USAGE =
  "usage: hakutaku export <repo> --ref <ref> --out <dir> [--id <id>] [--profile <file>] [--rules <file>] [--max-files <n>]\n";

const threeFiles = (): Promise<string> =>
  makeRepo({
    commits: [
      {
        date: DATE,
        files: { "web/a.ts": "a\n", "web/b.ts": "b\n", "web/c.ts": "c\n" },
      },
    ],
  });

it("is registered as export", () => {
  expect(COMMANDS.map((c) => c.name)).toContain("export");
});

// An option it does not take is named as given; an id that is not one, through JSON.stringify,
// which writes ESC as an escape and leaves the rest.
it("says a usage error on lines safe for a terminal", async () => {
  for (const [argv, shown] of [
    [[`--${HOSTILE}`], HOSTILE_SHOWN],
    [["repo", "--out", "out", "--id", HOSTILE], "[2J?31m; ?map"],
  ] as const) {
    const c = capture();
    expect([argv, await main(["export", ...argv], c.io)]).toEqual([argv, 2]);
    const err = c.err.join("");
    expect(err).toMatch(/^hakutaku export: .+\n/);
    expect(err).toContain(shown);
    expect(err.endsWith(USAGE)).toBe(true);
    expect(rawLines(err)).toEqual([]);
  }
});

it("prints one ExportResult JSON line", async () => {
  const repo = await threeFiles();
  const out = join(tmp(), "out");
  const c = capture();
  const code = await main(
    ["export", repo, "--ref", "HEAD", "--out", out, "--id", "observatory"],
    c.io,
  );
  expect(c.err).toEqual([]);
  expect(code).toBe(0);
  const text = c.out.join("");
  expect(text.indexOf("\n")).toBe(text.length - 1);
  const result = JSON.parse(text);
  expect(Object.keys(result)).toEqual([
    "id",
    "commit",
    "commitTime",
    "ref",
    "files",
    "denied",
    "out",
  ]);
  expect(result).toStrictEqual({
    id: "observatory",
    commit: git(repo, "rev-parse", "HEAD"),
    commitTime: Date.parse(DATE) / 1000,
    ref: "HEAD",
    files: 3,
    denied: 0,
    out,
  });
  expect(existsSync(join(out, "export.json"))).toBe(true);
  // --ref defaults to HEAD.
  const again = join(tmp(), "out");
  const d = capture();
  expect(await main(["export", repo, "--out", again], d.io)).toBe(0);
  expect(JSON.parse(d.out.join("")).ref).toBe("HEAD");
});

it("exits 2 without --out", async () => {
  const repo = await threeFiles();
  const c = capture();
  expect(await main(["export", repo, "--ref", "HEAD"], c.io)).toBe(2);
  expect(c.err.join("")).toBe(`hakutaku export: --out is required\n${USAGE}`);
  expect(c.out).toEqual([]);
});

it("exits 1 and names the limit when there are too many files", async () => {
  const repo = await threeFiles();
  const out = join(tmp(), "out");
  const c = capture();
  expect(
    await main(["export", repo, "--out", out, "--max-files", "2"], c.io),
  ).toBe(1);
  expect(c.err.join("")).toBe("hakutaku: too many files: 3 > 2\n");
  expect(c.out).toEqual([]);
  expect(existsSync(out)).toBe(false);
});

it.each<[string, string[], string]>([
  ["no repo", ["--out", "OUT"], "expected one <repo>, got 0"],
  ["two repos", ["REPO", "REPO", "--out", "OUT"], "expected one <repo>, got 2"],
  [
    "--max-files 0",
    ["REPO", "--out", "OUT", "--max-files", "0"],
    "--max-files must be a positive integer",
  ],
  [
    "--max-files 2.5",
    ["REPO", "--out", "OUT", "--max-files", "2.5"],
    "--max-files must be a positive integer",
  ],
  [
    "--max-files 02",
    ["REPO", "--out", "OUT", "--max-files", "02"],
    "--max-files must be a positive integer",
  ],
  [
    "--id Sky",
    ["REPO", "--out", "OUT", "--id", "Sky"],
    'not a valid repo id: "Sky"',
  ],
  ["an empty --ref", ["REPO", "--out", "OUT", "--ref", ""], "--ref is empty"],
  ["an empty --out", ["REPO", "--out", ""], "--out is empty"],
])("exits 2 for %s", async (_, args, message) => {
  const repo = await threeFiles();
  const out = join(tmp(), "out");
  const argv = args.map((a) => (a === "REPO" ? repo : a === "OUT" ? out : a));
  const c = capture();
  expect(await main(["export", ...argv], c.io)).toBe(2);
  expect(c.err.join("")).toBe(`hakutaku export: ${message}\n${USAGE}`);
  expect(c.out).toEqual([]);
  expect(existsSync(out)).toBe(false);
});

it("exits 2 for an option it does not know, or one without its value", async () => {
  const repo = await threeFiles();
  const out = join(tmp(), "out");
  for (const args of [
    [repo, "--out", out, "--nebula"],
    [repo, "--out"],
    [repo, "--out", out, "--max-files"],
  ]) {
    const c = capture();
    expect(await main(["export", ...args], c.io)).toBe(2);
    expect(c.err.join("")).toMatch(/^hakutaku export: .+\n/);
    expect(c.err.join("").endsWith(USAGE)).toBe(true);
    expect(c.out).toEqual([]);
  }
  expect(existsSync(out)).toBe(false);
});

it("exits 2 when the folder name gives no repo id, and takes --id instead", async () => {
  const repo = await threeFiles();
  const odd = join(tmp(), "_sky");
  git(dirname(odd), "clone", "--quiet", repo, odd);
  const out = join(tmp(), "out");
  const c = capture();
  expect(await main(["export", odd, "--out", out], c.io)).toBe(2);
  expect(c.err.join("")).toBe(
    `hakutaku export: the folder name gives no valid repo id ("_sky"); name one with --id\n${USAGE}`,
  );
  expect(existsSync(out)).toBe(false);
  const d = capture();
  expect(await main(["export", odd, "--out", out, "--id", "sky"], d.io)).toBe(
    0,
  );
  expect(JSON.parse(d.out.join("")).id).toBe("sky");
});
