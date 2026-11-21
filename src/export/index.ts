// Export: one commit of a git checkout, read through the hardened
// git calls of git.ts and history.ts, written as one export directory, the whole contract
// between export and extract:
//
//   export.json   the ExportManifest           profile.json   the given profile, or one generated
//   snapshot/     the kept regular files       rules.json     the given rules (absent without)
//   history.json  the History                  tsconfig.json, depcruise.json, sgconfig.yml,
//                                              ast-grep/      the engines' generated configs
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  type Stats,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type GitMode, REPO_ID_RE, type RepoId } from "../model/index.js";
import {
  type GenerateResult,
  generateProfile,
  loadProfile,
  loadRules,
  type Profile,
  ProfileError,
  type Rules,
} from "../profile/index.js";
import { HAKUTAKU_VERSION } from "../version.js";
import { writeEngineConfigs } from "./configs.js";
import { listTree, resolveCommit } from "./git.js";
import { readHistory } from "./history.js";
import { defaultRepoId } from "./paths.js";
import { removeTree, writeSnapshot } from "./snapshot.js";

export { writeEngineConfigs } from "./configs.js";
export {
  GIT_ENV,
  gitArgs,
  listTree,
  readBlobs,
  resolveCommit,
  type TreeEntry,
} from "./git.js";
export {
  HISTORY_WINDOW_SECONDS,
  type History,
  readHistory,
} from "./history.js";
export {
  defaultRepoId,
  ENGINE_CONFIG_FILES,
  isEngineConfig,
  type RefuseReason,
  refuseReason,
} from "./paths.js";
export { removeTree } from "./snapshot.js";
export {
  type MetadataOnlyReason,
  metadataOnlyReason,
  SOURCE_CAP,
} from "./source-policy.js";

export interface ExportManifest {
  formatVersion: 1;
  id: RepoId;
  commit: string; // 40 hex
  commitTime: number;
  ref: string;
  hakutakuVersion: string;
  files: number; // the entries in tree
  denied: number;
  engineConfigsRemoved: string[];
  symlinks: Array<{ path: string; target: string }>;
  submodules: Array<{ path: string; commit: string }>;
  refused: Array<{
    path: string;
    // collision: a path that lands on a name the snapshot already holds, folded as a file system
    // folds names, or a file where a directory should be; dotgit: a component that reads as .git
    reason: "dotdot" | "absolute" | "control-char" | "dotgit" | "collision";
  }>;
  // Kept in snapshot/ and tree, out of every engine's input; in path order
  metadataOnly: Array<{
    path: string;
    reason: "size" | "minified" | "generated";
  }>;
  // every entry kept (regular files, links and submodules), in comparePaths order
  tree: Array<{ path: string; mode: GitMode; blob: string; bytes: number }>;
}

export interface ExportOptions {
  repo: string;
  ref: string;
  out: string;
  id?: RepoId;
  profile?: string;
  rules?: string;
  maxFiles?: number;
}

export interface ExportResult {
  id: RepoId;
  commit: string;
  commitTime: number;
  ref: string;
  files: number;
  denied: number;
  out: string; // absolute
}

// Thrown when no profile is given and the generated one has conflicts: the person names the
// alias in a profile of their own.
export class ProfileConflictError extends Error {
  conflicts: string[];
  found: GenerateResult["found"];

  constructor(conflicts: string[], found: GenerateResult["found"]) {
    super(`the generated profile has conflicts:\n${conflicts.join("\n")}`);
    this.name = "ProfileConflictError";
    this.conflicts = conflicts;
    this.found = found;
  }
}

// On any failure, what the export wrote is removed again: `out` itself when the export made
// it, else everything in it. A read-only snapshot could not be removed by hand otherwise, and
// a second try needs an empty directory.
export async function exportRepo(opts: ExportOptions): Promise<ExportResult> {
  const out = resolve(opts.out);
  const made = prepareOut(out);
  try {
    return await writeExport(opts, out);
  } catch (error) {
    try {
      if (made) removeTree(out);
      else for (const name of readdirSync(out)) removeTree(join(out, name));
    } catch {
      // The export's own error says more than a failed clean-up.
    }
    throw error;
  }
}

// Step 1: `out` must not exist, and is made, or must be an empty directory. True when made.
function prepareOut(out: string): boolean {
  const stats = statSync(out, { throwIfNoEntry: false });
  if (stats === undefined) {
    mkdirSync(out, { recursive: true });
    return true;
  }
  if (!stats.isDirectory()) {
    throw new Error("the out directory is not a directory");
  }
  if (readdirSync(out).length > 0) {
    throw new Error("the out directory is not empty");
  }
  return false;
}

