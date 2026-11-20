// createRefReader: the commit a ref names, read from a checkout's ref files with no git process.
// It finds the git directory and the common directory, tries git's candidates for
// the name in git's order, a loose file before packed-refs at each, and follows symbolic refs.
// What it cannot resolve that way answers a reason instead: a loose tag, a reftable store, a
// revision expression, a missing ref or a file system error. It never throws.
//
// Each answer is kept per (repoPath, ref) with what it depends on: the (ino, size, mtimeMs) of
// every file it read, and the kind of every other path it probed, absence included. Every call
// stats them all again and recomputes on any change.
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  type Stats,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { RefResult } from "./types.js";

const LOOSE_TAG =
  "a loose tag may name a tag object; only packed peeled tags are read";
const UNPEELED_TAG = "a packed tag without a peel line may name a tag object";
const REFTABLE = "reftable ref storage is not read";
const NOT_A_REPO = "not a git repository";

// git's SYMREF_MAXDEPTH: resolving one candidate reads at most five ref files, so a chain of
// symbolic refs resolves through at most four `ref:` lines.
const MAX_READS = 5;

// No loose ref, .git file or commondir file is this large.
const SMALL_FILE = 64 * 1024;

// A file read within this many ms of its mtime may change again and keep that mtime, since file
// systems stamp files from a coarse clock (a kernel tick on Linux, a second on HFS+, two on FAT).
// An answer that read such a file is not kept, as git rechecks a racily clean index entry.
const RACY_MS = 2000;

const SHA = /^[0-9a-fA-F]{40}$/;

interface Answer {
  result: RefResult;
  deps: Map<string, string>; // path -> signature
}

export function createRefReader(): (
  repoPath: string,
  ref: string,
) => RefResult {
  const answers = new Map<string, Map<string, Answer>>();
  return (repoPath, ref) => {
    try {
      if (SHA.test(ref)) return { commit: ref.toLowerCase() };
      if (!isRefName(ref)) return cannotResolve(ref);
      const repo = resolve(repoPath);
      let byRef = answers.get(repo);
      if (byRef === undefined) {
        byRef = new Map();
        answers.set(repo, byRef);
      }
      const kept = byRef.get(ref);
      if (kept !== undefined && unchanged(kept.deps)) return kept.result;
      byRef.delete(ref);
      const reading = new Reading();
      let result: RefResult;
      try {
        result = lookUp(reading, repo, ref);
      } catch (error) {
        if (!(error instanceof ReadError)) throw error;
        // Never kept: a file made readable again keeps its signature.
        return unknown(`cannot read ${error.label}: ${error.code}`);
      }
      if (!reading.racy) byRef.set(ref, { result, deps: reading.deps });
      return result;
    } catch (error) {
      return unknown(`cannot read ref files: ${codeOf(error)}`);
    }
  };
}

interface GitDirs {
  gitdir: string; // HEAD and the per-worktree refs
  common: string; // every other ref, and packed-refs
}

function lookUp(reading: Reading, repo: string, ref: string): RefResult {
  const dirs = gitDirs(reading, repo);
  if (dirs === null) return unknown(NOT_A_REPO);
  if (
    reading.probe(join(dirs.common, "reftable"), "reftable") === "directory"
  ) {
    return unknown(REFTABLE);
  }
  for (const name of candidates(ref)) {
    const found = resolveName(reading, dirs, name);
    if (found !== null) return found;
  }
  return cannotResolve(ref);
}

// <repo>/.git as a directory; a .git file holding "gitdir: <path>", relative to the repo; or a
// bare repo, which has HEAD and objects/. The common directory is named by <gitdir>/commondir,
// relative to the gitdir, when that file exists.
function gitDirs(reading: Reading, repo: string): GitDirs | null {
  const dotGit = join(repo, ".git");
  let gitdir: string;
  switch (reading.probe(dotGit, ".git")) {
    case "directory":
      gitdir = dotGit;
      break;
    case "file": {
      const text = reading.read(dotGit, ".git");
      if (text === null || !text.startsWith("gitdir: ")) return null;
      const path = text.slice("gitdir: ".length).replace(/[\r\n]+$/, "");
      if (path === "") return null;
      gitdir = resolve(repo, path);
      if (reading.probe(gitdir, "gitdir") !== "directory") return null;
      break;
    }
    default:
      if (
        reading.probe(join(repo, "HEAD"), "HEAD") !== "file" ||
        reading.probe(join(repo, "objects"), "objects") !== "directory"
      ) {
        return null;
      }
      gitdir = repo;
  }
  const commondir = reading.read(join(gitdir, "commondir"), "commondir");
  const path = commondir?.replace(/[\r\n]+$/, "") ?? "";
  return { gitdir, common: path === "" ? gitdir : resolve(gitdir, path) };
}

