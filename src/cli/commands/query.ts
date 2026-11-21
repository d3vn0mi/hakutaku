// hakutaku query <tool> <id> [--args '<json>']
// Runs one tool on one registered repo and prints its answer, or its error, as the JSON an MCP
// client finds in the result's text block. --args is the tool's arguments object, and repo is
// set to <id> when it names none. Exit codes: 0 answered, 1 failed (the message on stderr), 2 a
// usage error, 4 the tool answered an error (the error JSON on stdout).
import { parseArgs } from "node:util";
import { registryHost, UnknownRepoError } from "../../registry/index.js";
import { runTool } from "../../tools/index.js";
import { errorDetail, printable } from "../table.js";
import type { CliIO, Command } from "./index.js";

const USAGE = "usage: hakutaku query <tool> <id> [--args '<json>']\n";

const parse = (argv: string[]) =>
  parseArgs({
    args: argv,
    options: { args: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });

async function run(argv: string[], io: CliIO): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.stderr(`hakutaku query: ${printable(messageOf(error))}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [tool, id] = positionals;
  if (tool === undefined || id === undefined || positionals.length > 2) {
    io.stderr(USAGE);
    return 2;
  }
  let given: unknown;
  try {
    given = JSON.parse(values.args ?? "{}");
  } catch {
    io.stderr("hakutaku query: --args is not valid JSON\n");
    return 2;
  }
  let host: ReturnType<typeof registryHost>;
  try {
    host = registryHost({ repos: [id], allowRefresh: false });
  } catch (error) {
    if (!(error instanceof UnknownRepoError)) throw error;
    io.stderr(`hakutaku query: ${printable(error.message)}\n`);
    return 2;
  }
  const result = runTool(host, null, tool, withRepo(tool, id, given), (err) =>
    io.stderr(`hakutaku query: internal error: ${errorDetail(err)}\n`),
  );
  if (result.ok) {
    io.stdout(`${JSON.stringify(result.answer, null, 2)}\n`);
    return 0;
  }
  io.stdout(`${JSON.stringify({ error: result.error }, null, 2)}\n`);
  return 4;
}

// The arguments as given, with repo set to the id when they are an object and the tool takes a
// repo, as every tool but code_repos does; repo comes first, so one the arguments name replaces
// it. Anything else goes to the tool as it is, which answers what is wrong with it.
function withRepo(tool: string, id: string, given: unknown): unknown {
  if (
    tool === "code_repos" ||
    typeof given !== "object" ||
    given === null ||
    Array.isArray(given)
  ) {
    return given;
  }
  return { repo: id, ...given };
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const queryCommand: Command = {
  name: "query",
  summary: "any tool, from a shell, with the same JSON as over MCP",
  run,
};
