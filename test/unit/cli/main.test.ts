import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import {
  type CliIO,
  COMMANDS,
  type Command,
} from "../../../src/cli/commands/index.js";
import { main, processIO } from "../../../src/cli/main.js";
import { HOSTILE, rawLines } from "../../helpers/terminal.js";

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

// An error of a stream, with its code, as Node gives one.
const errno = (code: string): Error =>
  Object.assign(new Error(`write ${code}`), { code });

// An io whose stdout fails when the test says so: onStdoutError hands the test each listener
// registered, and failExitCode counts its calls. log holds, in order, "listen" for each listener
// registered and "stdout" for each write to stdout.
const failable = () => {
  const c = capture();
  const log: string[] = [];
  const listeners: Array<(error: Error) => void> = [];
  let failedExit = 0;
  const io: CliIO = {
    ...c.io,
    stdout: (s) => {
      log.push("stdout");
      c.out.push(s);
    },
    onStdoutError: (listener) => {
      log.push("listen");
      listeners.push(listener);
    },
    failExitCode: () => {
      failedExit += 1;
    },
  };
  return {
    ...c,
    io,
    log,
    fail: (error: Error) => {
      for (const listener of listeners) listener(error);
    },
    failedExit: () => failedExit,
  };
};

// failable's io with a stderr that fails when the test says so too: onStderrError hands the test
// each listener registered, and log also holds "listen stderr" for each of those and "stderr" for
// each write to stderr.
const failableStderr = () => {
  const f = failable();
  const listeners: Array<(error: Error) => void> = [];
  const io: CliIO = {
    ...f.io,
    stderr: (s) => {
      f.log.push("stderr");
      f.err.push(s);
    },
    onStderrError: (listener) => {
      f.log.push("listen stderr");
      listeners.push(listener);
    },
  };
  return {
    ...f,
    io,
    failStderr: (error: Error) => {
      for (const listener of listeners) listener(error);
    },
  };
};

// A command that writes a line to stderr, has stderr fail with each error given, then writes
// another line to stderr and returns code.
const failingStderrCommand = (
  fail: (error: Error) => void,
  errors: Error[],
  code: number,
): Command => ({
  name: "telescope",
  summary: "points the observatory",
  run: async (_argv, io) => {
    io.stderr("north\n");
    for (const error of errors) fail(error);
    io.stderr("south\n");
    return code;
  },
});

// A command that writes a line, has stdout fail with each error given, then writes another line
// and returns code.
const failingCommand = (
  fail: (error: Error) => void,
  errors: Error[],
  code: number,
): Command => ({
  name: "telescope",
  summary: "points the observatory",
  run: async (_argv, io) => {
    io.stdout("north\n");
    for (const error of errors) fail(error);
    io.stdout("south\n");
    return code;
  },
});

it("prints the package version for --version", async () => {
  const c = capture();
  expect(await main(["--version"], c.io)).toBe(0);
  expect(c.out.join("")).toBe(
    `${JSON.parse(readFileSync("package.json", "utf8")).version}\n`,
  );
});

it("hands every error of the process's stdout to the listener a command registers", () => {
  const listener = vi.fn();
  processIO().onStdoutError?.(listener);
  try {
    // process.stdout stays writable after an error, so each later write can fail again
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    process.stdout.emit("error", epipe);
    process.stdout.emit("error", epipe);
    expect(listener.mock.calls).toEqual([[epipe], [epipe]]);
  } finally {
    process.stdout.off("error", listener);
  }
});

it("hands every error of the process's stderr to the listener main registers", () => {
  const listener = vi.fn();
  processIO().onStderrError?.(listener);
  try {
    // process.stderr stays writable after an error too
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    process.stderr.emit("error", epipe);
    process.stderr.emit("error", epipe);
    expect(listener.mock.calls).toEqual([[epipe], [epipe]]);
  } finally {
    process.stderr.off("error", listener);
  }
});

it("listens for stderr's errors once, before anything is written, whatever the arguments", async () => {
  const telescope: Command = {
    name: "telescope",
    summary: "points the observatory",
    run: async (_argv, io) => {
      io.stderr("north\n");
      return 0;
    },
  };
  for (const argv of [
    ["--version"],
    ["--help"],
    [],
    ["nebula"],
    ["telescope"],
  ]) {
    const f = failableStderr();
    await withCommand(telescope, () => main(argv, f.io));
    const first = f.log.findIndex((e) => e === "stdout" || e === "stderr");
    expect([
      argv,
      f.log.filter((e) => e === "listen stderr"),
      f.log.indexOf("listen stderr") < first,
    ]).toEqual([argv, ["listen stderr"], true]);
  }
});

