// The MCP server: hakutaku's tools over stdio. It uses the SDK's low-level Server, which
// registers each tool's plain JSON Schema as it is. Every call goes to runTool, and its answer or
// error goes back as one text block holding the same JSON that hakutaku query prints. The server
// starts no process and opens no socket; a refresh build is the host's to run.
import type { Readable, Writable } from "node:stream";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  type Host,
  runTool,
  TOOL_SPECS,
  type ToolResult,
} from "../tools/index.js";
import { HAKUTAKU_VERSION } from "../version.js";
import { MCP_INSTRUCTIONS } from "./instructions.js";

// What tools/list answers: each tool's name, description, input schema and annotations, as
// TOOL_SPECS has them.
const TOOLS = TOOL_SPECS.map(
  ({ name, description, inputSchema, annotations }) => ({
    name,
    description,
    inputSchema,
    annotations,
  }),
);

// Whether a call's result goes out marked untrustedContent in _meta: every answer, and every
// error except internal and refresh_disabled, whose wording is fixed. The other errors can quote
// candidates' IDs, stored paths or repo ids, so the rule names the two that never do rather than
// the many that may. The mark sits beside the text block, never inside it,
// so the text stays the JSON hakutaku query prints.
export function markedUntrusted(result: ToolResult): boolean {
  return (
    result.ok ||
    (result.error.code !== "internal" &&
      result.error.code !== "refresh_disabled")
  );
}

// An exception inside runTool, which answers it as internal: the details go to stderr, the
// host's log, and never into an answer or onto stdout, which carries only the protocol.
function logInternal(err: unknown): void {
  const detail =
    err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`hakutaku mcp: internal error: ${detail}\n`);
}

function callResult(host: Host, name: string, args: unknown) {
  const result = runTool(host, null, name, args, logInternal);
  const json = result.ok ? result.answer : { error: result.error };
  const content = [
    { type: "text" as const, text: JSON.stringify(json, null, 2) },
  ];
  const meta = markedUntrusted(result)
    ? { _meta: { untrustedContent: true } }
    : {};
  return result.ok ? { content, ...meta } : { isError: true, content, ...meta };
}

export async function startMcpServer(opts: {
  host: Host;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}): Promise<{ close(): Promise<void> }> {
  const server = new Server(
    { name: "hakutaku", version: HAKUTAKU_VERSION },
    { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    callResult(opts.host, request.params.name, request.params.arguments),
  );
  // The transport reads with on, off, listenerCount and pause, and writes with write and once,
  // which every Node stream has, so either kind of stream serves.
  const transport = new StdioServerTransport(
    (opts.stdin ?? process.stdin) as Readable,
    (opts.stdout ?? process.stdout) as Writable,
  );
  await server.connect(transport);
  return {
    close: async () => {
      // Requests already written are answered first. Their handlers run in microtasks, which
      // all finish before the next turn of the event loop; closing aborts any still running and
      // drops its response.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await server.close();
    },
  };
}
