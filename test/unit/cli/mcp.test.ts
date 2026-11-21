import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, it, vi } from "vitest";
import { type CliIO, COMMANDS } from "../../../src/cli/commands/index.js";
import { main } from "../../../src/cli/main.js";
import { useRegisteredTiny } from "../../helpers/registry.js";

type RegistryModule = typeof import("../../../src/registry/index.js");

// registryHost, recorded, and otherwise the real one.
const registryHost = vi.hoisted(() => vi.fn<RegistryModule["registryHost"]>());
vi.mock("../../../src/registry/index.js", async (importOriginal) => {
  const actual = await importOriginal<RegistryModule>();
  registryHost.mockImplementation(actual.registryHost);
  return { ...actual, registryHost };
});

useRegisteredTiny();
afterEach(() => {
  registryHost.mockClear();
});

const capture = (stdin: NodeJS.ReadableStream = new PassThrough()) => {
  const c = { out: "", err: "" };
  const io: CliIO = {
    stdout: (s) => {
      c.out += s;
    },
    stderr: (s) => {
      c.err += s;
    },
    stdin,
    env: {},
    isTTY: false,
  };
  return { c, io };
};

const USAGE = "usage: hakutaku mcp <id>... | --all [--allow-refresh]\n";

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "t", version: "0" },
  },
};

const line = (message: object): string => `${JSON.stringify(message)}\n`;

const call = (id: number, name: string, args: object) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

// Every JSON-RPC message written to stdout, one per line.
const messages = (out: string): Array<Record<string, unknown>> =>
  out
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));

// A stdout whose reader goes away at close(), as when a client closes its read end. Like
// process.stdout, each later write fails after it has returned, with an 'error' event that
// throws when nothing listens, and the stream stays writable.
function closableStdout(c: { out: string }, code: string) {
  const events = new EventEmitter();
  let gone = false;
  return {
    close: () => {
      gone = true;
    },
    stdout: (s: string) => {
      if (!gone) {
        c.out += s;
        return;
      }
      const error = Object.assign(new Error(`write ${code}`), { code });
      setImmediate(() => events.emit("error", error));
    },
    onStdoutError: (listener: (error: Error) => void) => {
      events.on("error", listener);
    },
  };
}

// What the promise settles to, or a note once ms have passed without it.
async function within<T>(ms: number, promise: Promise<T>): Promise<T | string> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(`still running after ${ms} ms`), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

it("is registered as mcp, before query", () => {
  const names = COMMANDS.map((command) => command.name);
  expect(names.indexOf("mcp")).toBe(names.indexOf("query") - 1);
  expect(COMMANDS.find((command) => command.name === "mcp")?.summary).toBe(
    "the MCP server over stdio, serving exactly the repos named",
  );
});

it("mcp needs ids or --all, not both", async () => {
  const cases: Array<[string[], string]> = [
    [["mcp"], `hakutaku mcp: name the repos to serve, or pass --all\n${USAGE}`],
    [
      ["mcp", "tiny", "--all"],
      `hakutaku mcp: pass repo ids or --all, not both\n${USAGE}`,
    ],
    [["mcp", "nope"], "hakutaku mcp: unknown repo: nope; registered: tiny\n"],
  ];
  for (const [argv, err] of cases) {
    const { c, io } = capture();
    expect([argv, await main(argv, io)]).toEqual([argv, 2]);
    expect(c.err).toBe(err);
    expect(c.out).toBe("");
  }
  const { c, io } = capture();
  expect(await main(["mcp", "--nope"], io)).toBe(2);
  expect(c.err).toMatch(/^hakutaku mcp: .+\n/);
  expect(c.err.endsWith(USAGE)).toBe(true);
  expect(c.out).toBe("");
});

it("mcp serves until stdin ends and writes only protocol to stdout", async () => {
  const stdin = new PassThrough();
  const { c, io } = capture(stdin);
  const done = main(["mcp", "tiny"], io);
  stdin.write(line(INIT));
  await vi.waitFor(() => expect(c.out).toContain('"serverInfo"'));
  stdin.end();
  expect(await done).toBe(0);
  for (const m of messages(c.out)) expect(m.jsonrpc).toBe("2.0");
  expect(c.err).toBe("");
  // The server is closed: it no longer reads stdin.
  expect(stdin.listenerCount("data")).toBe(0);
});