it("ends stderr quietly once its reader has gone: later stderr output is dropped and the command's code stands", async () => {
  for (const code of ["EPIPE", "ECONNRESET"]) {
    for (const exit of [0, 3]) {
      const f = failableStderr();
      const command = failingStderrCommand(f.failStderr, [errno(code)], exit);
      expect([
        code,
        await withCommand(command, () => main(["telescope"], f.io)),
      ]).toEqual([code, exit]);
      expect(f.err).toEqual(["north\n"]);
      expect(f.failedExit()).toBe(0);
    }
  }
});

it("drops stderr after any other error, which it cannot say, and exits 1 where the command returned 0", async () => {
  const cases: Array<[number, number]> = [
    [0, 1],
    [3, 3],
  ];
  for (const [exit, code] of cases) {
    const f = failableStderr();
    const command = failingStderrCommand(
      f.failStderr,
      [errno("ENOSPC"), errno("ENOSPC")],
      exit,
    );
    expect(await withCommand(command, () => main(["telescope"], f.io))).toBe(
      code,
    );
    expect(f.err).toEqual(["north\n"]);
    expect(f.failedExit()).toBe(1);
  }
});

it("says nothing of a failed stdout on a stderr whose reader has gone, and still exits 1", async () => {
  const f = failableStderr();
  const command: Command = {
    name: "telescope",
    summary: "points the observatory",
    run: async (_argv, io) => {
      f.failStderr(errno("EPIPE"));
      io.stdout("north\n");
      f.fail(errno("ENOSPC"));
      return 0;
    },
  };
  expect(await withCommand(command, () => main(["telescope"], f.io))).toBe(1);
  expect(f.err).toEqual([]);
  expect(f.failedExit()).toBe(1);
});

it("fails the exit code through the io when stderr fails after main returned, but not when its reader went away", async () => {
  const telescope: Command = {
    name: "telescope",
    summary: "points the observatory",
    run: async (_argv, io) => {
      io.stderr("north\n");
      return 0;
    },
  };
  const cases: Array<[string, number]> = [
    ["EPIPE", 0],
    ["ECONNRESET", 0],
    ["EIO", 1],
  ];
  for (const [code, failedExit] of cases) {
    const f = failableStderr();
    expect(await withCommand(telescope, () => main(["telescope"], f.io))).toBe(
      0,
    );
    f.failStderr(errno(code));
    f.failStderr(errno(code));
    expect([code, f.err, f.failedExit()]).toEqual([
      code,
      ["north\n"],
      failedExit,
    ]);
  }
});

it("exits 2 with the usage on stderr for an unknown command", async () => {
  const c = capture();
  expect(await main(["nebula"], c.io)).toBe(2);
  expect(c.err.join("")).toMatch(/^usage: hakutaku <command>/m);
});

it("names an unknown command on one line safe for a terminal", async () => {
  const c = capture();
  expect(await main([HOSTILE], c.io)).toBe(2);
  const err = c.err.join("");
  // JSON.stringify writes ESC as an escape, and leaves the CSI, the separator and the override
  const backslash = "\\";
  expect(err.split("\n")[0]).toBe(
    `hakutaku: unknown command "sky${backslash}u001b[2J?31m; ?map"`,
  );
  expect(rawLines(err)).toEqual([]);
});

it("lists every registered command in --help", async () => {
  const c = capture();
  expect(await main(["--help"], c.io)).toBe(0);
  for (const cmd of COMMANDS) expect(c.out.join("")).toContain(cmd.name);
});

// Makes `command` the only registered one for the length of one test, so the dispatcher is
// exercised whatever the real list holds.
async function withCommand<T>(
  command: Command,
  body: () => Promise<T>,
): Promise<T> {
  const list = COMMANDS as Command[];
  const real = list.splice(0, list.length, command);
  try {
    return await body();
  } finally {
    list.splice(0, list.length, ...real);
  }
}

it("restores the real list after a test command", async () => {
  const before = [...COMMANDS];
  const telescope: Command = {
    name: "telescope",
    summary: "points the observatory",
    run: async () => 0,
  };
  await withCommand(telescope, async () => {
    expect(COMMANDS).toEqual([telescope]);
  });
  expect(COMMANDS).toEqual(before);
});

