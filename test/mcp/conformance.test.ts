// hakutaku mcp as an MCP client sees it: the built CLI serving the observatory sample over stdio,
// with the sample registered in XDG directories of its own, driven by the MCP SDK's client. It
// lists the tools as their specs have them, names itself, gives its instructions, answers each
// golden call with the golden's JSON byte for byte, and ends quietly when the client stops
// reading its stdout. Run `npm run build` first, and `node dist/cli/main.js engines install
// --yes` once: the sample is built with the engines' Python, and where that Python does not start
// the tests are skipped, and in CI they fail.
import { spawn } from "node:child_process";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MCP_INSTRUCTIONS } from "../../src/mcp/instructions.js";
import { markedUntrusted } from "../../src/mcp/server.js";
import {
  type ReposAnswer,
  TOOL_NAMES,
  TOOL_SPECS,
} from "../../src/tools/index.js";
import { HAKUTAKU_VERSION } from "../../src/version.js";
import { requireInCI } from "../helpers/live.js";
import {
  call,
  goldenReplays,
  NODE_ARGS,
  REPO_ROOT,
  readGolden,
  type StdioSession,
  startStdioClient,
} from "../helpers/mcp-client.js";
import { sampleEnv, samplePythonProbe } from "../helpers/sample.js";

const PYTHON = samplePythonProbe();
const BUILD_TIMEOUT = 600_000;
const REPO = "observatory";

let env: NodeJS.ProcessEnv = {};
let session: StdioSession | undefined;

// The sample, registered and served. Without the engines' Python nothing is built or started,
// and each test skips, or fails in CI, through requireInCI.
beforeAll(async () => {
  if (!PYTHON.ok) return;
  env = (await sampleEnv()).env;
  session = await startStdioClient({ args: ["mcp", REPO], env });
}, BUILD_TIMEOUT);

afterAll(async () => {
  await session?.close();
});

function served(): StdioSession {
  if (session === undefined) throw new Error("the server was not started");
  return session;
}

it("lists the 13 tools in order, each with its spec's input schema and annotations", async (ctx) => {
  requireInCI(ctx, PYTHON);
  const { tools } = await served().client.listTools();
  expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
  for (const spec of TOOL_SPECS) {
    const tool = tools.find((t) => t.name === spec.name);
    expect(tool?.inputSchema, spec.name).toEqual(spec.inputSchema);
    expect(tool?.annotations, spec.name).toEqual(spec.annotations);
  }
});

it("names itself hakutaku at this version, and gives its instructions", (ctx) => {
  requireInCI(ctx, PYTHON);
  const { client } = served();
  expect(client.getServerVersion()).toEqual({
    name: "hakutaku",
    version: HAKUTAKU_VERSION,
  });
  expect(client.getInstructions()).toBe(MCP_INSTRUCTIONS);
});

// Each golden call over stdio: the text block is the golden's JSON, isError is set exactly for an
// error, and _meta marks the result untrustedContent exactly where the server's rule says so.
for (const replay of goldenReplays()) {
  it(`answers ${replay.key} over stdio as its golden file has it`, async (ctx) => {
    requireInCI(ctx, PYTHON);
    const r = await call(served().client, replay.tool, replay.args);
    expect(r.text).toBe(replay.text);
    expect(r.isError).toBe(!replay.result.ok);
    expect(r.untrusted).toBe(markedUntrusted(replay.result));
  });
}

it("lists the sample as fresh, at the commit its golden answer was built at", async (ctx) => {
  requireInCI(ctx, PYTHON);
  const golden = readGolden("code_repos/all").result;
  if (!("answer" in golden)) throw new Error("code_repos/all is an error");
  const r = await call(served().client, "code_repos", {});
  expect(r.isError).toBe(false);
  const { repos }: ReposAnswer = JSON.parse(r.text);
  expect(repos[0]).toMatchObject({
    id: REPO,
    stale: false,
    builtCommit: (golden.answer as ReposAnswer).repos[0]?.builtCommit,
  });
});

// A client that closes its read end of the server's stdout, as one that stops reading does: the
// server's next answers fail with EPIPE, and the session must end on its own, with exit 0 and
// nothing on stderr, while its stdin is still open.
it("ends the session quietly, with exit 0, when the client stops reading its stdout", async (ctx) => {
  requireInCI(ctx, PYTHON);
  const child = spawn(process.execPath, [...NODE_ARGS, "mcp", REPO], {
    cwd: REPO_ROOT,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  // the requests below may reach a server that has already ended
  child.stdin.on("error", () => {});
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (s: string) => {
    stderr += s;
  });
  const ended = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  const initialized = new Promise<void>((resolve) => {
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (s: string) => {
      out += s;
      const lines = out.split("\n").slice(0, -1);
      if (lines.some((l) => JSON.parse(l).id === 1)) resolve();
    });
  });
  const send = (message: object): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "hakutaku-tests", version: "0.0.0" },
    },
  });
  await initialized;
  child.stdout.destroy();
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "code_overview", arguments: { repo: REPO } },
  });
  send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "code_find", arguments: { repo: REPO, name: "position" } },
  });
  // stdin stays open; a server that never ends is stopped, and the test fails
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    expect(await ended).toEqual({ code: 0, signal: null });
  } finally {
    clearTimeout(timer);
  }
  expect(stderr).toBe("");
});
