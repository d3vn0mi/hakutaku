#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { isatty } from "node:tty";
import { fileURLToPath } from "node:url";
import { HAKUTAKU_VERSION } from "../version.js";
import { type CliIO, COMMANDS } from "./commands/index.js";
import { printable, printableLines } from "./table.js";

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
    // process.stderr too stays writable after an error. Its listener also hears the writes other
    // modules make to process.stderr directly.
    onStderrError: (listener) => {
      process.stderr.on("error", listener);
    },
    // Set as the process exits, after the entry block has set main's code, which would undo it.
    failExitCode: () => {
      process.once("exit", () => {
        if (Number(process.exitCode ?? 0) === 0) process.exitCode = 1;
      });
    },
  };
}

// Whether an error of stdout or stderr says that its reader has gone, as a pipe's does once the
// command reading it exits early, such as head: EPIPE, or ECONNRESET on a socket.
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

// io as a command sees it, with stdout and stderr each cut at the first error of the stream behind
// it: what is written to it after that is dropped, never buffered. Only that first error counts,
// since the others follow from it. One that says the reader has gone ends that output quietly.
// Any other fails the run, through failed() before main returns and failExitCode after: stdout's
// is said once on stderr, unless stderr is cut too, and stderr's cannot be said at all.
function guardOutput(io: CliIO): { io: CliIO; failed(): boolean } {
  let failed = false;
  const fail = (): void => {
    failed = true;
    io.failExitCode?.();
  };
  let stderrCut = false;
  io.onStderrError?.((error) => {
    if (stderrCut) return;
    stderrCut = true;
    if (!readerGone(error)) fail();
  });
  const stderr = (s: string): void => {
    if (!stderrCut) io.stderr(s);
  };
  let stdoutCut = false;
  io.onStdoutError?.((error) => {
    if (stdoutCut) return;
    stdoutCut = true;
    if (readerGone(error)) return;
    stderr(
      `hakutaku: cannot write to stdout: ${printable(stdoutFailure(error))}\n`,
    );
    fail();
  });
  return {
    io: {
      stdout: (s) => {
        if (!stdoutCut) io.stdout(s);
      },
      stderr,
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
  // Before anything is written, so that every path has its stdout's and stderr's errors heard.
  const output = guardOutput(io);
  const code = await dispatch(argv, output.io);
  return code === 0 && output.failed() ? 1 : code;
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
      // JSON.stringify writes C0 controls as escapes, but leaves DEL, C1 controls, the line
      // separators and the bidirectional controls raw
      io.stderr(
        `hakutaku: unknown command ${printable(JSON.stringify(name))}\n`,
      );
    }
    io.stderr(usage());
    return 2;
  }
  try {
    return await command.run(rest, io);
  } catch (error) {
    io.stderr(`hakutaku: ${errorLines(error)}\n`);
    return 1;
  }
}

// An error's message with its line breaks kept, CRLF and a lone CR each as LF, and every line made
// safe for a terminal: a message can name a repository's path, whose control characters would
// otherwise reach it.
function errorLines(error: unknown): string {
  return printableLines(error instanceof Error ? error.message : String(error));
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
