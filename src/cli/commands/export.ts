// hakutaku export <repo> --ref <ref> --out <dir> [--id <id>] [--profile <file>]
//                 [--rules <file>] [--max-files <n>]
// Writes one commit's export directory and prints the ExportResult as one JSON line. Exit
// codes: 0 done, 1 failed (the message on stderr), 2 a usage error.
import { parseArgs } from "node:util";
import { defaultRepoId, exportRepo } from "../../export/index.js";
import { REPO_ID_RE } from "../../model/index.js";
import type { CliIO, Command } from "./index.js";

const USAGE =
  "usage: hakutaku export <repo> --ref <ref> --out <dir> [--id <id>] [--profile <file>] [--rules <file>] [--max-files <n>]\n";

const OPTIONS = {
  ref: { type: "string" },
  out: { type: "string" },
  id: { type: "string" },
  profile: { type: "string" },
  rules: { type: "string" },
  "max-files": { type: "string" },
} as const;

function usageError(io: CliIO, message: string): number {
  io.stderr(`hakutaku export: ${message}\n${USAGE}`);
  return 2;
}

const parse = (argv: string[]) =>
  parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });

async function run(argv: string[], io: CliIO): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    return usageError(io, (error as Error).message);
  }
  const { values, positionals } = parsed;
  const [repo] = positionals;
  if (repo === undefined || positionals.length !== 1) {
    return usageError(io, `expected one <repo>, got ${positionals.length}`);
  }
  if (values.out === undefined) return usageError(io, "--out is required");
  for (const name of Object.keys(OPTIONS) as Array<keyof typeof OPTIONS>) {
    if (values[name] === "") return usageError(io, `--${name} is empty`);
  }
  const maxFiles = values["max-files"];
  if (
    maxFiles !== undefined &&
    !(/^[1-9][0-9]*$/.test(maxFiles) && Number.isSafeInteger(Number(maxFiles)))
  ) {
    return usageError(io, "--max-files must be a positive integer");
  }
  const id = values.id ?? defaultRepoId(repo);
  if (!REPO_ID_RE.test(id)) {
    return usageError(
      io,
      values.id === undefined
        ? `the folder name gives no valid repo id (${JSON.stringify(id)}); name one with --id`
        : `not a valid repo id: ${JSON.stringify(id)}`,
    );
  }
  const result = await exportRepo({
    repo,
    ref: values.ref ?? "HEAD",
    out: values.out,
    id,
    ...(values.profile === undefined ? {} : { profile: values.profile }),
    ...(values.rules === undefined ? {} : { rules: values.rules }),
    ...(maxFiles === undefined ? {} : { maxFiles: Number(maxFiles) }),
  });
  io.stdout(`${JSON.stringify(result)}\n`);
  return 0;
}

export const exportCommand: Command = {
  name: "export",
  summary: "write one commit's snapshot, history, profile and engine configs",
  run,
};