it("exits 2 with the usage on stderr when no command is given", async () => {
  const c = capture();
  expect(await main([], c.io)).toBe(2);
  expect(c.err.join("")).toMatch(/^usage: hakutaku <command> \[options\]$/m);
  expect(c.out).toEqual([]);
});

it("prints the usage and one line per registered command on stdout for --help", async () => {
  const c = capture();
  const telescope: Command = {
    name: "telescope",
    summary: "points the observatory",
    run: async () => 0,
  };
  const code = await withCommand(telescope, () => main(["--help"], c.io));
  expect(code).toBe(0);
  expect(c.out.join("")).toBe(
    "usage: hakutaku <command> [options]\n  telescope  points the observatory\n",
  );
  expect(c.err).toEqual([]);
});

it("aligns the summaries of --help in one column", async () => {
  const c = capture();
  const commands: Command[] = [
    {
      name: "telescope",
      summary: "points the observatory",
      run: async () => 0,
    },
    { name: "map", summary: "charts the sky", run: async () => 0 },
  ];
  const list = COMMANDS as Command[];
  const real = list.splice(0, list.length, ...commands);
  try {
    expect(await main(["--help"], c.io)).toBe(0);
  } finally {
    list.splice(0, list.length, ...real);
  }
  expect(c.out.join("")).toBe(
    [
      "usage: hakutaku <command> [options]",
      "  telescope  points the observatory",
      "  map        charts the sky",
      "",
    ].join("\n"),
  );
});

it("registers the commands in their fixed order, each summary in lower case", () => {
  expect(COMMANDS.map((c) => c.name)).toEqual([
    "map",
    "view",
    "mcp",
    "query",
    "list",
    "profile",
    "engines",
    "export",
    "extract",
    "doctor",
  ]);
  for (const command of COMMANDS) {
    expect(command.summary, command.name).toMatch(/^[a-z]/);
  }
});

it("runs a registered command with the arguments after its name and returns its code", async () => {
  const c = capture();
  const seen: string[][] = [];
  const telescope: Command = {
    name: "telescope",
    summary: "points the observatory",
    run: async (argv) => {
      seen.push(argv);
      return 3;
    },
  };
  const code = await withCommand(telescope, () =>
    main(["telescope", "--ref", "v1", "north"], c.io),
  );
  expect(code).toBe(3);
  expect(seen).toEqual([["--ref", "v1", "north"]]);
});

it("exits 1 with hakutaku: <message> on stderr when a command throws", async () => {
  const c = capture();
  const telescope: Command = {
    name: "telescope",
    summary: "points the observatory",
    run: async () => {
      throw new Error("lens cap is on");
    },
  };
  const code = await withCommand(telescope, () => main(["telescope"], c.io));
  expect(code).toBe(1);
  expect(c.err.join("")).toBe("hakutaku: lens cap is on\n");
  expect(c.out).toEqual([]);
});

it("keeps the line breaks of a command's error, as LF, and makes each line safe for a terminal", async () => {
  const ESC = String.fromCharCode(0x1b);
  const CSI = String.fromCharCode(0x9b); // a C1 control
  const cases: Array<[string, string]> = [
    // a lone CR is a line break; ESC and the C1 control become "?"
    [
      `the snapshot's ${ESC}[2Jsky is not a regular file\rlens ${CSI}31mcap`,
      "hakutaku: the snapshot's ?[2Jsky is not a regular file\nlens ?31mcap\n",
    ],
    // CRLF is one line break, and LF stays one
    ["north\r\nsouth\nwest", "hakutaku: north\nsouth\nwest\n"],
  ];
  for (const [message, err] of cases) {
    const c = capture();
    const telescope: Command = {
      name: "telescope",
      summary: "points the observatory",
      run: async () => {
        throw new Error(message);
      },
    };
    expect(await withCommand(telescope, () => main(["telescope"], c.io))).toBe(
      1,
    );
    expect(c.err.join("")).toBe(err);
  }
});

it("listens for stdout's errors once, before anything is written, whatever the arguments", async () => {
  const telescope: Command = {
    name: "telescope",
    summary: "points the observatory",
    run: async (_argv, io) => {
      io.stdout("north\n");
      return 0;
    },
  };
  for (const argv of [
    ["--version"],
    ["--help"],
    [],
    ["nebula"],
    ["telescope"],
  ]) {
    const f = failable();
    await withCommand(telescope, () => main(argv, f.io));
    expect([argv, f.log[0], f.log.filter((e) => e === "listen")]).toEqual([
      argv,
      "listen",
      ["listen"],
    ]);
  }
});

