// The built CLI with a stdout that fails: a pipe whose reader has gone, as when hakutaku is piped
// into a command that exits early, such as head, and, on Linux, /dev/full, where every write
// fails with ENOSPC. Each run has a home directory of its own. Run `npm run build` before this
// file, since it runs dist/.
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { removeTree } from "../../../src/export/index.js";

const MAIN = fileURLToPath(
  new URL("../../../dist/cli/main.js", import.meta.url),
);

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) removeTree(dir);
});

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-oracle-stdout-"));
  made.push(dir);
  return dir;
};

// What each case runs: --help, and a command that writes several lines, engines list for a
// directory that holds no engine.
const commands = (home: string): string[][] => [
  ["--help"],
  ["engines", "list", "--engines-dir", join(home, "engines")],
];

// Runs the CLI with its stdout read to the end ("read"), a pipe whose read end is destroyed
// before the CLI starts ("gone"), or a file descriptor; how it ended, and what it wrote. Node's
// warning that node:sqlite is experimental, which Node 22 prints on stderr, is turned off, so
// that stderr holds only what the CLI wrote, or a stack trace.
function runCli(
  argv: string[],
  home: string,
  stdout: "read" | "gone" | number,
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", MAIN, ...argv],
      {
        cwd: home,
        env: { HOME: home },
        stdio: ["ignore", typeof stdout === "number" ? stdout : "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    if (stdout === "gone") child.stdout?.destroy();
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

it("ends quietly, with exit 0, when the reader of its stdout has gone before --help or a command writes several lines", async () => {
  const home = tmp();
  for (const argv of commands(home)) {
    // the control: read to the end, each writes several lines
    const read = await runCli(argv, home, "read");
    expect([argv, read.code, read.stderr]).toEqual([argv, 0, ""]);
    expect(read.stdout.split("\n").length, argv.join(" ")).toBeGreaterThan(3);
    expect([argv, await runCli(argv, home, "gone")]).toEqual([
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
        expect([argv, await runCli(argv, home, full)]).toEqual([
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
