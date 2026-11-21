// hakutaku map <repo> [--id <id>] [--ref <ref>] [--detail quick|standard|deep] [--no-source]
//                     [--no-snippets] [--sandbox auto|require|none] [--engines-dir <path>] [--yes]
// Builds a checkout's store and registers it, all under the build lock, so that one build runs
// at a time on this machine:
//  1. the checkout's top level; a registered entry with that source gives the defaults (its id,
//     ref, detail, sources, snippets and profile), and a flag overrides each;
//  2. the engines, installed once the person agrees when they are missing;
//  3. the commit, exported into the id's export directory for it, with the repo's profile; a repo
//     with none gets a generated one, kept as its profile for review, unless generation finds a
//     conflict, which is printed instead;
//  4. the store, extracted, gated and swapped in;
//  5. the registry entry;
//  6. the id's other export directories, removed;
//  7. the summary on stdout, or why the gates failed.
// Logs, the profile found and the gates' failure go to stderr. Exit codes: 0 built or skipped, 3
// the gates failed, 1 failed (the message on stderr), 2 a usage error.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { defaultEnginesDir, verifyEngines } from "../../engines/index.js";
import {
  defaultRepoId,
  type ExportResult,
  exportRepo,
  ProfileConflictError,
  removeTree,
  resolveCommit,
} from "../../export/index.js";
import {
  type ExtractResult,
  extractSnapshot,
  type SandboxMode,
} from "../../extract/index.js";
import { SandboxedRunFailed } from "../../extract/rerun.js";
import { type Detail, REPO_ID_RE } from "../../model/index.js";
import { generateProfile } from "../../profile/index.js";
import {
  createRefReader,
  exportDirFor,
  loadRegistry,
  profilePathFor,
  saveEntry,
  storePathFor,
  withBuildLock,
} from "../../registry/index.js";
import { openStore, readBuildFacts } from "../../store/index.js";
import { HAKUTAKU_VERSION } from "../../version.js";
import { formatSummary, pythonWhy, summaryCounts } from "../summary.js";
import { printable } from "../table.js";
import { askToInstall } from "./engines.js";
import type { CliIO, Command } from "./index.js";
import {
  checkoutTop,
  foundLine,
  printConflicts,
  writeWhole,
} from "./profile.js";

const USAGE =
  "usage: hakutaku map <repo> [--id <id>] [--ref <ref>] [--detail quick|standard|deep] [--no-source] [--no-snippets] [--sandbox auto|require|none] [--engines-dir <path>] [--yes]\n";

const OPTIONS = {
  id: { type: "string" },
  ref: { type: "string" },
  detail: { type: "string" },
  "no-source": { type: "boolean" },
  "no-snippets": { type: "boolean" },
  sandbox: { type: "string" },
  "engines-dir": { type: "string" },
  yes: { type: "boolean" },
} as const;

const DETAILS: readonly string[] = ["quick", "standard", "deep"];
const SANDBOX_MODES: readonly string[] = ["auto", "require", "none"];

interface Flags {
  repo: string;
  id: string | undefined;
  ref: string | undefined;
  detail: Detail | undefined;
  noSource: boolean;
  noSnippets: boolean;
  sandbox: SandboxMode | undefined;
  enginesDir: string | undefined;
  yes: boolean;
}

function usageError(io: CliIO, message: string): number {
  io.stderr(`hakutaku map: ${message}\n${USAGE}`);
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
  for (const name of Object.keys(OPTIONS) as Array<keyof typeof OPTIONS>) {
    if (values[name] === "") return usageError(io, `--${name} is empty`);
  }
  if (values.detail !== undefined && !DETAILS.includes(values.detail)) {
    return usageError(
      io,
      `--detail must be quick, standard or deep, not ${JSON.stringify(values.detail)}`,
    );
  }
  if (values.sandbox !== undefined && !SANDBOX_MODES.includes(values.sandbox)) {
    return usageError(
      io,
      `--sandbox must be auto, require or none, not ${JSON.stringify(values.sandbox)}`,
    );
  }
  if (values.id !== undefined && !REPO_ID_RE.test(values.id)) {
    return usageError(io, `not a valid repo id: ${JSON.stringify(values.id)}`);
  }
  const flags: Flags = {
    repo,
    id: values.id,
    ref: values.ref,
    detail: values.detail as Detail | undefined,
    noSource: values["no-source"] === true,
    noSnippets: values["no-snippets"] === true,
    sandbox: values.sandbox as SandboxMode | undefined,
    enginesDir: values["engines-dir"],
    yes: values.yes === true,
  };
  return withBuildLock(() => build(io, flags));
}

const isFile = (path: string): boolean =>
  statSync(path, { throwIfNoEntry: false })?.isFile() === true;

