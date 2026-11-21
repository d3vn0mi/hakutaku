#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { isatty } from "node:tty";
import { fileURLToPath } from "node:url";
import { HAKUTAKU_VERSION } from "../version.js";
import { type CliIO, COMMANDS } from "./commands/index.js";
import { printable } from "./table.js";

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

// The process's own streams, environment and terminal.
export function processIO(): CliIO {
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
    // process.stdout stays writable after an error, so a later write can fail again; the
    // listener stays for every one.
    onStdoutError: (listener) => {
      process.stdout.on("error", listener);
    },
    // Set as the process exits, after the entry block has set main's code, which would undo it.
    failExitCode: () => {
      process.once("exit", () => {
        if (Number(process.exitCode ?? 0) === 0) process.exitCode = 1;
      });
    },
  };
}

// Whether a stdout error says that its reader has gone, as a pipe's does once the command reading
// it exits early, such as head: EPIPE, or ECONNRESET on a socket.
function readerGone(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPIPE" || code === "ECONNRESET";
}

// A stdout error as main names it: its code, such as ENOSPC, or else its message.
function stdoutFailure(error: Error): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && code !== "") return code;
  return error instanceof Error ? error.message : String(error);
}

// io as a command sees it, with stdout cut at the first error of the stream behind it: what is
// written after that is dropped, never buffered. Only that first error counts, since the others
// follow from it. One that says the reader has gone ends the output quietly; any other is said
// once on stderr and fails the run, through failed() before main returns and failExitCode after.
function guardStdout(io: CliIO): { io: CliIO; failed(): boolean } {
  let cut = false;
  let failed = false;
  io.onStdoutError?.((error) => {
    if (cut) return;
    cut = true;
    if (readerGone(error)) return;
    failed = true;
    io.stderr(
      `hakutaku: cannot write to stdout: ${printable(stdoutFailure(error))}\n`,
    );
    io.failExitCode?.();
  });
  return {
    io: {
      stdout: (s) => {
        if (!cut) io.stdout(s);
      },
      stderr: (s) => io.stderr(s),
      // A getter, as processIO's is, so that a command that never reads stdin never opens it.
      get stdin() {
        return io.stdin;
      },
      env: io.env,
      isTTY: io.isTTY,
      onStdoutError: (listener) => io.onStdoutError?.(listener),
    },
    failed: () => failed,
  };
}

export async function main(
  argv: string[],
  io: CliIO = processIO(),
): Promise<number> {
  // Before anything is written, so that every path has its stdout's errors heard.
  const stdout = guardStdout(io);
  const code = await dispatch(argv, stdout.io);
  return code === 0 && stdout.failed() ? 1 : code;
}

async function dispatch(argv: string[], io: CliIO): Promise<number> {
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
