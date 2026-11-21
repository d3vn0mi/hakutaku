import { readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { COMMANDS } from "../../../src/cli/commands/index.js";
import { main } from "../../../src/cli/main.js";
import { confirm } from "../../../src/cli/prompt.js";
import { readLock, resolveBin } from "../../../src/engines/index.js";
import { HOSTILE, HOSTILE_SHOWN, rawLines } from "../../helpers/terminal.js";
import { fakeInstall, tmp } from "../engines/fake.js";

type EnginesModule = typeof import("../../../src/engines/index.js");

// installEngines, recorded: the real one unless a test replaces it for one call.
const installEngines = vi.hoisted(() =>
  vi.fn<EnginesModule["installEngines"]>(),
);
vi.mock("../../../src/engines/index.js", async (importOriginal) => {
  const actual = await importOriginal<EnginesModule>();
  installEngines.mockImplementation(actual.installEngines);
  return { ...actual, installEngines };
});

// A complete install of stand-in engines, moved to a directory whose name is HOSTILE.
const hostileInstall = (): string => {
  const dir = join(tmp(), HOSTILE);
  renameSync(fakeInstall(), dir);
  return dir;
};

// A path that holds HOSTILE, as a terminal is shown it.
const shown = (path: string): string => path.replace(HOSTILE, HOSTILE_SHOWN);

const QUESTION =
  "hakutaku needs scip-typescript, dependency-cruiser and ast-grep (npm) and grimp (PyPI). Install the pinned versions now? [y/N]";
const USAGE =
  "usage: hakutaku engines install|list|verify [--engines-dir <path>] [--deep] [--yes]\n";

const capture = (opts: { isTTY?: boolean; input?: string[] } = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (s: string) => void out.push(s),
      stderr: (s: string) => void err.push(s),
      stdin: Readable.from(opts.input ?? []),
      env: {},
      isTTY: opts.isTTY ?? false,
    },
  };
};

it("is registered as engines, before export", () => {
  const names = COMMANDS.map((c) => c.name);
  expect(names).toContain("engines");
  expect(names.indexOf("engines")).toBeLessThan(names.indexOf("export"));
});

it("asks before installing, and stops without --yes when there is no TTY", async () => {
  const parent = tmp();
  const c = capture();
  const code = await main(
    ["engines", "install", "--engines-dir", join(parent, "engines")],
    c.io,
  );
  expect(code).toBe(1);
  expect(c.err.join("")).toBe(`${QUESTION}\nre-run with --yes\n`);
  expect(c.out).toEqual([]);
  expect(readdirSync(parent)).toEqual([]);
});

it("asks on a TTY, and installs nothing when the answer is not yes", async () => {
  const parent = tmp();
  const c = capture({ isTTY: true, input: ["n\n"] });
  const code = await main(
    ["engines", "install", "--deep", "--engines-dir", join(parent, "engines")],
    c.io,
  );
  expect(code).toBe(1);
  expect(c.err.join("")).toBe(`${QUESTION} the engines were not installed\n`);
  expect(c.out).toEqual([]);
  expect(readdirSync(parent)).toEqual([]);
});

it("does nothing, and asks nothing, when the engines and grimp are installed", async () => {
  const dir = fakeInstall();
  const c = capture();
  expect(await main(["engines", "install", "--engines-dir", dir], c.io)).toBe(
    0,
  );
  expect(c.err.join("")).toBe(`the engines are already installed in ${dir}\n`);
  expect(c.out).toEqual([]);
});

it("asks again when the engines are installed without grimp, or without scip-python for --deep", async () => {
  for (const [dir, argv] of [
    [fakeInstall({ python: false }), []],
    [fakeInstall(), ["--deep"]],
  ] as const) {
    const c = capture();
    expect(
      await main(["engines", "install", ...argv, "--engines-dir", dir], c.io),
    ).toBe(1);
    expect(c.err.join("")).toBe(`${QUESTION}\nre-run with --yes\n`);
  }
});

it("verifies quietly, and prints each problem on stderr with exit 1", async () => {
  const dir = fakeInstall();
  const ok = capture();
  expect(await main(["engines", "verify", "--engines-dir", dir], ok.io)).toBe(
    0,
  );
  expect([...ok.out, ...ok.err]).toEqual([]);
  const deep = capture();
  expect(
    await main(["engines", "verify", "--deep", "--engines-dir", dir], deep.io),
  ).toBe(1);
  expect(deep.err.join("")).toBe(
    `scip-python missing at ${resolveBin(dir, readLock().lock.engines["scip-python"]?.bin ?? "")}\n`,
  );
  const none = capture();
  expect(
    await main(
      ["engines", "verify", "--engines-dir", join(tmp(), "engines")],
      none.io,
    ),
  ).toBe(1);
  expect(none.err.join("")).toBe("not installed\n");
  expect(none.out).toEqual([]);
});

// Where each cell of a row starts, read left to right.
function starts(line: string, cells: string[]): number[] {
  let at = 0;
  return cells.map((cell) => {
    const found = line.indexOf(cell, at);
    at = found + cell.length;
    return found;
  });
}

