import { doctorCommand } from "./doctor.js";
import { enginesCommand } from "./engines.js";
import { exportCommand } from "./export.js";
import { extractCommand } from "./extract.js";
import { listCommand } from "./list.js";
import { mapCommand } from "./map.js";
import { mcpCommand } from "./mcp.js";
import { profileCommand } from "./profile.js";
import { queryCommand } from "./query.js";

export interface CliIO {
  stdout(s: string): void;
  stderr(s: string): void;
  stdin: NodeJS.ReadableStream;
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  // Calls listener with each error of the stream behind stdout, such as EPIPE once its reader
  // has gone. Such an error comes after stdout has returned, so a command that must end on it
  // listens here. On the process's own stdout, an error that nothing listens for ends the
  // process.
  onStdoutError?(listener: (error: Error) => void): void;
}

export interface Command {
  name: string;
  summary: string;
  run(argv: string[], io: CliIO): Promise<number>;
}

// The order is fixed: map, view, mcp, query, list, profile, engines, export, extract, doctor.
export const COMMANDS: readonly Command[] = [
  mapCommand,
  mcpCommand,
  queryCommand,
  listCommand,
  profileCommand,
  enginesCommand,
  exportCommand,
  extractCommand,
  doctorCommand,
];
