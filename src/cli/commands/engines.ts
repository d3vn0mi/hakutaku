// hakutaku engines install|list|verify [--engines-dir <path>] [--deep] [--yes]
// install fetches the pinned engines into the engines directory, after asking; list prints one
// row per engine; verify prints each problem. Exit codes: 0 done, 1
// failed or not confirmed (the message on stderr), 2 a usage error.
import { parseArgs } from "node:util";
import {
  defaultEnginesDir,
  installEngines,
  listEngines,
  readInstalled,
  verifyEngines,
} from "../../engines/index.js";
import { confirm } from "../prompt.js";
import { formatTable } from "../table.js";
import type { CliIO, Command } from "./index.js";

// The first-run question, asked before anything is fetched.
export const ENGINES_QUESTION =
  "hakutaku needs scip-typescript, dependency-cruiser and ast-grep (npm) and grimp (PyPI). Install the pinned versions now? [y/N]";

const USAGE =
  "usage: hakutaku engines install|list|verify [--engines-dir <path>] [--deep] [--yes]\n";

const SUBCOMMANDS = ["install", "list", "verify"];

const OPTIONS = {
  "engines-dir": { type: "string" },
  deep: { type: "boolean" },
  yes: { type: "boolean" },
} as const;

function usageError(io: CliIO, message: string): number {
  io.stderr(`hakutaku engines: ${message}\n${USAGE}`);
  return 2;
}

const parse = (argv: string[]) =>
  parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });

// Already installed: every engine verifies, by its version too, and grimp is installed. An
// install that found no Python is done again, so that a Python installed since is used.
function installed(dir: string, deep: boolean): boolean {
  return (
    verifyEngines(dir, { deep }).ok &&
    (readInstalled(dir)?.python ?? null) !== null
  );
}

async function install(
  io: CliIO,
  dir: string,
  deep: boolean,
  yes: boolean,
): Promise<number> {
  if (installed(dir, deep)) {
    io.stderr(`the engines are already installed in ${dir}\n`);
    return 0;
  }
  return askToInstall(io, dir, deep, yes);
}

// Installs the engines into dir once the person agrees: --yes agrees for scripts, a terminal is
// asked the question, and anything else is told to re-run with --yes. 0 once installed, 1 when
// not agreed. hakutaku map calls it too, when the engines it needs are missing.
export async function askToInstall(
  io: CliIO,
  dir: string,
  deep: boolean,
  yes: boolean,
): Promise<number> {
  if (!yes) {
    if (!io.isTTY) {
      io.stderr(`${ENGINES_QUESTION}\nre-run with --yes\n`);
      return 1;
    }
    if (!(await confirm(io, ENGINES_QUESTION))) {
      io.stderr("the engines were not installed\n");
      return 1;
    }
  }
  io.stderr(`installing the engines in ${dir}\n`);
  await installEngines({
    dir,
    deep,
    yes: true,
    log: (line) => io.stderr(`${line}\n`),
  });
  io.stderr(`installed the engines in ${dir}\n`);
  return 0;
}

// engine, version, min detail and installed, as a table.
function table(dir: string): string {
  return formatTable([
    ["engine", "version", "min detail", "installed"],
    ...listEngines(dir).map((r) => [
      r.engine,
      r.version,
      r.minDetail,
      r.installed ? "yes" : "no",
    ]),
  ]);
}

async function run(argv: string[], io: CliIO): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    return usageError(io, (error as Error).message);
  }
  const { values, positionals } = parsed;
  const [subcommand] = positionals;
  if (subcommand === undefined || positionals.length !== 1) {
    return usageError(
      io,
      `expected one of install, list or verify, got ${positionals.length}`,
    );
  }
  if (!SUBCOMMANDS.includes(subcommand)) {
    return usageError(io, `unknown subcommand ${JSON.stringify(subcommand)}`);
  }
  if (values["engines-dir"] === "") {
    return usageError(io, "--engines-dir is empty");
  }
  const dir = values["engines-dir"] ?? defaultEnginesDir();
  const deep = values.deep ?? false;
  if (subcommand === "list") {
    io.stdout(table(dir));
    return 0;
  }
  if (subcommand === "verify") {
    const { ok, problems } = verifyEngines(dir, { deep });
    for (const problem of problems) io.stderr(`${problem}\n`);
    return ok ? 0 : 1;
  }
  return install(io, dir, deep, values.yes ?? false);
}

export const enginesCommand: Command = {
  name: "engines",
  summary: "install, list or verify the pinned engines",
  run,
};
