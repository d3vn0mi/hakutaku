// The built CLI's MCP server for tests: hakutaku started from dist/ over stdio, as an MCP client
// starts it, and driven by the MCP SDK's own client; under strace when a test asks, to see every
// file, process and socket the server touches. What the server writes on stderr is kept for the
// test. Run `npm run build` before any test that imports this file: it throws when it loads and
// dist/cli/main.js is missing.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolError, ToolName, ToolResult } from "../../src/tools/index.js";
import { CASES } from "../golden/cases.js";
import { commandProbe, type LiveProbe, requireInCI } from "./live.js";

// hakutaku's root, which the server runs in.
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const DIST_MAIN: string = (() => {
  const path = join(REPO_ROOT, "dist", "cli", "main.js");
  if (!existsSync(path)) {
    throw new Error("run npm run build first: dist/cli/main.js is missing");
  }
  return path;
})();

// What node runs: the CLI, with Node's warning that node:sqlite is experimental turned off.
// Node 22 prints it on stderr in every run, and stderr should hold only what hakutaku wrote.
export const NODE_ARGS: readonly string[] = [
  "--disable-warning=ExperimentalWarning",
  DIST_MAIN,
];

// What strace records: every process started, every call that names a file, and every socket.
const TRACE = "trace=execve,execveat,%file,%network";

// strace starts and prints its version.
export function hasStrace(): boolean {
  return spawnSync("strace", ["-V"], { stdio: "ignore" }).status === 0;
}

let straceProbe: LiveProbe | undefined;

// Called first by a test that runs the server under strace, with the test's context. Where strace
// cannot trace a process here, as where ptrace is not allowed, the test is skipped with a note;
// in CI it fails instead (requireInCI).
export function needStrace(ctx: { skip: (note?: string) => never }): void {
  straceProbe ??= commandProbe("strace that can trace a process", [
    "strace",
    "-f",
    "-qq",
    "-o",
    "/dev/null",
    "true",
  ]);
  requireInCI(ctx, straceProbe);
}

export interface StdioSession {
  client: Client;
  t0: number; // epoch seconds, taken once initialize has been answered
  stderr(): string; // what the server, and strace, wrote on stderr so far
  close(): Promise<void>; // resolves once the child, and strace, have exited
}

// Starts `node dist/cli/main.js ...args` in hakutaku's root, with env as its whole environment,
// and connects the SDK's client to it, which sends initialize. With straceLog, strace starts it
// instead, following every thread and child, and writes the trace there with epoch timestamps.
export async function startStdioClient(opts: {
  args: string[];
  env: NodeJS.ProcessEnv;
  straceLog?: string;
}): Promise<StdioSession> {
  const node = [process.execPath, ...NODE_ARGS, ...opts.args];
  const argv =
    opts.straceLog === undefined
      ? node
      : [
          "strace",
          "-f",
          "-ttt",
          "-qq",
          "-e",
          TRACE,
          "-o",
          opts.straceLog,
          ...node,
        ];
  const transport = new StdioClientTransport({
    command: argv[0] ?? "",
    args: argv.slice(1),
    env: definedOnly(opts.env),
    cwd: REPO_ROOT,
    stderr: "pipe",
  });
  let stderr = "";
  const stream = transport.stderr;
  if (stream instanceof Readable) {
    stream.setEncoding("utf8").on("data", (s: string) => {
      stderr += s;
    });
  }
  // The transport calls onclose once the child has exited and its streams have closed. The
  // client keeps a handler set before it connects, and calls its own after it.
  const exited = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  const client = new Client({ name: "hakutaku-tests", version: "0.0.0" });
  try {
    await client.connect(transport);
  } catch (error) {
    await client.close();
    throw new Error(
      `the server did not start: ${error instanceof Error ? error.message : String(error)}\n${stderr}`,
    );
  }
  const t0 = Date.now() / 1000;
  return {
    client,
    t0,
    stderr: () => stderr,
    close: async () => {
      await client.close();
      await exited;
    },
  };
}

function definedOnly(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// One tools/call as a client sees it: the text of its one text block, whether it is an error,
// whether _meta marks it untrustedContent, and how long it took, in ms, from the client's side.
export interface Called {
  text: string;
  isError: boolean;
  untrusted: boolean;
  ms: number;
}

export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Called> {
  const start = performance.now();
  const result = await client.callTool({ name, arguments: args });
  const ms = performance.now() - start;
  const content: unknown = result.content;
  const block: unknown = Array.isArray(content) ? content[0] : undefined;
  if (
    !Array.isArray(content) ||
    content.length !== 1 ||
    typeof block !== "object" ||
    block === null ||
    !("type" in block) ||
    block.type !== "text" ||
    !("text" in block) ||
    typeof block.text !== "string"
  ) {
    throw new Error(`not one text block: ${JSON.stringify(result)}`);
  }
  const meta: unknown = result._meta;
  return {
    text: block.text,
    isError: result.isError === true,
    untrusted:
      typeof meta === "object" &&
      meta !== null &&
      "untrustedContent" in meta &&
      meta.untrustedContent === true,
    ms,
  };
}

// A golden file of test/golden, as golden.test.ts writes it.
export interface Golden {
  call: {
    tool: ToolName;
    args: Record<string, unknown>;
    detail: string;
    maxResultChars?: number;
  };
  result: { answer: object } | { error: ToolError };
}

export function readGolden(key: string): Golden {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, "test", "golden", `${key}.json`), "utf8"),
  );
}

