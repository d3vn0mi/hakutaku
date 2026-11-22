import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import {
  type Check,
  checkLines,
  nodeCheck,
  sandboxCheck,
} from "../../../src/cli/commands/doctor.js";
import type { CliIO } from "../../../src/cli/commands/index.js";
import { main } from "../../../src/cli/main.js";
import {
  NO_PROCESS_ISOLATION,
  noSandboxText,
  type ProbeEvidence,
  SANDBOX_REPAIRS,
  type SandboxProblem,
} from "../../../src/extract/sandbox.js";
import { HOSTILE, HOSTILE_SHOWN, rawLines } from "../../helpers/terminal.js";

const evidence = (patch: Partial<ProbeEvidence>): ProbeEvidence => ({
  command: "bwrap",
  errno: null,
  exitCode: 1,
  signal: null,
  timedOut: false,
  excerpt: "",
  ...patch,
});

const NO_BWRAP: SandboxProblem = {
  line: SANDBOX_REPAIRS.noBubblewrap,
  evidence: evidence({ errno: "ENOENT", exitCode: null }),
};
const NO_NETWORK_CUT: SandboxProblem = {
  line: SANDBOX_REPAIRS.noNetworkCut,
  evidence: evidence({
    command: "systemd-run",
    exitCode: 10,
    excerpt: "sees a network interface besides loopback",
  }),
};
const NO_SCOPE: SandboxProblem = {
  line: SANDBOX_REPAIRS.noScope,
  evidence: evidence({
    command: "systemd-run",
    excerpt: "Failed to start transient scope unit: Access denied",
  }),
};

it("passes the sandbox check only for bubblewrap with its memory cap", () => {
  expect(sandboxCheck("linux", "bubblewrap", [])).toEqual({
    status: "ok",
    name: "sandbox",
    detail: "bubblewrap",
    below: [],
  });
  expect(sandboxCheck("linux", "bubblewrap", [NO_SCOPE])).toEqual({
    status: "warn",
    name: "sandbox",
    detail: "bubblewrap, with no memory cap: systemd-run cannot start a scope",
    below: [
      "systemd-run: exit code 1: Failed to start transient scope unit: Access denied",
    ],
  });
});

it("never passes systemd-run: it names bubblewrap's repair and the missing process isolation", () => {
  expect(sandboxCheck("linux", "systemd-run", [NO_BWRAP])).toEqual({
    status: "warn",
    name: "sandbox",
    detail: `systemd-run: bubblewrap is not installed; ${NO_PROCESS_ISOLATION}`,
    below: ["bwrap: could not start: ENOENT"],
  });
});

it("words no sandbox as --sandbox require refuses, with each probe's evidence below", () => {
  const problems = [NO_BWRAP, NO_NETWORK_CUT];
  expect(sandboxCheck("linux", null, problems)).toEqual({
    status: "warn",
    name: "sandbox",
    detail: noSandboxText("linux", problems),
    below: [
      "bwrap: could not start: ENOENT",
      "systemd-run: exit code 10: sees a network interface besides loopback",
    ],
  });
  expect(noSandboxText("linux", problems)).toBe(
    "no sandbox: bubblewrap is not installed; systemd-run cannot cut the network",
  );
  expect(sandboxCheck("darwin", null, [])).toEqual({
    status: "warn",
    name: "sandbox",
    detail: "no sandbox on darwin",
    below: [],
  });
});

it("fails a Node older than 22.16", () => {
  expect(nodeCheck("22.15.1")).toEqual({
    status: "fail",
    name: "node",
    detail: "22.15.1, older than 22.16",
    below: [],
  });
  for (const version of ["22.16.0", "22.20.3", "24.1.0", "25.9.0"]) {
    expect(nodeCheck(version).status, version).toBe("ok");
    expect(nodeCheck(version).detail).toBe(version);
  }
});

it("prints each check on one line, with what is below it indented", () => {
  const checks: Check[] = [
    { status: "ok", name: "node", detail: "25.9.0", below: [] },
    {
      status: "warn",
      name: "sandbox",
      detail: "no sandbox: bubblewrap is not installed",
      below: ["bwrap: could not start: ENOENT"],
    },
  ];
  expect(checkLines(checks)).toEqual([
    "ok  node: 25.9.0",
    "warn  sandbox: no sandbox: bubblewrap is not installed",
    "  bwrap: could not start: ENOENT",
  ]);
});

// What a check can quote: a python3 found on PATH, the engines directory, an engine's own output
// in a verify problem, an SQLite error and a probe's evidence.
it("prints each check and what is below it on lines safe for a terminal", () => {
  const lines = checkLines([
    {
      status: "fail",
      name: "sqlite",
      detail: `FTS5 trigram does not work: ${HOSTILE}`,
      below: [],
    },
    {
      status: "ok",
      name: "python",
      detail: `Python 3.12.1 at /opt/${HOSTILE}/bin/python3, within >=3.10`,
      below: [],
    },
    {
      status: "warn",
      name: "engines",
      detail: `ast-grep reported ${HOSTILE}; run hakutaku engines install`,
      below: [],
    },
    {
      status: "ok",
      name: "engines",
      detail: `installed in /srv/${HOSTILE}/engines`,
      below: [],
    },
    {
      status: "warn",
      name: "sandbox",
      detail: "no sandbox: bubblewrap is not installed",
      below: [`systemd-run: exit code 1: ${HOSTILE}`],
    },
  ]);
  expect(lines).toEqual([
    `fail  sqlite: FTS5 trigram does not work: ${HOSTILE_SHOWN}`,
    `ok  python: Python 3.12.1 at /opt/${HOSTILE_SHOWN}/bin/python3, within >=3.10`,
    `warn  engines: ast-grep reported ${HOSTILE_SHOWN}; run hakutaku engines install`,
    `ok  engines: installed in /srv/${HOSTILE_SHOWN}/engines`,
    "warn  sandbox: no sandbox: bubblewrap is not installed",
    `  systemd-run: exit code 1: ${HOSTILE_SHOWN}`,
  ]);
  expect(rawLines(lines.join("\n"))).toEqual([]);
});

it("takes no argument", async () => {
  const c = { out: "", err: "" };
  const io: CliIO = {
    stdout: (s) => {
      c.out += s;
    },
    stderr: (s) => {
      c.err += s;
    },
    stdin: new PassThrough(),
    env: {},
    isTTY: false,
  };
  expect(await main(["doctor", "--mcp", "observatory"], io)).toBe(2);
  expect(c.err).toMatch(/^hakutaku doctor: .*\nusage: hakutaku doctor\n$/);
  expect(c.out).toBe("");
});

it("names an argument it does not take on a line safe for a terminal", async () => {
  let err = "";
  const io: CliIO = {
    stdout: () => {},
    stderr: (s) => {
      err += s;
    },
    stdin: new PassThrough(),
    env: {},
    isTTY: false,
  };
  expect(await main(["doctor", HOSTILE], io)).toBe(2);
  expect(err).toMatch(/^hakutaku doctor: .*\nusage: hakutaku doctor\n$/);
  expect(err).toContain(HOSTILE_SHOWN);
  expect(rawLines(err)).toEqual([]);
});
