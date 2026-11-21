#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { isatty } from "node:tty";
import { fileURLToPath } from "node:url";
import { HAKUTAKU_VERSION } from "../version.js";
import { type CliIO, COMMANDS } from "./commands/index.js";

// The usage line, then one line per command: its name, then its summary, every summary starting
// in one column.
function usage(): string {
  const width = Math.max(0, ...COMMANDS.map((c) => c.name.length));
  const lines = [
    "usage: hakutaku <command> [options]",
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
  ];
  return `${lines.join("\n")}\n`;
}

function processIO(): CliIO {
  return {
    stdout: (s) => {
      process.stdout.write(s);
    },
    stderr: (s) => {
      process.stderr.write(s);
    },
    // A getter, so that a command that never reads stdin never opens it.
    get stdin() {
      return process.stdin;
    },
    env: process.env,
    isTTY: isatty(0) && isatty(1),
  };
}

export async function main(
  argv: string[],
  io: CliIO = processIO(),
): Promise<number> {
  const [name, ...rest] = argv;
  if (name === "--version") {
    io.stdout(`${HAKUTAKU_VERSION}\n`);
    return 0;
  }
  if (name === "--help") {
    io.stdout(usage());
    return 0;
  }
  const command = COMMANDS.find((c) => c.name === name);
  if (command === undefined) {
    if (name !== undefined) {
      io.stderr(`hakutaku: unknown command ${JSON.stringify(name)}\n`);
    }
    io.stderr(usage());
    return 2;
  }
  try {
    return await command.run(rest, io);
  } catch (error) {
    io.stderr(
      `hakutaku: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

function isEntryModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryModule()) {
  process.exitCode = await main(process.argv.slice(2));
}