it("lists engine, version, min detail and installed, in aligned columns", async () => {
  const dir = fakeInstall();
  const c = capture();
  expect(await main(["engines", "list", "--engines-dir", dir], c.io)).toBe(0);
  expect(c.err).toEqual([]);
  const text = c.out.join("");
  expect(text.endsWith("\n")).toBe(true);
  const lines = text.slice(0, -1).split("\n");
  const { engines } = readLock().lock;
  const want = [
    ["engine", "version", "min detail", "installed"],
    ...Object.entries(engines).map(([name, e]) => [
      name,
      e.version,
      e.minDetail,
      name === "scip-python" ? "no" : "yes",
    ]),
  ];
  expect(lines.map((l) => l.split(/ {2,}/))).toEqual(want);
  const columns = lines.map((l, i) => starts(l, want[i] ?? []));
  for (const row of columns) expect(row).toEqual(columns[0]);
  for (const line of lines) expect(line).not.toMatch(/ $/);
});

it.each<[string[], string]>([
  [[], "expected one of install, list or verify, got 0"],
  [["fix"], 'unknown subcommand "fix"'],
  [["list", "verify"], "expected one of install, list or verify, got 2"],
  [["list", "--engines-dir", ""], "--engines-dir is empty"],
])("exits 2 with the usage for %j", async (argv, message) => {
  const c = capture();
  expect(await main(["engines", ...argv], c.io)).toBe(2);
  expect(c.err.join("")).toBe(`hakutaku engines: ${message}\n${USAGE}`);
  expect(c.out).toEqual([]);
});

it("exits 2 with the usage for an unknown option", async () => {
  const c = capture();
  expect(await main(["engines", "list", "--colour"], c.io)).toBe(2);
  const err = c.err.join("");
  expect(err).toMatch(/^hakutaku engines: .*--colour/);
  expect(err.endsWith(`\n${USAGE}`)).toBe(true);
});

// An option it does not take is named as given; a subcommand it does not know, through
// JSON.stringify, which writes ESC as an escape and leaves the rest.
it("says a usage error on lines safe for a terminal", async () => {
  for (const [argv, text] of [
    [["list", `--${HOSTILE}`], HOSTILE_SHOWN],
    [[HOSTILE], "[2J?31m; ?map"],
  ] as const) {
    const c = capture();
    expect([argv, await main(["engines", ...argv], c.io)]).toEqual([argv, 2]);
    const err = c.err.join("");
    expect(err).toMatch(/^hakutaku engines: .+\n/);
    expect(err).toContain(text);
    expect(err.endsWith(USAGE)).toBe(true);
    expect(rawLines(err)).toEqual([]);
  }
});

it("names the engines directory it found installed on a line safe for a terminal", async () => {
  const dir = hostileInstall();
  const c = capture();
  expect(await main(["engines", "install", "--engines-dir", dir], c.io)).toBe(
    0,
  );
  expect(c.err.join("")).toBe(
    `the engines are already installed in ${shown(dir)}\n`,
  );
});

it("names the engines directory it installs in, and each line the install logs, on lines safe for a terminal", async () => {
  const dir = join(tmp(), HOSTILE);
  installEngines.mockImplementationOnce(async (opts) => {
    opts.log?.(`grimp not installed: pip said ${HOSTILE}`);
  });
  const c = capture();
  expect(
    await main(["engines", "install", "--yes", "--engines-dir", dir], c.io),
  ).toBe(0);
  expect(c.err.join("")).toBe(
    [
      `installing the engines in ${shown(dir)}`,
      `grimp not installed: pip said ${HOSTILE_SHOWN}`,
      `installed the engines in ${shown(dir)}`,
      "",
    ].join("\n"),
  );
  expect(installEngines).toHaveBeenLastCalledWith(
    expect.objectContaining({ dir, deep: false, yes: true }),
  );
});

it("prints each problem verify finds on a line safe for a terminal", async () => {
  const dir = hostileInstall();
  const c = capture();
  expect(
    await main(["engines", "verify", "--deep", "--engines-dir", dir], c.io),
  ).toBe(1);
  const bin = resolveBin(
    dir,
    readLock().lock.engines["scip-python"]?.bin ?? "",
  );
  expect(c.err.join("")).toBe(`scip-python missing at ${shown(bin)}\n`);
});

it.each<[string, boolean]>([
  ["y\n", true],
  ["yes\n", true],
  ["Y\n", true],
  ["  YES \n", true],
  ["n\n", false],
  ["no\n", false],
  ["\n", false],
  ["yess\n", false],
  ["y", true],
])("confirm reads %j as %s", async (input, want) => {
  const c = capture({ input: [input] });
  expect(await confirm(c.io, "Point the telescope? [y/N]")).toBe(want);
  expect(c.err.join("")).toBe("Point the telescope? [y/N] ");
  expect(c.out).toEqual([]);
});

it("confirm answers no at the end of input", async () => {
  const c = capture({ input: [] });
  expect(await confirm(c.io, "Point the telescope? [y/N]")).toBe(false);
});

it("confirm reads the first line only, however the input arrives", async () => {
  const c = capture({ input: ["y", "es\nno\n"] });
  expect(await confirm(c.io, "Point the telescope? [y/N]")).toBe(true);
  const d = capture({ input: ["n", "o\nyes\n"] });
  expect(await confirm(d.io, "Point the telescope? [y/N]")).toBe(false);
});