// A golden call, to replay against the sample as hakutaku mcp serves it.
export interface Replay {
  key: string; // "<tool>/<name>"
  tool: ToolName;
  args: Record<string, unknown>; // as the golden file writes them, resolved
  result: ToolResult; // the golden's result, as runTool gave it
  text: string; // the text block that result goes out as
}

// The golden cases a client can replay against the sample served at the defaults, in the cases'
// order: every case but code_repos/all, whose builtAt and ref are the fixed host's, and those
// asked at another detail than standard or at a cap of their own.
export function goldenReplays(): Replay[] {
  return CASES.filter(
    (c) =>
      !(c.tool === "code_repos" && c.name === "all") &&
      c.detail === "standard" &&
      c.maxResultChars === undefined,
  ).map((c) => {
    const key = `${c.tool}/${c.name}`;
    const golden = readGolden(key);
    const result: ToolResult =
      "answer" in golden.result
        ? { ok: true, answer: golden.result.answer }
        : { ok: false, error: golden.result.error };
    const json = result.ok ? result.answer : { error: result.error };
    return {
      key,
      tool: golden.call.tool,
      args: golden.call.args,
      result,
      text: JSON.stringify(json, null, 2),
    };
  });
}

// One line of an strace log: its pid, its time in epoch seconds, the call's name and the first
// quoted argument, its path, where it has one; text is the whole line.
export interface TraceLine {
  pid: number;
  time: number;
  call: string;
  path?: string;
  text: string;
}

const TRACE_LINE = /^(?:(\d+) +)?(\d+\.\d+) (.*)$/;
const RESUMED = /^<\.\.\. ([A-Za-z0-9_]+) resumed>/;
const CALL = /^([A-Za-z0-9_]+)\(/;
const QUOTED = /"((?:[^"\\]|\\.)*)"/;

// The calls of an strace log written with -ttt, from the time since on, in the log's order. A
// call strace split in two gives two lines: the unfinished half, which holds the arguments, and
// the resumed half, which never gives a path, since what it quotes first is a result, such as
// the target readlink read. Signal and exit lines are left out.
export function readStrace(log: string, since: number): TraceLine[] {
  const lines: TraceLine[] = [];
  for (const text of readFileSync(log, "utf8").split("\n")) {
    const m = TRACE_LINE.exec(text);
    if (m === null) continue;
    const time = Number(m[2]);
    if (time < since) continue;
    const rest = m[3] ?? "";
    const resumed = RESUMED.exec(rest);
    const name = resumed?.[1] ?? CALL.exec(rest)?.[1];
    if (name === undefined) continue; // a signal (---) or an exit (+++)
    const line: TraceLine = { pid: Number(m[1] ?? 0), time, call: name, text };
    const quoted = resumed === null ? QUOTED.exec(rest) : null;
    if (quoted !== null) line.path = unquote(quoted[1] ?? "");
    lines.push(line);
  }
  return lines;
}

const ESCAPE = /\\(?:x([0-9a-fA-F]{2})|([0-7]{1,3})|([\s\S]))/g;
const NAMED_ESCAPES: Readonly<Record<string, number>> = {
  n: 10,
  t: 9,
  r: 13,
  v: 11,
  f: 12,
};

// A string as strace quotes it, unquoted: its escapes are bytes, and the bytes read as UTF-8.
function unquote(body: string): string {
  const parts: Buffer[] = [];
  let last = 0;
  for (const m of body.matchAll(ESCAPE)) {
    parts.push(Buffer.from(body.slice(last, m.index), "utf8"));
    const [whole, hex, octal, char = ""] = m;
    const byte =
      hex !== undefined
        ? Number.parseInt(hex, 16)
        : octal !== undefined
          ? Number.parseInt(octal, 8)
          : (NAMED_ESCAPES[char] ?? char.charCodeAt(0));
    parts.push(Buffer.from([byte]));
    last = m.index + whole.length;
  }
  parts.push(Buffer.from(body.slice(last), "utf8"));
  return Buffer.concat(parts).toString("utf8");
}