it("ends quietly once stdout's reader has gone: later output is dropped, stderr stays empty and the command's code stands", async () => {
  for (const code of ["EPIPE", "ECONNRESET"]) {
    for (const exit of [0, 3]) {
      const f = failable();
      const command = failingCommand(f.fail, [errno(code)], exit);
      expect([
        code,
        await withCommand(command, () => main(["telescope"], f.io)),
      ]).toEqual([code, exit]);
      expect(f.out).toEqual(["north\n"]);
      expect(f.err).toEqual([]);
      expect(f.failedExit()).toBe(0);
    }
  }
});

it("says once on stderr that stdout failed for any other error, drops later output, and exits 1 where the command returned 0", async () => {
  const cases: Array<[number, number]> = [
    [0, 1],
    [3, 3],
  ];
  for (const [exit, code] of cases) {
    const f = failable();
    const command = failingCommand(
      f.fail,
      [errno("ENOSPC"), errno("ENOSPC")],
      exit,
    );
    expect(await withCommand(command, () => main(["telescope"], f.io))).toBe(
      code,
    );
    expect(f.out).toEqual(["north\n"]);
    expect(f.err).toEqual(["hakutaku: cannot write to stdout: ENOSPC\n"]);
    expect(f.failedExit()).toBe(1);
  }
});

it("names a stdout error that has no code by its message, on one line safe for a terminal", async () => {
  const f = failable();
  const ESC = String.fromCharCode(0x1b);
  const command = failingCommand(
    f.fail,
    [new Error(`disk ${ESC}[2J gone\r\nfor good`)],
    0,
  );
  expect(await withCommand(command, () => main(["telescope"], f.io))).toBe(1);
  expect(f.err).toEqual([
    "hakutaku: cannot write to stdout: disk ?[2J gone; for good\n",
  ]);
});

it("fails the exit code through the io when stdout fails after main returned, but not when its reader went away", async () => {
  const telescope: Command = {
    name: "telescope",
    summary: "points the observatory",
    run: async (_argv, io) => {
      io.stdout("north\n");
      return 0;
    },
  };
  const cases: Array<[string, string[], number]> = [
    ["EPIPE", [], 0],
    ["ECONNRESET", [], 0],
    ["EIO", ["hakutaku: cannot write to stdout: EIO\n"], 1],
  ];
  for (const argv of [["--version"], ["--help"], ["telescope"]]) {
    for (const [code, err, failedExit] of cases) {
      const f = failable();
      expect(await withCommand(telescope, () => main(argv, f.io))).toBe(0);
      f.fail(errno(code));
      f.fail(errno(code));
      expect([argv, code, f.err, f.failedExit()]).toEqual([
        argv,
        code,
        err,
        failedExit,
      ]);
    }
  }
});

it("hands a command the io's own stdin, env and terminal, and opens stdin only when the command reads it", async () => {
  const stdin = new PassThrough();
  let opened = 0;
  const io: CliIO = {
    ...capture().io,
    get stdin() {
      opened += 1;
      return stdin;
    },
    env: { SKY: "clear" },
    isTTY: true,
  };
  const quiet: Command = {
    name: "telescope",
    summary: "points the observatory",
    run: async () => 0,
  };
  expect(await withCommand(quiet, () => main(["--help"], io))).toBe(0);
  expect(await withCommand(quiet, () => main(["telescope"], io))).toBe(0);
  expect(opened).toBe(0);
  const seen: unknown[] = [];
  const reader: Command = {
    name: "telescope",
    summary: "points the observatory",
    run: async (_argv, commandIO) => {
      seen.push(commandIO.stdin, commandIO.env, commandIO.isTTY);
      return 0;
    },
  };
  expect(await withCommand(reader, () => main(["telescope"], io))).toBe(0);
  expect(opened).toBe(1);
  expect(seen[0]).toBe(stdin);
  expect(seen[1]).toBe(io.env);
  expect(seen[2]).toBe(true);
});

it("ends the process with 1 where its code would be 0, and keeps any other code, once failExitCode is called", () => {
  const before = process.listeners("exit");
  processIO().failExitCode?.();
  const added = process.listeners("exit").filter((l) => !before.includes(l));
  const saved = process.exitCode;
  try {
    expect(added).toHaveLength(1);
    const ended = [undefined, 0, 3].map((code) => {
      process.exitCode = code;
      added[0]?.(code ?? 0);
      return process.exitCode;
    });
    expect(ended).toEqual([1, 1, 3]);
  } finally {
    process.exitCode = saved;
    for (const listener of added) process.off("exit", listener);
  }
});
