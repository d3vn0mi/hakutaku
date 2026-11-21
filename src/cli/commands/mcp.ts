// hakutaku mcp <id>... | --all [--allow-refresh]
// Serves the repos named, or every registered repo, as an MCP server over stdio until stdin ends.
// The repos are fixed at start. stdout carries only the protocol; usage errors and logs go to
// stderr. Exit codes: 0 once stdin ends, 1 failed (the message on stderr), 2 a usage error.
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { startMcpServer } from "../../mcp/index.js";
import { registryHost, UnknownRepoError } from "../../registry/index.js";
import type { CliIO, Command } from "./index.js";

const USAGE = "usage: hakutaku mcp <id>... | --all [--allow-refresh]\n";

const parse = (argv: string[]) =>
  parseArgs({
    args: argv,
    options: {
      all: { type: "boolean" },
      "allow-refresh": { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });

function usageError(io: CliIO, message: string): number {
  io.stderr(`hakutaku mcp: ${message}\n${USAGE}`);
  return 2;
}

async function run(argv: string[], io: CliIO): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    return usageError(
      io,
      error instanceof Error ? error.message : String(error),
    );
  }
  const { values, positionals: ids } = parsed;
  const all = values.all === true;
  if (ids.length === 0 && !all) {
    return usageError(io, "name the repos to serve, or pass --all");
  }
  if (ids.length > 0 && all) {
    return usageError(io, "pass repo ids or --all, not both");
  }
  let host: ReturnType<typeof registryHost>;
  try {
    host = registryHost({
      repos: all ? "all" : ids,
      allowRefresh: values["allow-refresh"] === true,
    });
  } catch (error) {
    if (!(error instanceof UnknownRepoError)) throw error;
    io.stderr(`hakutaku mcp: ${error.message}\n`);
    return 2;
  }
  // Listened for before the server starts to read, so that no end of stdin can come first.
  const ended = new Promise<void>((resolve) => {
    io.stdin.once("end", resolve);
    io.stdin.once("close", resolve);
  });
  const stdout = new Writable({
    decodeStrings: false,
    write(chunk, _encoding, callback) {
      io.stdout(String(chunk));
      callback();
    },
  });
  const server = await startMcpServer({ host, stdin: io.stdin, stdout });
  await ended;
  await server.close();
  return 0;
}

export const mcpCommand: Command = {
  name: "mcp",
  summary: "the MCP server over stdio, serving exactly the repos named",
  run,
};