it("mcp ends when stdin closes without ending", async () => {
  const stdin = new PassThrough();
  const { c, io } = capture(stdin);
  const done = main(["mcp", "tiny"], io);
  stdin.write(line(INIT));
  await vi.waitFor(() => expect(c.out).toContain('"serverInfo"'));
  stdin.destroy();
  expect(await done).toBe(0);
  expect(stdin.listenerCount("data")).toBe(0);
});

it("mcp ends quietly, with exit 0, once stdout fails because the client closed its read end", async () => {
  // EPIPE is what a closed read end gives; any other error on stdout ends the session the same way
  for (const code of ["EPIPE", "EIO"]) {
    const stdin = new PassThrough();
    const { c, io } = capture(stdin);
    const out = closableStdout(c, code);
    const done = main(["mcp", "tiny"], {
      ...io,
      stdout: out.stdout,
      onStdoutError: out.onStdoutError,
    });
    stdin.write(line(INIT));
    await vi.waitFor(() => expect(c.out).toContain('"serverInfo"'));
    out.close();
    stdin.write(line({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    stdin.write(line(call(3, "code_overview", { repo: "tiny" })));
    stdin.write(line({ jsonrpc: "2.0", id: 4, method: "tools/list" }));
    // stdin never ends: the failed stdout alone ends the server
    expect([code, await within(5000, done)]).toEqual([code, 0]);
    expect(c.err).toBe("");
    expect(messages(c.out).map((m) => m.id)).toEqual([1]);
    expect(stdin.listenerCount("data")).toBe(0);
  }
});

it("mcp answers every request written before stdin ends", async () => {
  const stdin = new PassThrough();
  const { c, io } = capture(stdin);
  const done = main(["mcp", "tiny"], io);
  stdin.write(line(INIT));
  stdin.write(line({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
  stdin.write(line(call(3, "code_overview", { repo: "tiny" })));
  stdin.end();
  expect(await done).toBe(0);
  expect(messages(c.out).map((m) => m.id)).toEqual([1, 2, 3]);
});

it("mcp ends at once on a stdin that is already over, and passes its repos and --allow-refresh to the registry host", async () => {
  for (const argv of [
    ["mcp", "--all"],
    ["mcp", "tiny", "--allow-refresh"],
  ]) {
    const stdin = new PassThrough();
    stdin.end();
    const { c, io } = capture(stdin);
    expect([argv, await main(argv, io)]).toEqual([argv, 0]);
    expect(c.out).toBe("");
  }
  expect(registryHost.mock.calls).toEqual([
    [{ repos: "all", allowRefresh: false }],
    [{ repos: ["tiny"], allowRefresh: true }],
  ]);
});

it("mcp offers no refresh without --allow-refresh", async () => {
  const stdin = new PassThrough();
  const { c, io } = capture(stdin);
  const done = main(["mcp", "tiny"], io);
  stdin.write(line(INIT));
  stdin.write(line(call(2, "code_refresh", { repo: "tiny" })));
  await vi.waitFor(() => expect(messages(c.out)).toHaveLength(2));
  stdin.end();
  expect(await done).toBe(0);
  const result = messages(c.out)[1]?.result as { content: [{ text: string }] };
  expect(JSON.parse(result.content[0].text).error.code).toBe(
    "refresh_disabled",
  );
});

it("mcp's text block is the JSON hakutaku query prints", async () => {
  const query = capture();
  expect(
    await main(
      ["query", "code_explain", "tiny", "--args", '{"target":"solve"}'],
      query.io,
    ),
  ).toBe(0);
  const stdin = new PassThrough();
  const { c, io } = capture(stdin);
  const done = main(["mcp", "tiny"], io);
  stdin.write(line(INIT));
  stdin.write(line(call(2, "code_explain", { repo: "tiny", target: "solve" })));
  await vi.waitFor(() => expect(messages(c.out)).toHaveLength(2));
  stdin.end();
  expect(await done).toBe(0);
  const result = messages(c.out)[1]?.result as { content: [{ text: string }] };
  expect(`${result.content[0].text}\n`).toBe(query.c.out);
});
