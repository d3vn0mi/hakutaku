// The history export keeps: the commits whose committer time is in
// the 26 weeks up to the built commit's, newest first, with the files each one touched.
import { comparePaths } from "../model/index.js";
import { BadAnswer, checkOid, collect, runGit } from "./git.js";

export const HISTORY_WINDOW_SECONDS = 15724800; // 26 weeks

export interface History {
  commit: string;
  commitTime: number;
  windowSeconds: 15724800;
  // committer time in (commitTime - windowSeconds, commitTime], newest first
  commits: Array<{
    sha: string;
    time: number;
    files: string[];
    renames: Array<{ from: string; to: string }>;
  }>;
}

type HistoryCommit = History["commits"][number];

// git reads a bare "@<n>" as a time only from n = 100000000, in 1973, and any smaller n as
// some other date. "@<n> +0000" is git's raw date form, which it reads exactly for every n.
const rawDate = (seconds: number): string => `@${seconds} +0000`;

// The log call, with three details: --root, so that a repo's
// log.showRoot=false cannot hide the files of a root commit (a shallow clone's edge is
// one); the raw date form; and "--" after the commit, so git never looks for a file of
// that name in the work tree.
export async function readHistory(
  repo: string,
  commit: string,
  commitTime: number,
): Promise<History> {
  checkOid(commit);
  if (!Number.isSafeInteger(commitTime) || commitTime < 0) {
    throw new RangeError(`not a commit time: ${commitTime}`);
  }
  const opens = commitTime - HISTORY_WINDOW_SECONDS;
  const read = await runGit(
    repo,
    [
      "log",
      "-z",
      "--name-status",
      "-M",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--root",
      "--format=format:@@%H%x00%ct",
      `--since=${rawDate(Math.max(0, opens))}`,
      `--until=${rawDate(commitTime)}`,
      commit,
      "--",
    ],
    "",
    async (stdout) => parseLog(await collect(stdout)),
  );
  // git keeps a commit at exactly --since, where the window is open, and walks commits in
  // its own order, which a clock set wrong can make other than newest first. The sort is
  // stable: commits with the same time keep git's order.
  const commits = read
    .filter((c) => c.time > opens && c.time <= commitTime)
    .sort((a, b) => b.time - a.time);
  return {
    commit,
    commitTime,
    windowSeconds: HISTORY_WINDOW_SECONDS,
    commits,
  };
}

// Each NUL-separated field of the output, read as UTF-8 (a byte that is not reads U+FFFD).
function fields(out: Buffer): string[] {
  const found: string[] = [];
  let at = 0;
  for (;;) {
    const end = out.indexOf(0, at);
    found.push(out.toString("utf8", at, end === -1 ? out.length : end));
    if (end === -1) return found;
    at = end + 1;
  }
}

const HEADER_RE = /^@@([0-9a-f]{40})$/;
const STATUS_RE = /^([ACDMRTUXB])\d*$/;

const unexpected = (field: string | undefined): BadAnswer =>
  new BadAnswer(
    `unexpected answer from git log: ${JSON.stringify(field ?? "(the end)")}`,
  );

// git log -z --name-status --format=format:@@%H%x00%ct writes each commit as "@@<sha>", NUL,
// its time; then, when it changed files, a line feed and one entry per file: a status, NUL,
// a path, NUL (R and C give the old path, then the new one), and one more NUL. Fields are
// read by position, so a path that starts with "@@" stays a path. %ct prints digits, or
// nothing for a committer line git cannot read; such a time reads NaN, outside any window.
// Each commit lists the paths it touched once, in comparePaths order (a repo's
// diff.orderFile reorders git's list), a deleted path and a rename's new path included.
function parseLog(out: Buffer): HistoryCommit[] {
  const list = fields(out);
  const commits: HistoryCommit[] = [];
  let i = 0;
  const path = (): string => {
    const field = list[i];
    if (field === undefined || field === "") throw unexpected(field);
    i += 1;
    return field;
  };
  while (i < list.length) {
    const header = list[i];
    i += 1;
    if (header === "") continue; // the NUL after a commit's entries, or a final one
    const sha = HEADER_RE.exec(header ?? "")?.[1];
    const second = list[i];
    if (sha === undefined || second === undefined) throw unexpected(header);
    i += 1;
    const nl = second.indexOf("\n");
    const time = nl === -1 ? second : second.slice(0, nl);
    const files: string[] = [];
    const renames: Array<{ from: string; to: string }> = [];
    let status = nl === -1 ? undefined : second.slice(nl + 1);
    while (status !== undefined) {
      const kind = STATUS_RE.exec(status)?.[1];
      if (kind === undefined) throw unexpected(status);
      const from = path();
      if (kind === "R" || kind === "C") {
        const to = path();
        files.push(to);
        if (kind === "R") renames.push({ from, to });
      } else {
        files.push(from);
      }
      const next = list[i];
      if (next === undefined || next === "") {
        status = undefined;
      } else {
        status = next;
        i += 1;
      }
    }
    commits.push({
      sha,
      time: /^\d+$/.test(time) ? Number(time) : Number.NaN,
      files: [...new Set(files)].sort(comparePaths),
      renames: sortRenames(renames),
    });
  }
  return commits;
}

// Renames in (from, to) order, each once.
function sortRenames(
  renames: Array<{ from: string; to: string }>,
): Array<{ from: string; to: string }> {
  const sorted = renames.sort(
    (a, b) => comparePaths(a.from, b.from) || comparePaths(a.to, b.to),
  );
  return sorted.filter(
    (r, k) =>
      k === 0 || r.from !== sorted[k - 1]?.from || r.to !== sorted[k - 1]?.to,
  );
}
