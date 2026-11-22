// hakutaku profile <repo> [--ref <ref>] [--out <file>]
// Generates a checkout's layout profile, for review: the ref is exported, without a profile, into
// a temporary directory in hakutaku's cache, and the profile generated from it is written to
// --out, or to the profile of the repo's id, the one map reads. Prints what was found, each
// warning (on stderr), and the file written. A conflict is printed instead, on stderr, and
// nothing is written. Exit codes: 0 written, 1 failed or a conflict, 2 a usage error.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  defaultRepoId,
  exportRepo,
  isRepoTop,
  ProfileConflictError,
  removeTree,
} from "../../export/index.js";
import { REPO_ID_RE, type RepoId } from "../../model/index.js";
import { type GenerateResult, generateProfile } from "../../profile/index.js";
import {
  hakutakuDirs,
  loadRegistry,
  profilePathFor,
} from "../../registry/index.js";
import { printable } from "../table.js";
import type { CliIO, Command } from "./index.js";

const USAGE = "usage: hakutaku profile <repo> [--ref <ref>] [--out <file>]\n";

const OPTIONS = {
  ref: { type: "string" },
  out: { type: "string" },
} as const;

function usageError(io: CliIO, message: string): number {
  io.stderr(`hakutaku profile: ${printable(message)}\n${USAGE}`);
  return 2;
}

const parse = (argv: string[]) =>
  parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });

// The checkout's top level as an absolute path with no link in it, so that one checkout is one
// registered source however it is named. A path that is not a top level is refused, as export
// refuses it: git would walk up from it to whatever repo holds it.
export function checkoutTop(repo: string): string {
  let top: string;
  try {
    top = realpathSync(resolve(repo));
  } catch {
    top = resolve(repo);
  }
  if (!isRepoTop(top)) {
    throw new Error(`not a checkout's top level or a bare repo: ${repo}`);
  }
  return top;
}

// The id map gives a checkout when no --id is passed: its registered entry's, else its folder's.
export function idFor(top: string): RepoId {
  return (
    loadRegistry().repos.find((e) => e.source === top)?.id ?? defaultRepoId(top)
  );
}

// What generation found, as one line, then its warnings, each made safe for a terminal.
export function foundLine(found: GenerateResult["found"]): string {
  const list = (items: string[]): string =>
    items.length === 0 ? "none" : items.join(", ");
  return printable(
    `aliases ${found.aliases} \u00b7 python roots ${list(found.pythonRoots)} \u00b7 components ${list(found.components)} \u00b7 launch manifests ${found.launchManifests}`,
  );
}

// Each conflict, on its line, made safe for a terminal.
export function printConflicts(io: CliIO, error: ProfileConflictError): void {
  for (const conflict of error.conflicts) io.stderr(`${printable(conflict)}\n`);
}

// The bytes written to a temporary file beside the target, then renamed over it, so that a build
// reading the profile meanwhile finds the old one or the new one, never a part of either. What
// is at the temporary name is removed first, and the file is created only where nothing is, so a
// link left there is never written through.
export function writeWhole(file: string, bytes: Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    rmSync(tmp, { force: true });
    writeFileSync(tmp, bytes, { flag: "wx" });
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

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
  for (const name of Object.keys(OPTIONS) as Array<keyof typeof OPTIONS>) {
    if (values[name] === "") return usageError(io, `--${name} is empty`);
  }
  const top = checkoutTop(repo);
  const id = idFor(top);
  if (values.out === undefined && !REPO_ID_RE.test(id)) {
    return usageError(
      io,
      `the folder name gives no valid repo id (${JSON.stringify(id)}); name a file with --out`,
    );
  }
  const target =
    values.out === undefined ? profilePathFor(id) : resolve(values.out);
  const cache = hakutakuDirs(process.env).cache;
  mkdirSync(cache, { recursive: true });
  const tmp = mkdtempSync(join(cache, "profile-"));
  try {
    const out = join(tmp, "export");
    try {
      await exportRepo({
        repo: top,
        ref: values.ref ?? "HEAD",
        out,
        // the id names nothing outside the temporary export
        id: REPO_ID_RE.test(id) ? id : "repo",
      });
    } catch (error) {
      if (!(error instanceof ProfileConflictError)) throw error;
      printConflicts(io, error);
      return 1;
    }
    const generated = await generateProfile(join(out, "snapshot"));
    writeWhole(target, readFileSync(join(out, "profile.json")));
    io.stdout(`${foundLine(generated.found)}\n`);
    for (const warning of generated.warnings) {
      io.stderr(`${printable(warning)}\n`);
    }
    io.stdout(`wrote ${printable(target)}\n`);
    return 0;
  } finally {
    removeTree(tmp);
  }
}

export const profileCommand: Command = {
  name: "profile",
  summary: "generate or regenerate a repo's layout profile, for review",
  run,
};