async function writeExport(
  opts: ExportOptions,
  out: string,
): Promise<ExportResult> {
  // Step 2. git -C walks up from a folder that is not a repo's top level to a parent repo.
  const repo = resolve(opts.repo);
  if (!isRepoTop(repo)) {
    throw new Error("not a checkout's top level or a bare repo");
  }
  const id = opts.id ?? defaultRepoId(repo);
  if (!REPO_ID_RE.test(id)) {
    throw new Error(
      opts.id === undefined
        ? `the folder name gives no valid repo id (${JSON.stringify(id)})`
        : `not a valid repo id: ${JSON.stringify(id)}`,
    );
  }
  const { maxFiles } = opts;
  if (
    maxFiles !== undefined &&
    !(Number.isSafeInteger(maxFiles) && maxFiles >= 1)
  ) {
    throw new RangeError(`maxFiles is not a positive integer: ${maxFiles}`);
  }
  // Step 3. The bytes loaded are the bytes copied: the copy is what gets loaded.
  let profile: Profile | null = null;
  if (opts.profile !== undefined) {
    profile = loadProfile(copyGiven(opts.profile, "profile", out));
  }
  // Step 4.
  const { commit, commitTime } = await resolveCommit(repo, opts.ref);
  const entries = await listTree(repo, commit);
  if (maxFiles !== undefined && entries.length > maxFiles) {
    throw new Error(`too many files: ${entries.length} > ${maxFiles}`);
  }
  // Steps 5 and 6.
  const snapshotDir = join(out, "snapshot");
  const snapshot = await writeSnapshot(
    repo,
    entries,
    snapshotDir,
    profile?.denylist.extra ?? [],
  );
  // Step 7.
  const history = await readHistory(repo, commit, commitTime);
  // Step 8.
  if (profile === null) {
    const generated = await generateProfile(snapshotDir);
    if (generated.conflicts.length > 0) {
      throw new ProfileConflictError(generated.conflicts, generated.found);
    }
    profile = generated.profile;
    writeFileSync(
      join(out, "profile.json"),
      `${JSON.stringify(profile, null, 2)}\n`,
      { flag: "wx" },
    );
  }
  // --rules, else the file the given profile names, relative to the profile file.
  const rulesFile =
    opts.rules ??
    (opts.profile !== undefined && profile.rules !== null
      ? resolve(dirname(resolve(opts.profile)), profile.rules)
      : undefined);
  const rules: Rules | null =
    rulesFile === undefined
      ? null
      : loadRules(copyGiven(rulesFile, "rules", out));
  // Step 9.
  writeEngineConfigs(
    out,
    profile,
    rules,
    snapshot.metadataOnly.map((m) => m.path),
  );
  const manifest: ExportManifest = {
    formatVersion: 1,
    id,
    commit,
    commitTime,
    ref: opts.ref,
    hakutakuVersion: HAKUTAKU_VERSION,
    files: snapshot.files,
    denied: snapshot.denied,
    engineConfigsRemoved: snapshot.engineConfigsRemoved,
    symlinks: snapshot.symlinks,
    submodules: snapshot.submodules,
    refused: snapshot.refused,
    metadataOnly: snapshot.metadataOnly,
    tree: snapshot.tree,
  };
  writeJson(join(out, "export.json"), manifest);
  writeJson(join(out, "history.json"), history);
  return {
    id,
    commit,
    commitTime,
    ref: opts.ref,
    files: snapshot.files,
    denied: snapshot.denied,
    out,
  };
}

const writeJson = (file: string, value: unknown): void => {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
};

// A checkout's top level holds .git: a file naming its git directory (git follows it, or
// stops), or a git directory. A bare repo is a git directory. A git directory holds HEAD,
// objects/ and refs/, as git checks before it takes one; without them git walks on up.
export function isRepoTop(repo: string): boolean {
  const dotGit = join(repo, ".git");
  const kind = kindOf(dotGit);
  if (kind === "file") return true;
  return isGitDir(kind === "dir" ? dotGit : repo);
}

const isGitDir = (dir: string): boolean =>
  kindOf(join(dir, "HEAD")) === "file" &&
  kindOf(join(dir, "objects")) === "dir" &&
  kindOf(join(dir, "refs")) === "dir";

function kindOf(path: string): "file" | "dir" | null {
  let stats: Stats | undefined;
  try {
    stats = statSync(path, { throwIfNoEntry: false });
  } catch {
    return null;
  }
  if (stats?.isFile()) return "file";
  if (stats?.isDirectory()) return "dir";
  return null;
}

// Copies a given profile or rules file to <out>/<field>.json, byte for byte, and returns the
// copy's path. It must be a regular file: it is opened without blocking and checked with
// fstat, so a FIFO never blocks the export. The wordings are loadProfile's.
function copyGiven(
  file: string,
  field: "profile" | "rules",
  out: string,
): string {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    throw cannotRead(field, error);
  }
  let bytes: Buffer;
  try {
    if (!fstatSync(fd).isFile()) {
      throw new ProfileError(field, "not a regular file");
    }
    bytes = readFileSync(fd);
  } catch (error) {
    throw error instanceof ProfileError ? error : cannotRead(field, error);
  } finally {
    closeSync(fd);
  }
  const copy = join(out, `${field}.json`);
  writeFileSync(copy, bytes, { flag: "wx" });
  return copy;
}

const cannotRead = (field: string, error: unknown): ProfileError =>
  new ProfileError(
    field,
    `cannot read the file (${(error as NodeJS.ErrnoException).code ?? "no code"})`,
  );