// git's lookup order for a name. Only HEAD and a name under refs/ are tried as they are.
function candidates(ref: string): string[] {
  const names = ref === "HEAD" || ref.startsWith("refs/") ? [ref] : [];
  names.push(
    `refs/${ref}`,
    `refs/tags/${ref}`,
    `refs/heads/${ref}`,
    `refs/remotes/${ref}`,
    `refs/remotes/${ref}/HEAD`,
  );
  return names;
}

// The commit a full ref name gives, an unknown answer that ends the lookup, or null when the name
// is not there: missing, dangling, broken or too deep, which git skips for the next candidate.
function resolveName(
  reading: Reading,
  dirs: GitDirs,
  start: string,
): RefResult | null {
  let name = start;
  for (let reads = 0; reads < MAX_READS; reads++) {
    const dir = perWorktree(name) ? dirs.gitdir : dirs.common;
    const text = reading.read(join(dir, name), name);
    if (text === null) return fromPacked(reading, dirs, name);
    if (name.startsWith("refs/tags/")) return unknown(LOOSE_TAG);
    const content = parseLoose(text);
    if (content === null) return null;
    if ("commit" in content) return content;
    if (!isFullName(content.target)) return null;
    name = content.target;
  }
  return null;
}

function fromPacked(
  reading: Reading,
  dirs: GitDirs,
  name: string,
): RefResult | null {
  const packed = reading.packedRefs(dirs.common);
  const entry = packed?.refs.get(name);
  if (packed === null || entry === undefined) return null;
  if (entry.peeled !== undefined) return { commit: entry.peeled };
  if (name.startsWith("refs/tags/") && !packed.fullyPeeled) {
    return unknown(UNPEELED_TAG);
  }
  return { commit: entry.sha };
}

function perWorktree(name: string): boolean {
  return (
    name === "HEAD" ||
    name.startsWith("refs/bisect/") ||
    name.startsWith("refs/worktree/") ||
    name.startsWith("refs/rewritten/")
  );
}

