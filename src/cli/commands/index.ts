import { enginesCommand } from "./engines.js";
import { exportCommand } from "./export.js";

export interface CliIO {
  stdout(s: string): void;
  stderr(s: string): void;
  stdin: NodeJS.ReadableStream;
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
}

export interface Command {
  name: string;
  summary: string;
  run(argv: string[], io: CliIO): Promise<number>;
}

// The order is fixed: map, list, profile, engines, export, extract, doctor.
export const COMMANDS: readonly Command[] = [enginesCommand, exportCommand];
