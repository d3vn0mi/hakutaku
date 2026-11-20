// The snapshot (interfaces section 3.6, §9.2). Each tree entry, in path order, is refused,
// denied, removed as an engine config, recorded as a link (never created) or a submodule
// (never followed), or kept as a regular file under snapshot/: created exclusively, read-only,
// with every directory read-only once the last file is written.
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  type Stats,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { comparePaths } from "../model/index.js";
import { isDenied } from "../redact/index.js";
import { readBlobs, type TreeEntry } from "./git.js";
import type { ExportManifest } from "./index.js";
import { isEngineConfig, refuseReason } from "./paths.js";
import { metadataOnlyReason } from "./source-policy.js";

export type Snapshot = Pick<
  ExportManifest,
  | "files"
  | "denied"
  | "engineConfigsRemoved"
  | "symlinks"
  | "submodules"
  | "refused"
  | "metadataOnly"
  | "tree"
>;

type Row = ExportManifest["tree"][number];

// A link's target text, as UTF-8; a byte that is not UTF-8 reads U+FFFD.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

// Writes the snapshot of `entries` (listTree's, in path order) into `dir`, which must not
// exist yet; `denyExtra` adds the profile's globs to the denylist.
export async function writeSnapshot(
  repo: string,
  entries: readonly TreeEntry[],
  dir: string,
  denyExtra: readonly string[],
): Promise<Snapshot> {
  const snapshot: Snapshot = {
    files: 0,
    denied: 0,
    engineConfigsRemoved: [],
    symlinks: [],
    submodules: [],
    refused: [],
    metadataOnly: [],
    tree: [],
  };
  // One row per entry kept, in path order; a blob's row is filled once it is read.
  const rows: Array<Row | null> = [];
  const pending: Array<{ entry: TreeEntry; row: number }> = [];
  const names = new HeldNames();
  for (const entry of entries) {
    const { path } = entry;
    const refused = refuseReason(path);
    if (refused !== null) {
      snapshot.refused.push({ path, reason: refused });
    } else if (isDenied(path, denyExtra)) {
      snapshot.denied += 1;
    } else if (isEngineConfig(path)) {
      snapshot.engineConfigsRemoved.push(path);
    } else if (entry.mode === "160000") {
      snapshot.submodules.push({ path, commit: entry.sha });
      rows.push({ path, mode: entry.mode, blob: entry.sha, bytes: 0 });
    } else if (entry.mode !== "120000" && !names.hold(path)) {
      snapshot.refused.push({ path, reason: "collision" });
    } else {
      pending.push({ entry, row: rows.length });
      rows.push(null);
    }
  }
  mkdirSync(dir);
  const made = new Set<string>([dir]);
  let next = 0;
  // Each blob is handed over in the order asked, so the n-th belongs to the n-th entry; one
  // blob can stand for several paths.
  await readBlobs(
    repo,
    pending.map((p) => p.entry.sha),
    async (sha, bytes) => {
      const item = pending[next];
      next += 1;
      if (item === undefined)
        throw new Error("git cat-file answered a blob too many");
      const { path, mode } = item.entry;
      if (mode === "120000") {
        snapshot.symlinks.push({ path, target: decoder.decode(bytes) });
      } else if (!writeFile(dir, path, bytes, made)) {
        snapshot.refused.push({ path, reason: "collision" });
        return;
      } else {
        const reason = metadataOnlyReason(path, bytes);
        if (reason !== null) snapshot.metadataOnly.push({ path, reason });
      }
      rows[item.row] = { path, mode, blob: sha, bytes: bytes.length };
    },
  );
  sealDirectories(dir);
  snapshot.tree = rows.filter((row): row is Row => row !== null);
  snapshot.files = snapshot.tree.length;
  // Refusals found while writing come after those found while listing.
  snapshot.refused.sort((a, b) => comparePaths(a.path, b.path));
  return snapshot;
}

// The names a case-insensitive file system holds, as macOS's does by default, which also
// ignores Unicode normalization: README.md and Readme.md, or "é" composed and decomposed, are
// one name there. A file is refused when its own name is held already, by a file or a
// directory, or when one of its directories' names is held by a file. Checking this on every
// file system keeps an export, and the store built from it, the same on Linux and macOS.
class HeldNames {
  private readonly files = new Set<string>();
  private readonly directories = new Set<string>();

  hold(path: string): boolean {
    const own = fold(path);
    const parents: string[] = [];
    for (
      let at = path.indexOf("/");
      at !== -1;
      at = path.indexOf("/", at + 1)
    ) {
      parents.push(fold(path.slice(0, at)));
    }
    if (
      this.files.has(own) ||
      this.directories.has(own) ||
      parents.some((key) => this.files.has(key))
    ) {
      return false;
    }
    this.files.add(own);
    for (const key of parents) this.directories.add(key);
    return true;
  }
}

const fold = (name: string): string => name.toLowerCase().normalize("NFC");

const isTaken = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "ENOTDIR";
};

// Creates dir/<path> exclusively, mode 0444 whatever the umask. False when the file system
// already holds the name, or holds a file where a directory of it should be: a collision
// HeldNames could not see (two names that are not UTF-8 read alike, for one).
function writeFile(
  dir: string,
  path: string,
  bytes: Uint8Array,
  made: Set<string>,
): boolean {
  const file = join(dir, path);
  const parent = dirname(file);
  if (!made.has(parent)) {
    try {
      mkdirSync(parent, { recursive: true });
    } catch (error) {
      if (isTaken(error)) return false;
      throw error;
    }
    made.add(parent);
  }
  let fd: number;
  try {
    fd = openSync(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o444,
    );
  } catch (error) {
    if (isTaken(error)) return false;
    throw error;
  }
  try {
    fchmodSync(fd, 0o444);
    for (let at = 0; at < bytes.length; ) {
      at += writeSync(fd, bytes, at, bytes.length - at);
    }
  } finally {
    closeSync(fd);
  }
  return true;
}

// Every directory of the snapshot, its own included, becomes 0555.
function sealDirectories(dir: string): void {
  const stack = [dir];
  for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(join(at, entry.name));
    }
    chmodSync(at, 0o555);
  }
}

// Gives the owner back write permission on every directory of the tree at `dir` (read and
// search too), then removes the tree; nothing at `dir` is no error. A read-only export cannot
// be removed otherwise. No link is followed: a link is removed, never what it names.
export function removeTree(dir: string): void {
  let stats: Stats;
  try {
    stats = lstatSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw error;
  }
  if (stats.isDirectory()) {
    const stack = [dir];
    for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
      chmodSync(at, (lstatSync(at).mode & 0o7777) | 0o700);
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        if (entry.isDirectory()) stack.push(join(at, entry.name));
      }
    }
  }
  rmSync(dir, { recursive: true, force: true });
}