// git check-ref-format's rules, a one-level name allowed. They also keep every candidate inside
// its directory, since no part of a name is empty, "." or "..".
function isRefName(name: string): boolean {
  if (
    name === "@" ||
    name.includes("..") ||
    name.includes("@{") ||
    name.endsWith(".") ||
    /[~^:?*[\\]/.test(name)
  ) {
    return false;
  }
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  return name
    .split("/")
    .every(
      (part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"),
    );
}

// What a symbolic ref may point to: HEAD, or a full name under refs/.
function isFullName(name: string): boolean {
  return isRefName(name) && (name === "HEAD" || name.startsWith("refs/"));
}

// A loose ref, as git reads it: "ref: <name>", or a sha followed by nothing or white space.
function parseLoose(
  text: string,
): { commit: string } | { target: string } | null {
  const content = text.replace(/[ \t\n\v\f\r]+$/, "");
  if (content.startsWith("ref:")) {
    return {
      target: content.slice("ref:".length).replace(/^[ \t\n\v\f\r]+/, ""),
    };
  }
  const match = /^([0-9a-fA-F]{40})(?:[ \t\n\v\f\r]|$)/.exec(content);
  return match === null ? null : { commit: match[1].toLowerCase() };
}

interface PackedRefs {
  fullyPeeled: boolean;
  refs: Map<string, { sha: string; peeled?: string }>;
}

// "<sha> <name>" lines, each optionally followed by its "^<sha>" peel line, after an optional
// "# pack-refs with: <traits>" header. A line of any other shape is skipped.
function parsePacked(text: string): PackedRefs {
  const lines = text.split("\n");
  const header = "# pack-refs with:";
  const fullyPeeled =
    lines[0].startsWith(header) &&
    lines[0].slice(header.length).split(" ").includes("fully-peeled");
  const refs = new Map<string, { sha: string; peeled?: string }>();
  let last: { sha: string; peeled?: string } | undefined;
  for (const line of lines) {
    const peel = /^\^([0-9a-fA-F]{40})$/.exec(line);
    if (peel !== null) {
      if (last !== undefined) last.peeled = peel[1].toLowerCase();
      last = undefined;
      continue;
    }
    const ref = /^([0-9a-fA-F]{40}) (.+)$/.exec(line);
    last = undefined;
    if (ref !== null && !refs.has(ref[2])) {
      last = { sha: ref[1].toLowerCase() };
      refs.set(ref[2], last);
    }
  }
  return { fullyPeeled, refs };
}

const ABSENT = "absent";

// A file's (ino, size, mtimeMs), or the kind of whatever else is at a path.
function signatureOf(stats: Stats): string {
  if (stats.isFile()) return `file ${stats.ino} ${stats.size} ${stats.mtimeMs}`;
  return stats.isDirectory() ? "directory" : "other";
}

function unchanged(deps: Map<string, string>): boolean {
  for (const [path, signature] of deps) {
    let now: string;
    try {
      now = signatureOf(statSync(path));
    } catch (error) {
      now = isAbsent(error) ? ABSENT : `error ${codeOf(error)}`;
    }
    if (now !== signature) return false;
  }
  return true;
}

// One computation: the signature of every path it probed or read, the first one recorded for a
// path, and whether any file it read was too recent to trust.
class Reading {
  readonly deps = new Map<string, string>();
  racy = false;
  private readonly started = Date.now();
  private packed: PackedRefs | null | undefined;

  probe(
    path: string,
    label: string,
  ): "absent" | "directory" | "file" | "other" {
    const stats = this.stat(path, label);
    this.dep(path, stats === null ? ABSENT : signatureOf(stats));
    if (stats === null) return "absent";
    if (stats.isFile()) return "file";
    return stats.isDirectory() ? "directory" : "other";
  }

  // The text of the regular file at path, or null when nothing or a directory is there. Only a
  // regular file is opened, without blocking, so a FIFO never stalls the read.
  read(path: string, label: string, limit = SMALL_FILE): string | null {
    const stats = this.stat(path, label);
    if (stats === null || stats.isDirectory()) {
      this.dep(path, stats === null ? ABSENT : "directory");
      return null;
    }
    if (!stats.isFile()) throw new ReadError(label, "not a regular file");
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch (error) {
      throw new ReadError(label, codeOf(error));
    }
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile()) throw new ReadError(label, "not a regular file");
      if (opened.size > limit) throw new ReadError(label, "EFBIG");
      this.dep(path, signatureOf(opened));
      if (opened.mtimeMs > this.started - RACY_MS) this.racy = true;
      return readFileSync(fd, "utf8");
    } catch (error) {
      throw error instanceof ReadError
        ? error
        : new ReadError(label, codeOf(error));
    } finally {
      closeSync(fd);
    }
  }

  packedRefs(common: string): PackedRefs | null {
    if (this.packed === undefined) {
      const text = this.read(
        join(common, "packed-refs"),
        "packed-refs",
        Number.POSITIVE_INFINITY,
      );
      this.packed = text === null ? null : parsePacked(text);
    }
    return this.packed;
  }

  private stat(path: string, label: string): Stats | null {
    try {
      return statSync(path);
    } catch (error) {
      if (isAbsent(error)) return null;
      throw new ReadError(label, codeOf(error));
    }
  }

  private dep(path: string, signature: string): void {
    if (!this.deps.has(path)) this.deps.set(path, signature);
  }
}

// A file system error, named by the path's place in the git directory, never by a host path.
class ReadError extends Error {
  constructor(
    readonly label: string,
    readonly code: string,
  ) {
    super(`cannot read ${label}: ${code}`);
  }
}

function isAbsent(error: unknown): boolean {
  const code = codeOf(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function codeOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : "an unexpected error";
}

function unknown(reason: string): RefResult {
  return { commit: null, reason };
}

function cannotResolve(ref: string): RefResult {
  return unknown(`cannot resolve ${ref} from ref files`);
}