async function build(io: CliIO, f: Flags): Promise<number> {
  // 1.
  const top = checkoutTop(f.repo);
  const entry =
    loadRegistry().repos.find(
      (e) => e.source === top && (f.id === undefined || e.id === f.id),
    ) ?? null;
  const id = f.id ?? entry?.id ?? defaultRepoId(top);
  if (!REPO_ID_RE.test(id)) {
    return usageError(
      io,
      `the folder name gives no valid repo id (${JSON.stringify(id)}); name one with --id`,
    );
  }
  const ref = f.ref ?? entry?.ref ?? "HEAD";
  const detail = f.detail ?? entry?.detail ?? "standard";
  const noSource = f.noSource || (entry?.noSource ?? false);
  const snippets = !f.noSnippets && (entry?.snippets ?? true);
  const enginesDir = f.enginesDir ?? defaultEnginesDir();

  // 2.
  const deep = detail === "deep";
  if (!verifyEngines(enginesDir, { deep, runVersions: false }).ok) {
    const code = await askToInstall(io, enginesDir, deep, f.yes);
    if (code !== 0) return code;
  }

  // 3. The entry's own profile, while it is there; else the id's, generated when missing.
  const { commit } = await resolveCommit(top, ref);
  const exportDir = exportDirFor(id, commit);
  removeTree(exportDir);
  const profile =
    entry !== null && isFile(entry.profile)
      ? entry.profile
      : profilePathFor(id);
  const given = isFile(profile);
  let exported: ExportResult;
  try {
    exported = await exportRepo({
      repo: top,
      ref,
      out: exportDir,
      id,
      ...(given ? { profile } : {}),
    });
  } catch (error) {
    if (!(error instanceof ProfileConflictError)) throw error;
    printConflicts(io, error);
    io.stderr(`name one in the profile: ${profile}\n`);
    return 1;
  }
  if (exported.commit !== commit) {
    removeTree(exportDir);
    throw new Error(
      `${ref} moved while it was exported; run hakutaku map again`,
    );
  }
  if (!given) {
    // kept byte for byte: the next build reads it, and the skip key holds its bytes' hash
    const generated = await generateProfile(join(exportDir, "snapshot"));
    writeWhole(profile, readFileSync(join(exportDir, "profile.json")));
    io.stderr(`${foundLine(generated.found)}\n`);
    for (const warning of generated.warnings) {
      io.stderr(`${printable(warning)}\n`);
    }
    io.stderr(`wrote ${profile}\n`);
  }
  // Freshness reads the ref from its ref files, with no git process; git reads more names.
  const head = createRefReader()(top, ref);
  if (head.commit === null) {
    io.stderr(
      `hakutaku: the freshness of ${id} will read unknown: ${printable(head.reason)}\n`,
    );
  }

  // 4.
  const storePath = storePathFor(id);
  let result: ExtractResult;
  try {
    result = await extractSnapshot({
      dir: exportDir,
      out: storePath,
      enginesDir,
      detail,
      noSource,
      ...(f.sandbox === undefined ? {} : { sandbox: f.sandbox }),
    });
  } catch (error) {
    // a sandboxed run that printed its own message, on the stderr passed through, is not
    // repeated; one stopped before it could print is reported by the caller
    if (error instanceof SandboxedRunFailed && error.printed) return 1;
    throw error;
  }

  // 5.
  saveEntry({ id, source: top, ref, detail, noSource, snippets, profile });

  // 6.
  const exports = dirname(exportDir);
  for (const name of readdirSync(exports)) {
    if (name !== commit) removeTree(join(exports, name));
  }

  // 7.
  if (result.result === "gates-failed") {
    io.stderr(
      `gates failed: ${printable(result.reason ?? "")}; ${
        serves(storePath)
          ? "the previous store keeps serving"
          : "no store is built yet"
      }\n`,
    );
    return 3;
  }
  const store = openStore(storePath);
  if ("code" in store) {
    throw new Error(`the store does not open: ${store.reason}`);
  }
  let lines: string[];
  try {
    // build.json describes this store only when it names its content
    const read = readBuildFacts(storePath);
    const facts =
      read !== null && read.contentHash === store.run.contentHash ? read : null;
    // read here, not imported: the command list imports this module
    const { COMMANDS } = await import("./index.js");
    lines = formatSummary({
      version: HAKUTAKU_VERSION,
      id,
      commit: result.commit,
      ref,
      detail,
      counts: summaryCounts(store),
      build: facts,
      storeBytes: statSync(storePath).size,
      result: result.result,
      pythonResolver: store.meta.coverage.pythonResolver,
      pythonWhy: pythonWhy(store.meta.coverage.tiers.grimp, facts),
      commands: COMMANDS.map((c) => c.name),
    });
  } finally {
    store.close();
  }
  io.stdout(lines.map((line) => `${line}\n`).join(""));
  return 0;
}

// Whether a store at path opens, and so serves.
function serves(path: string): boolean {
  const store = openStore(path);
  if ("code" in store) return false;
  store.close();
  return true;
}

export const mapCommand: Command = {
  name: "map",
  summary: "profile a repo if it has none, build its store and register it",
  run,
};
