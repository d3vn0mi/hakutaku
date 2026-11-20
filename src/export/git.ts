// The hardened git reader (interfaces section 3.6): with history.ts, the whole of export's
// contact with git, and nothing else in hakutaku runs git.
//
// Every call runs git with exactly GIT_ENV, a fresh empty HOME (removed afterwards) and this
// process's PATH, behind gitArgs' prefix. Export reads git objects only: raw cat-file, which
// applies no attributes, filters or textconv; ls-tree; and log. Names reach git only as
// 40-hex object names or on a batch process's standard input, never as an option. Every
// error from a git call carries the last 4 KiB of git's standard error.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comparePaths, type GitMode } from "../model/index.js";

export const GIT_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_LAZY_FETCH: "1",
  GIT_OPTIONAL_LOCKS: "0",
  // An empty list: no transport at all. Unlike -c protocol.allow=never, which only sets the
  // default, it outranks a repo's own protocol.<name>.allow=always, which would otherwise let
  // a promisor fetch run an ext:: remote's command or core.sshCommand on a git that ignores
  // GIT_NO_LAZY_FETCH (before 2.44).
  GIT_ALLOW_PROTOCOL: "",
  LANG: "C",
});

// GIT_ALLOW_PROTOCOL, protocol.allow=never and GIT_NO_LAZY_FETCH (where git honours it) each
// refuse a partial clone's promisor fetch before any transport, or the repo's core.sshCommand,
// runs; only GIT_ALLOW_PROTOCOL also outranks the repo's own protocol config. The repo's own
// .git/config still applies, so each option that shapes output is given here.
const PREFIX: readonly string[] = Object.freeze([
  "--no-pager",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "protocol.allow=never",
  "-c",
  "log.showSignature=false",
  "-c",
  "core.quotePath=false",
  "-c",
  "diff.renames=true",
  "-c",
  "diff.renameLimit=1000",
]);

export function gitArgs(repo: string, ...args: string[]): string[] {
  return [...PREFIX, "-C", repo, ...args];
}

export interface TreeEntry {
  path: string;
  mode: GitMode;
  type: "blob" | "commit";
  sha: string;
}

const OID_RE = /^[0-9a-f]{40}$/;
const STDERR_TAIL = 4096;

// An answer git gave that is not the one asked for, or that names nothing. Internal to
// src/export: runGit adds git's standard error to it.
export class BadAnswer extends Error {}

// A name that becomes an argument or a line of a batch process's input: 40 lower-case hex
// digits (a SHA-1 object name), so no option and no second query can ride on it.
export function checkOid(name: string): void {
  if (!OID_RE.test(name)) {
    throw new RangeError(`not a 40-hex object name: ${JSON.stringify(name)}`);
  }
}

// All of git's standard output, in one buffer, so that no character is decoded split.
export async function collect(stdout: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdout) chunks.push(chunk);
  return Buffer.concat(chunks);
}

