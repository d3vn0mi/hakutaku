// The built CLI with a stdout or a stderr that fails: a pipe whose reader has gone, as when
// hakutaku is piped into a command that exits early, such as head, and, on Linux, /dev/full,
// where every write fails with ENOSPC. Each run has a home directory of its own. Run `npm run
// build` before this file, since it runs dist/.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { removeTree } from "../../../src/export/index.js";
import { type LiveProbe, requireInCI } from "../../helpers/live.js";

const MAIN = fileURLToPath(
  new URL("../../../dist/cli/main.js", import.meta.url),
);

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) removeTree(dir);
});

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-oracle-output-"));
  made.push(dir);
  return dir;
};

// What each stdout case runs: --help, and a command that writes several lines, engines list for a
// directory that holds no engine.
const commands = (home: string): string[][] => [
  ["--help"],
  ["engines", "list", "--engines-dir", join(home, "engines")],
];

// What each stderr case runs, and the code each exits with when its stderr is read: an unknown
// command, which prints the usage; list with no repo registered, which says so and exits 0;
// a usage error; and engines verify for a directory that holds no engine.
const stderrCommands = (home: string): Array<[string[], number]> => [
  [["nebula"], 2],
  [["list"], 0],
  [["query"], 2],
  [["engines", "verify", "--engines-dir", join(home, "engines")], 1],
];

// How a stream of the CLI is given: a pipe read to the end ("read"), a pipe whose read end is
// destroyed before the CLI starts ("gone"), or a file descriptor.
type Stream = "read" | "gone" | number;

// Runs the CLI with its stdout and stderr given as said; how it ended, and what it wrote. Node's
// warning that node:sqlite is experimental, which Node 22 prints on stderr, is turned off, so
// that stderr holds only what the CLI wrote, or a stack trace.
function runCli(
  argv: string[],
  home: string,
  streams: { stdout?: Stream; stderr?: Stream },
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  const { stdout = "read", stderr = "read" } = streams;
  const given = (s: Stream) => (typeof s === "number" ? s : "pipe");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", MAIN, ...argv],
      {
        cwd: home,
        env: { HOME: home },
        stdio: ["ignore", given(stdout), given(stderr)],
      },
    );
    let out = "";
    let err = "";
    if (stdout === "gone") child.stdout?.destroy();
    if (stderr === "gone") child.stderr?.destroy();
    child.stdout?.setEncoding("utf8").on("data", (s: string) => {
      out += s;
    });
    child.stderr?.setEncoding("utf8").on("data", (s: string) => {
      err += s;
    });
    child.on("error", reject);
    child.on("close", (code, signal) =>
      resolve({ code, signal, stdout: out, stderr: err }),
    );
  });
}

// The tests that write to /dev/full need it, as Linux has it.
const devFull: LiveProbe = {
  name: "/dev/full",
  ok: existsSync("/dev/full"),
  evidence: "/dev/full does not exist",
};

it("ends quietly, with exit 0, when the reader of its stdout has gone before --help or a command writes several lines", async () => {
  const home = tmp();
  for (const argv of commands(home)) {
    // the control: read to the end, each writes several lines
    const read = await runCli(argv, home, {});
    expect([argv, read.code, read.stderr]).toEqual([argv, 0, ""]);
    expect(read.stdout.split("\n").length, argv.join(" ")).toBeGreaterThan(3);
    expect([argv, await runCli(argv, home, { stdout: "gone" })]).toEqual([
      argv,
      { code: 0, signal: null, stdout: "", stderr: "" },
    ]);
  }
});

it.skipIf(process.platform !== "linux")(
  "says once on stderr that stdout failed, and exits 1, when each write to stdout fails with ENOSPC",
  async () => {
    const home = tmp();
    const full = openSync("/dev/full", "w");
    try {
      for (const argv of commands(home)) {
        expect([argv, await runCli(argv, home, { stdout: full })]).toEqual([
          argv,
          {
            code: 1,
            signal: null,
            stdout: "",
            stderr: "hakutaku: cannot write to stdout: ENOSPC\n",
          },
        ]);
      }
    } finally {
      closeSync(full);
    }
  },
);

it("keeps its exit code, and prints no stack trace, when the reader of its stderr has gone before it writes there", async () => {
  const home = tmp();
  for (const [argv, code] of stderrCommands(home)) {
    // the control: read to the end, each writes on stderr only
    const read = await runCli(argv, home, {});
    expect([argv, read.code, read.stdout]).toEqual([argv, code, ""]);
    expect(read.stderr, argv.join(" ")).not.toBe("");
    expect([argv, await runCli(argv, home, { stderr: "gone" })]).toEqual([
      argv,
      { code, signal: null, stdout: "", stderr: "" },
    ]);
  }
  // with stdout's reader gone too, the code still stands
  expect(
    await runCli(["nebula"], home, { stdout: "gone", stderr: "gone" }),
  ).toEqual({ code: 2, signal: null, stdout: "", stderr: "" });
});

// A stderr that fails for another reason than its reader going away cannot say so: the run fails
// instead, where it would have passed.
it("exits 1 where it would exit 0, and keeps any other code, with no stack trace, when each write to stderr fails with ENOSPC", async (ctx) => {
  requireInCI(ctx, devFull);
  const home = tmp();
  const full = openSync("/dev/full", "w");
  try {
    for (const [argv, code] of stderrCommands(home)) {
      expect([argv, await runCli(argv, home, { stderr: full })]).toEqual([
        argv,
        { code: code === 0 ? 1 : code, signal: null, stdout: "", stderr: "" },
      ]);
    }
  } finally {
    closeSync(full);
  }
});
