import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { COMMANDS } from "../../../src/cli/commands/index.js";
import { main } from "../../../src/cli/main.js";
import { removeTree } from "../../../src/export/index.js";
import { SandboxedRunFailed } from "../../../src/extract/rerun.js";
import { HOSTILE, HOSTILE_SHOWN, rawLines } from "../../helpers/terminal.js";

// The build itself is a stand-in here: these tests check only what the command makes of it.
const extractSnapshot = vi.hoisted(() => vi.fn());
vi.mock("../../../src/extract/index.js", () => ({ extractSnapshot }));

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) removeTree(dir);
});

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-cli-extract-"));
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

const USAGE =
  "usage: hakutaku extract <dir> --out <store> [--engines-dir <path>] [--detail quick|standard|deep] [--no-source] [--sandbox auto|require|none] [--memory-max <size>]\n";

it("is registered as extract, after export", () => {
  const names = COMMANDS.map((c) => c.name);
  expect(names).toContain("extract");
  expect(names.indexOf("extract")).toBe(names.indexOf("export") + 1);
});

it("exits 2 without --out", async () => {
  const c = capture();
  expect(await main(["extract", tmp()], c.io)).toBe(2);
  expect(c.out).toEqual([]);
  expect(c.err.join("")).toBe(`hakutaku extract: --out is required\n${USAGE}`);
});

it.each<[string, string[], string]>([
  ["no export directory", ["--out", "s.sqlite"], "expected one <dir>, got 0"],
  [
    "two export directories",
    ["a", "b", "--out", "s.sqlite"],
    "expected one <dir>, got 2",
  ],
  ["an empty --out", ["a", "--out", ""], "--out is empty"],
  [
    "an unknown detail",
    ["a", "--out", "s.sqlite", "--detail", "full"],
    '--detail must be quick, standard or deep, not "full"',
  ],
  [
    "an unknown sandbox",
    ["a", "--out", "s.sqlite", "--sandbox", "maybe"],
    '--sandbox must be auto, require or none, not "maybe"',
  ],
  [
    "an unknown sandbox kind",
    ["a", "--out", "s.sqlite", "--sandbox", "none", "--sandboxed-by", "chroot"],
    '--sandboxed-by must be bubblewrap or systemd-run, not "chroot"',
  ],
  [
    "a home directory that is not an absolute path",
    ["a", "--out", "s.sqlite", "--home", "astronomer"],
    '--home must be an absolute path, not "astronomer"',
  ],
  [
    "a current count of unresolved imports that is not a whole number",
    ["a", "--out", "s.sqlite", "--current-unresolved", "1.5"],
    '--current-unresolved must be a whole number, not "1.5"',
  ],
  [
    "a current count of unresolved imports written in another notation",
    ["a", "--out", "s.sqlite", "--current-unresolved", "1e3"],
    '--current-unresolved must be a whole number, not "1e3"',
  ],
  [
    "a current count of unresolved imports past the largest safe integer",
    ["a", "--out", "s.sqlite", "--current-unresolved", "9007199254740993"],
    '--current-unresolved must be a whole number, not "9007199254740993"',
  ],
  [
    "a memory cap systemd would take but Node's heap cannot follow",
    ["a", "--out", "s.sqlite", "--memory-max", "50%"],
    'scip-typescript: cannot read the memory cap "50%"',
  ],
  [
    "an unknown flag",
    ["a", "--out", "s.sqlite", "--fast"],
    "Unknown option '--fast'",
  ],
])("exits 2 on %s", async (_, argv, message) => {
  const c = capture();
  expect(await main(["extract", ...argv], c.io)).toBe(2);
  expect(c.out).toEqual([]);
  const err = c.err.join("");
  expect(err.startsWith("hakutaku extract: ")).toBe(true);
  expect(err).toContain(message);
  expect(err.endsWith(USAGE)).toBe(true);
});

