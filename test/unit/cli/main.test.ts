import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { COMMANDS, type Command } from "../../../src/cli/commands/index.js";
import { main, processIO } from "../../../src/cli/main.js";

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

it("exits 2 with the usage on stderr for an unknown command", async () => {
  const c = capture();
  expect(await main(["nebula"], c.io)).toBe(2);
  expect(c.err.join("")).toMatch(/^usage: hakutaku <command>/m);
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
