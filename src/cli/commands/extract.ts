// hakutaku extract <dir> --out <store> [--engines-dir <path>] [--detail quick|standard|deep]
//                  [--no-source] [--sandbox auto|require|none] [--memory-max <size>]
// Builds one store from an export directory and prints the ExtractResult as one JSON line.
// Exit codes: 0 built or skipped, 3 the gates failed (the previous store keeps serving), 1
// failed (the message on stderr), 2 a usage error. --sandboxed-by bubblewrap|systemd-run,
// --memory-capped, --home <path> and --current-unresolved <n> are left out of the usage: extract
// passes them to itself when it re-runs inside a sandbox, to say which one, whether it caps
// memory, the home directory the build's texts name as ~, and the current store's unresolved
// imports, which the re-run cannot read.
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { heapMiB } from "../../extract/drivers/scip-typescript.js";
import { type ExtractResult, extractSnapshot } from "../../extract/index.js";
import { SandboxedRunFailed } from "../../extract/rerun.js";
import type { Detail } from "../../model/index.js";
import type { CliIO, Command } from "./index.js";

const USAGE =
  "usage: hakutaku extract <dir> --out <store> [--engines-dir <path>] [--detail quick|standard|deep] [--no-source] [--sandbox auto|require|none] [--memory-max <size>]\n";

const OPTIONS = {
  out: { type: "string" },
  "engines-dir": { type: "string" },
  detail: { type: "string" },
  "no-source": { type: "boolean" },
  sandbox: { type: "string" },
  "memory-max": { type: "string" },
  "sandboxed-by": { type: "string" },
  "memory-capped": { type: "boolean" },
  home: { type: "string" },
  "current-unresolved": { type: "string" },
} as const;

const DETAILS = ["quick", "standard", "deep"] as const;
const SANDBOX_MODES = ["auto", "require", "none"] as const;
const SANDBOX_KINDS = ["bubblewrap", "systemd-run"] as const;

function usageError(io: CliIO, message: string): number {
  io.stderr(`hakutaku extract: ${message}\n${USAGE}`);
  return 2;
}

const parse = (argv: string[]) =>
  parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });

// The value when it is one of the allowed ones, else undefined.
function oneOf<T extends string>(
  allowed: readonly T[],
  value: string,
): T | undefined {
  return (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

const listed = (allowed: readonly string[]): string =>
  `${allowed.slice(0, -1).join(", ")} or ${allowed.at(-1)}`;

async function run(argv: string[], io: CliIO): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    return usageError(io, (error as Error).message);
  }
  const { values, positionals } = parsed;
  const [dir] = positionals;
  if (dir === undefined || positionals.length !== 1) {
    return usageError(io, `expected one <dir>, got ${positionals.length}`);
  }
  if (values.out === undefined) return usageError(io, "--out is required");
  for (const name of Object.keys(OPTIONS) as Array<keyof typeof OPTIONS>) {
    if (values[name] === "") return usageError(io, `--${name} is empty`);
  }
  const choose = <T extends string>(
    flag: string,
    allowed: readonly T[],
    value: string | undefined,
  ): T | undefined | null => {
    if (value === undefined) return undefined;
    const chosen = oneOf(allowed, value);
    if (chosen === undefined) {
      usageError(
        io,
        `--${flag} must be ${listed(allowed)}, not ${JSON.stringify(value)}`,
      );
      return null;
    }
    return chosen;
  };
  const detail = choose<Detail>("detail", DETAILS, values.detail);
  if (detail === null) return 2;
  const sandbox = choose("sandbox", SANDBOX_MODES, values.sandbox);
  if (sandbox === null) return 2;
  const sandboxedBy = choose(
    "sandboxed-by",
    SANDBOX_KINDS,
    values["sandboxed-by"],
  );
  if (sandboxedBy === null) return 2;
  const home = values.home;
  if (home !== undefined && !isAbsolute(home)) {
    return usageError(
      io,
      `--home must be an absolute path, not ${JSON.stringify(home)}`,
    );
  }
  const unresolved = values["current-unresolved"];
  let currentUnresolved: number | undefined;
  if (unresolved !== undefined) {
    currentUnresolved = Number(unresolved);
    if (!/^\d+$/.test(unresolved) || !Number.isSafeInteger(currentUnresolved)) {
      return usageError(
        io,
        `--current-unresolved must be a whole number, not ${JSON.stringify(unresolved)}`,
      );
    }
  }
  const memoryMax = values["memory-max"];
  if (memoryMax !== undefined) {
    // systemd takes a percentage or "infinity", from which Node's heap cannot be worked out
    try {
      heapMiB(memoryMax);
    } catch (error) {
      return usageError(io, (error as Error).message);
    }
  }
  let result: ExtractResult;
  try {
    result = await extractSnapshot({
      dir,
      out: values.out,
      ...(values["engines-dir"] === undefined
        ? {}
        : { enginesDir: values["engines-dir"] }),
      ...(detail === undefined ? {} : { detail }),
      noSource: values["no-source"] ?? false,
      ...(sandbox === undefined ? {} : { sandbox }),
      ...(memoryMax === undefined ? {} : { memoryMax }),
      ...(sandboxedBy === undefined ? {} : { sandboxedBy }),
      ...(values["memory-capped"] === true ? { memoryCapped: true } : {}),
      ...(home === undefined ? {} : { home }),
      ...(currentUnresolved === undefined ? {} : { currentUnresolved }),
    });
  } catch (error) {
    // a sandboxed run that printed its own message, on the stderr passed through, is not
    // repeated; one stopped before it could print is reported here
    if (error instanceof SandboxedRunFailed && error.printed) return 1;
    throw error;
  }
  io.stdout(`${JSON.stringify(result)}\n`);
  return result.result === "gates-failed" ? 3 : 0;
}

export const extractCommand: Command = {
  name: "extract",
  summary: "build one store from an export directory, gated and swapped in",
  run,
};