// An option it does not take is named as given; a value it does not take, and the memory cap,
// through JSON.stringify, which writes ESC as an escape and leaves the rest.
it("says a usage error on lines safe for a terminal", async () => {
  for (const [argv, shown] of [
    [["a", "--out", "s.sqlite", `--${HOSTILE}`], HOSTILE_SHOWN],
    [["a", "--out", "s.sqlite", "--detail", HOSTILE], "[2J?31m; ?map"],
    [["a", "--out", "s.sqlite", "--memory-max", HOSTILE], "[2J?31m; ?map"],
  ] as const) {
    const c = capture();
    expect([argv, await main(["extract", ...argv], c.io)]).toEqual([argv, 2]);
    const err = c.err.join("");
    expect(err).toMatch(/^hakutaku extract: .+\n/);
    expect(err).toContain(shown);
    expect(err.endsWith(USAGE)).toBe(true);
    expect(rawLines(err)).toEqual([]);
  }
});

it("passes the flags a sandboxed re-run is given, which the usage leaves out", async () => {
  extractSnapshot.mockResolvedValueOnce({
    result: "built",
    commit: "a".repeat(40),
    contentHash: "b".repeat(64),
    gates: [],
  });
  const c = capture();
  expect(
    await main(
      [
        "extract",
        "export",
        "--out",
        "s.sqlite",
        "--sandbox",
        "none",
        "--sandboxed-by",
        "bubblewrap",
        "--memory-capped",
        "--home",
        "/srv/astronomer",
        "--current-unresolved",
        "0",
      ],
      c.io,
    ),
  ).toBe(0);
  expect(extractSnapshot).toHaveBeenLastCalledWith({
    dir: "export",
    out: "s.sqlite",
    noSource: false,
    sandbox: "none",
    sandboxedBy: "bubblewrap",
    memoryCapped: true,
    home: "/srv/astronomer",
    currentUnresolved: 0,
  });
  expect(USAGE).not.toMatch(
    /--memory-capped|--home|--sandboxed-by|--current-unresolved/,
  );
});

const GATES = [
  { gate: "files-indexed", ok: true, detail: "typescript 2/2" },
  {
    gate: "unresolved-imports",
    ok: false,
    detail: "1 of 1 relative imports unresolved (100.00%); limit 0.50%",
  },
];

it("prints the result as one line, exiting 0 when built and 3 when the gates failed", async () => {
  const built = {
    result: "built",
    commit: "a".repeat(40),
    contentHash: "b".repeat(64),
    gates: GATES.slice(0, 1),
  };
  extractSnapshot.mockResolvedValueOnce(built);
  const c = capture();
  expect(
    await main(
      [
        "extract",
        "export",
        "--out",
        "s.sqlite",
        "--detail",
        "quick",
        "--no-source",
      ],
      c.io,
    ),
  ).toBe(0);
  expect(c.out).toEqual([`${JSON.stringify(built)}\n`]);
  expect(extractSnapshot).toHaveBeenLastCalledWith({
    dir: "export",
    out: "s.sqlite",
    detail: "quick",
    noSource: true,
  });
  const failed = {
    result: "gates-failed",
    commit: "a".repeat(40),
    contentHash: null,
    reason: `unresolved-imports: ${GATES[1]?.detail}`,
    gates: GATES,
  };
  extractSnapshot.mockResolvedValueOnce(failed);
  const d = capture();
  expect(await main(["extract", "export", "--out", "s.sqlite"], d.io)).toBe(3);
  expect(d.out).toEqual([`${JSON.stringify(failed)}\n`]);
  expect(d.err).toEqual([]);
});

it("does not repeat a sandboxed run's printed failure, and reports one that printed nothing", async () => {
  extractSnapshot.mockRejectedValueOnce(
    new SandboxedRunFailed("ast-grep failed: exit code 1", true),
  );
  const printed = capture();
  expect(
    await main(["extract", "export", "--out", "s.sqlite"], printed.io),
  ).toBe(1);
  expect(printed.out).toEqual([]);
  expect(printed.err).toEqual([]);
  extractSnapshot.mockRejectedValueOnce(
    new SandboxedRunFailed(
      "the sandboxed extract was stopped by SIGKILL",
      false,
    ),
  );
  const stopped = capture();
  expect(
    await main(["extract", "export", "--out", "s.sqlite"], stopped.io),
  ).toBe(1);
  expect(stopped.err).toEqual([
    "hakutaku: the sandboxed extract was stopped by SIGKILL\n",
  ]);
});