interface End {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

function keepTail(tail: Buffer, chunk: Buffer): Buffer {
  const joined = Buffer.concat([tail, chunk]);
  return joined.length > STDERR_TAIL
    ? Buffer.from(joined.subarray(joined.length - STDERR_TAIL))
    : joined;
}

function withTail(message: string, tail: Buffer): string {
  const said = tail.toString("utf8").trimEnd();
  return said === "" ? message : `${message}\n${said}`;
}

// The failure an ended git process reports, or null for exit code 0.
function failure(name: string, end: End, tail: Buffer): Error | null {
  if (end.error !== undefined) {
    return new Error(withTail(`cannot run git: ${end.error.message}`, tail));
  }
  if (end.code === 0) return null;
  const how =
    end.code === null
      ? `was stopped by ${end.signal ?? "a signal"}`
      : `exited with code ${end.code}`;
  return new Error(withTail(`git ${name} ${how}`, tail));
}

// Runs `git <prefix> -C <repo> <args>`, writes `input` to its standard input, and hands its
// standard output to `read`. A BadAnswer from read, or a failed exit, becomes an error with
// git's standard error; any other error from read (a caller's callback) passes unchanged.
// Either way git is stopped and HOME removed before runGit returns.
export async function runGit<T>(
  repo: string,
  args: readonly string[],
  input: string,
  read: (stdout: AsyncIterable<Buffer>) => Promise<T>,
): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "hakutaku-git-"));
  try {
    const env: Record<string, string> = { ...GIT_ENV, HOME: home };
    const path = process.env.PATH;
    if (path !== undefined) env.PATH = path;
    const child = spawn("git", gitArgs(repo, ...args), { env });
    const name = args[0] ?? "";
    let tail: Buffer = Buffer.alloc(0);
    child.stderr.on("data", (chunk: Buffer) => {
      tail = keepTail(tail, chunk);
    });
    const ended = new Promise<End>((resolve) => {
      child.once("error", (error) =>
        resolve({ code: null, signal: null, error }),
      );
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    // git may stop reading before the end (a fatal error): its exit says why, not EPIPE.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    let value: T;
    try {
      value = await read(child.stdout);
    } catch (error) {
      child.kill("SIGKILL");
      const end = await ended;
      if (!(error instanceof BadAnswer)) throw error;
      // git's own failure explains a broken answer better than the break does.
      if (end.error !== undefined || (end.code !== null && end.code !== 0)) {
        throw failure(name, end, tail);
      }
      throw new Error(withTail(error.message, tail));
    }
    const failed = failure(name, await ended, tail);
    if (failed !== null) throw failed;
    return value;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const hasControl = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

const firstLine = (out: Buffer): string => {
  const nl = out.indexOf(0x0a);
  return out.toString("utf8", 0, nl === -1 ? out.length : nl);
};

// The time on the commit's committer line: the digits after its last ">", as git reads a
// commit's date. Only the header counts, which ends at the first empty line.
function committerTime(object: Buffer): number | null {
  const end = object.indexOf("\n\n");
  const header = object.toString("utf8", 0, end === -1 ? object.length : end);
  for (const line of header.split("\n")) {
    if (!line.startsWith("committer ")) continue;
    const gt = line.lastIndexOf(">");
    const digits = gt === -1 ? null : /^[ \t]*(\d+)/.exec(line.slice(gt + 1));
    if (digits === null) return null;
    const time = Number(digits[1]);
    return Number.isSafeInteger(time) ? time : null;
  }
  return null;
}

// cat-file --batch-check on <ref>^{commit}, then cat-file --batch for the commit object. A
// ref holding a control character is no ref: a line feed would ask a second question.
export async function resolveCommit(
  repo: string,
  ref: string,
): Promise<{ commit: string; commitTime: number }> {
  if (hasControl(ref)) throw new Error(`ref not found: ${ref}`);
  const commit = await runGit(
    repo,
    ["cat-file", "--batch-check"],
    `${ref}^{commit}\n`,
    async (stdout) => {
      const line = firstLine(await collect(stdout));
      const found = /^([0-9a-f]{40}) commit \d+$/.exec(line);
      if (found?.[1] !== undefined) return found[1];
      if (line.endsWith(" missing") || line.endsWith(" ambiguous")) {
        throw new BadAnswer(`ref not found: ${ref}`);
      }
      throw new BadAnswer(
        `unexpected answer from git cat-file: ${JSON.stringify(line)}`,
      );
    },
  );
  const commitTime = await runGit(
    repo,
    ["cat-file", "--batch"],
    `${commit}\n`,
    async (stdout) => {
      const out = await collect(stdout);
      const line = firstLine(out);
      const head = /^([0-9a-f]{40}) commit (\d+)$/.exec(line);
      const start = line.length + 1;
      const size = Number(head?.[2]);
      if (head?.[1] !== commit || out.length < start + size) {
        throw new BadAnswer(
          `unexpected answer from git cat-file: ${JSON.stringify(line)}`,
        );
      }
      const time = committerTime(out.subarray(start, start + size));
      if (time === null) {
        throw new BadAnswer(`cannot read the committer time of ${commit}`);
      }
      return time;
    },
  );
  return { commit, commitTime };
}

const TREE_LINE =
  /^(100644|100755|120000|160000) (blob|commit) ([0-9a-f]{40})$/;

// ls-tree -r -z --full-tree: every blob and submodule, in comparePaths order. A path is the
// bytes after the record's first tab, read as UTF-8; a byte that is not UTF-8 reads U+FFFD.
export async function listTree(
  repo: string,
  commit: string,
): Promise<TreeEntry[]> {
  checkOid(commit);
  const entries = await runGit(
    repo,
    ["ls-tree", "-r", "-z", "--full-tree", commit],
    "",
    async (stdout) => {
      const out = await collect(stdout);
      const found: TreeEntry[] = [];
      for (let at = 0; at < out.length; ) {
        let end = out.indexOf(0, at);
        if (end === -1) end = out.length;
        const tab = out.indexOf(0x09, at);
        const meta = TREE_LINE.exec(
          out.toString("latin1", at, tab === -1 || tab > end ? end : tab),
        );
        const [, mode, type, sha] = meta ?? [];
        if (
          tab === -1 ||
          tab > end ||
          mode === undefined ||
          sha === undefined ||
          (mode === "160000") !== (type === "commit")
        ) {
          throw new BadAnswer(
            `unexpected answer from git ls-tree: ${JSON.stringify(out.toString("utf8", at, end))}`,
          );
        }
        found.push({
          path: out.toString("utf8", tab + 1, end),
          mode: mode as GitMode,
          type: type as "blob" | "commit",
          sha,
        });
        at = end + 1;
      }
      return found;
    },
  );
  return entries.sort((a, b) => comparePaths(a.path, b.path));
}

// One cat-file --batch process, streamed: each blob is read whole, then handed to onBlob,
// in the order of shas, and the next is read only once onBlob has finished.
export async function readBlobs(
  repo: string,
  shas: readonly string[],
  onBlob: (sha: string, bytes: Uint8Array) => Promise<void>,
): Promise<void> {
  for (const sha of shas) checkOid(sha);
  if (shas.length === 0) return;
  await runGit(
    repo,
    ["cat-file", "--batch"],
    shas.map((sha) => `${sha}\n`).join(""),
    async (stdout) => {
      let next = 0; // the index of the blob being read
      let head: Buffer[] = []; // an unfinished header line
      let headLength = 0;
      let body: Uint8Array | null = null;
      let filled = 0;
      let newline = false; // the line feed after a blob's bytes is due
      for await (const chunk of stdout) {
        let at = 0;
        while (at < chunk.length) {
          if (newline) {
            if (chunk[at] !== 0x0a) {
              throw new BadAnswer("unexpected answer from git cat-file");
            }
            at += 1;
            newline = false;
            const sha = shas[next] ?? "";
            const bytes = body ?? new Uint8Array(0);
            next += 1;
            body = null;
            await onBlob(sha, bytes);
          } else if (body === null) {
            const nl = chunk.indexOf(0x0a, at);
            const end = nl === -1 ? chunk.length : nl;
            head.push(chunk.subarray(at, end));
            headLength += end - at;
            at = nl === -1 ? end : end + 1;
            if (headLength > 1024) {
              throw new BadAnswer("unexpected answer from git cat-file");
            }
            if (nl === -1) continue;
            const line = Buffer.concat(head).toString("latin1");
            head = [];
            headLength = 0;
            body = blobBody(line, shas[next]);
            filled = 0;
            newline = body.length === 0;
          } else {
            const take = Math.min(body.length - filled, chunk.length - at);
            body.set(chunk.subarray(at, at + take), filled);
            filled += take;
            at += take;
            newline = filled === body.length;
          }
        }
      }
      if (next < shas.length) {
        throw new BadAnswer(
          `git cat-file answered ${next} of ${shas.length} blobs`,
        );
      }
    },
  );
}

// The buffer for the blob a header announces: "<sha> blob <size>".
function blobBody(line: string, sha: string | undefined): Uint8Array {
  const missing = sha !== undefined && line === `${sha} missing`;
  if (missing) throw new BadAnswer(`blob not found: ${sha}`);
  const head = /^([0-9a-f]{40}) ([a-z]+) (\d+)$/.exec(line);
  const size = Number(head?.[3]);
  if (head === null || head[1] !== sha || !Number.isSafeInteger(size)) {
    throw new BadAnswer(
      `unexpected answer from git cat-file: ${JSON.stringify(line)}`,
    );
  }
  if (head[2] !== "blob") {
    throw new BadAnswer(`not a blob: ${sha} is a ${head[2]}`);
  }
  return new Uint8Array(size);
}
