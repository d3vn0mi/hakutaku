// Reads and checks an export directory, the whole input of a build: export.json, history.json,
// profile.json and, when it exists, rules.json, with the bytes of the last two that the skip
// key hashes. Every path the merge will read must be a repo path, so that no read leaves
// snapshot/. A message names a file of the export and a field, never a host path, since a
// build's failure reason can reach an agent's answer.
import { lstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type ExportManifest,
  HISTORY_WINDOW_SECONDS,
  type History,
  refuseReason,
} from "../export/index.js";
import { REPO_ID_RE } from "../model/index.js";
import {
  loadProfile,
  loadRules,
  type Profile,
  type Rules,
} from "../profile/index.js";
import { readRegularFile } from "../store/index.js";
import { isRepoPath } from "./resolve/ts.js";

export interface ExportInput {
  manifest: ExportManifest;
  history: History;
  profile: Profile;
  rules: Rules | null;
  profileBytes: Uint8Array;
  rulesBytes: Uint8Array | null;
}

export function readExportDir(dir: string): ExportInput {
  const manifest = readJson(dir, "export.json");
  checkManifest(manifest);
  const history = readJson(dir, "history.json");
  checkHistory(history, manifest);
  if (
    !statSync(join(dir, "snapshot"), { throwIfNoEntry: false })?.isDirectory()
  ) {
    throw new Error("the export directory holds no snapshot directory");
  }
  // The rules are read whenever the file exists: export has already resolved them, whatever
  // the profile's rules field says.
  const rulesFile = join(dir, "rules.json");
  const hasRules = statSync(rulesFile, { throwIfNoEntry: false }) !== undefined;
  const profile = loadProfile(join(dir, "profile.json"));
  const rules = hasRules ? loadRules(rulesFile) : null;
  return {
    manifest,
    history,
    profile,
    rules,
    profileBytes: readFileSync(join(dir, "profile.json")),
    rulesBytes: hasRules ? readFileSync(rulesFile) : null,
  };
}

// A file of the export as JSON. It must be a regular file: a read of a FIFO would block.
// A regular file's bytes in the snapshot. Export writes only directories and regular files
// there, so a link, or anything else, at any part of the path is refused rather than followed:
// each directory on the path is checked with lstat, and the file is opened without following a
// link, in case it changed since.
export function snapshotReader(
  snapshotDir: string,
): (path: string) => Uint8Array {
  return (path) => {
    const parts = path.split("/");
    let at = snapshotDir;
    parts.forEach((part, i) => {
      at = join(at, part);
      if (i < parts.length - 1 && !lstatSync(at).isDirectory()) {
        throw new Error(
          `the snapshot's ${parts.slice(0, i + 1).join("/")} is not a directory`,
        );
      }
    });
    const bytes = readRegularFile(at, Number.POSITIVE_INFINITY);
    if (bytes === null) {
      throw new Error(`the snapshot's ${path} is not a regular file`);
    }
    return bytes;
  };
}

function readJson(dir: string, name: string): unknown {
  let text: string;
  try {
    if (!statSync(join(dir, name)).isFile()) {
      throw new Error(`the export's ${name} is not a regular file`);
    }
    text = readFileSync(join(dir, name), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === undefined) throw error;
    throw new Error(`cannot read the export's ${name} (${code})`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `the export's ${name} is not JSON (${(error as Error).message})`,
    );
  }
}

type Rec = Readonly<Record<string, unknown>>;

const isRecord = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0;
const isSha = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
// A path inside the repo, as export keeps one: relative, no empty, "." or ".." segment, no
// .git segment and no control character.
const isPath = (v: unknown): v is string =>
  typeof v === "string" && isRepoPath(v) && refuseReason(v) === null;
const isString = (v: unknown): v is string => typeof v === "string";
const oneOf =
  (...values: string[]) =>
  (v: unknown): boolean =>
    typeof v === "string" && values.includes(v);

// Checks value[key] with check, or throws naming the field.
function field(
  file: string,
  value: Rec,
  key: string,
  check: (v: unknown) => boolean,
): void {
  if (!check(value[key])) {
    throw new Error(`the export's ${file} is not valid: ${key}`);
  }
}

// Checks that value[key] is an array whose every element is an object passing each check.
function rows(
  file: string,
  value: Rec,
  key: string,
  checks: Record<string, (v: unknown) => boolean>,
): void {
  const list = value[key];
  const bad = !Array.isArray(list)
    ? -1
    : list.findIndex(
        (row) =>
          !isRecord(row) ||
          Object.entries(checks).some(([name, check]) => !check(row[name])),
      );
  if (!Array.isArray(list) || bad !== -1) {
    throw new Error(
      `the export's ${file} is not valid: ${key}${bad === -1 ? "" : `[${bad}]`}`,
    );
  }
}

function checkManifest(value: unknown): asserts value is ExportManifest {
  const file = "export.json";
  if (!isRecord(value))
    throw new Error(`the export's ${file} is not an object`);
  field(file, value, "formatVersion", (v) => v === 1);
  field(file, value, "id", (v) => isString(v) && REPO_ID_RE.test(v));
  field(file, value, "commit", isSha);
  field(file, value, "commitTime", Number.isSafeInteger);
  field(file, value, "ref", isString);
  field(file, value, "hakutakuVersion", isString);
  field(file, value, "files", isCount);
  field(file, value, "denied", isCount);
  field(
    file,
    value,
    "engineConfigsRemoved",
    (v) => Array.isArray(v) && v.every(isString),
  );
  rows(file, value, "symlinks", { path: isPath, target: isString });
  rows(file, value, "submodules", { path: isPath, commit: isString });
  rows(file, value, "refused", {
    path: isString,
    reason: oneOf("dotdot", "absolute", "control-char", "dotgit", "collision"),
  });
  rows(file, value, "metadataOnly", {
    path: isPath,
    reason: oneOf("size", "minified", "generated"),
  });
  rows(file, value, "tree", {
    path: isPath,
    mode: oneOf("100644", "100755", "120000", "160000"),
    blob: isSha,
    bytes: isCount,
  });
}

function checkHistory(
  value: unknown,
  manifest: ExportManifest,
): asserts value is History {
  const file = "history.json";
  if (!isRecord(value))
    throw new Error(`the export's ${file} is not an object`);
  field(file, value, "commit", (v) => v === manifest.commit);
  field(file, value, "commitTime", (v) => v === manifest.commitTime);
  field(file, value, "windowSeconds", (v) => v === HISTORY_WINDOW_SECONDS);
  // The history keeps every path git reports, so its paths are only checked to be strings.
  rows(file, value, "commits", {
    sha: isSha,
    time: Number.isSafeInteger,
    files: (v) => Array.isArray(v) && v.every(isString),
    renames: (v) =>
      Array.isArray(v) &&
      v.every((r) => isRecord(r) && isString(r.from) && isString(r.to)),
  });
}
