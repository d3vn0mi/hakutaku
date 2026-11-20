import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { resolveCommit } from "../../../src/export/git.js";
import { readHistory } from "../../../src/export/history.js";
import { git, makeRepo, type RepoSpec } from "../../helpers/git.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-history-"));
  made.push(dir);
  return dir;
};

const W = 15724800; // 26 weeks
const DAY = 86400;
const T = Date.parse("2026-03-03T10:00:00Z") / 1000; // the built commit's time

// Unix seconds as an ISO 8601 date, for makeRepo.
const at = (seconds: number): string =>
  new Date(seconds * 1000).toISOString().replace(".000Z", "Z");

// The shas of HEAD, HEAD~1, ... HEAD~(n-1): newest first.
const shas = (repo: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => git(repo, "rev-parse", `HEAD~${i}`));

// One commit per time, oldest first, each changing the same file.
const timed = (...times: number[]): RepoSpec => ({
  commits: times.map((time, i) => ({
    date: at(time),
    files: { "web/src/orbits/orbit.ts": `export const period = ${i};\n` },
  })),
});

const change = (sha: string, time: number) => ({
  sha,
  time,
  files: ["web/src/orbits/orbit.ts"],
  renames: [],
});

// A day apart. The newest adds a file whose name starts with "@@", the log format's own
// commit marker.
const threeCommits = (): RepoSpec => ({
  commits: [
    {
      date: at(T - 2 * DAY),
      files: {
        "web/src/orbits/orbit.ts": "export const period = 1;\n",
        "sim/src/observatory/ephemeris.py": "PERIOD = 1\n",
        "README.md": "# Observatory\n",
      },
    },
    {
      date: at(T - DAY),
      files: {
        "web/src/orbits/orbit.ts": "export const period = 2;\n",
        "web/src/sky map.ts": "export const map = 1;\n",
        "README.md": null,
      },
    },
    {
      date: at(T),
      files: {
        "sim/src/observatory/ephemeris.py": "PERIOD = 2\n",
        "@@sky.md": "# Sky\n",
      },
    },
  ],
});

it("reads commits newest first with their files", async () => {
  // A deleted file counts as touched, as with git log --name-only.
  const repo = await makeRepo(threeCommits());
  const [c3 = "", c2, c1] = shas(repo, 3);
  expect(await readHistory(repo, c3, T)).toStrictEqual({
    commit: c3,
    commitTime: T,
    windowSeconds: 15724800,
    commits: [
      {
        sha: c3,
        time: T,
        files: ["@@sky.md", "sim/src/observatory/ephemeris.py"],
        renames: [],
      },
      {
        sha: c2,
        time: T - DAY,
        files: ["README.md", "web/src/orbits/orbit.ts", "web/src/sky map.ts"],
        renames: [],
      },
      {
        sha: c1,
        time: T - 2 * DAY,
        files: [
          "README.md",
          "sim/src/observatory/ephemeris.py",
          "web/src/orbits/orbit.ts",
        ],
        renames: [],
      },
    ],
  });
});

it("records a rename", async () => {
  // orbit.ts moves unchanged (R100); moon.ts moves with one line changed (a lower score).
  const orbit =
    "export const period = 1;\nexport const eccentricity = 0.1;\nexport const inclination = 0.2;\n";
  const moon =
    "export const radius = 1737;\nexport const mass = 7.35;\nexport const albedo = 0.12;\nexport const tilt = 6.7;\n";
  const repo = await makeRepo({
    commits: [
      {
        date: at(T - DAY),
        files: {
          "web/src/orbits/orbit.ts": orbit,
          "web/src/orbits/moon.ts": moon,
        },
      },
      {
        date: at(T),
        rename: ["web/src/orbits/orbit.ts", "web/src/orbits/kepler.ts"],
        files: {
          "web/src/orbits/moon.ts": null,
          "web/src/orbits/luna.ts": moon.replace("6.7", "6.68"),
        },
      },
    ],
  });
  const [c2 = "", c1] = shas(repo, 2);
  expect((await readHistory(repo, c2, T)).commits).toStrictEqual([
    {
      sha: c2,
      time: T,
      files: ["web/src/orbits/kepler.ts", "web/src/orbits/luna.ts"],
      renames: [
        { from: "web/src/orbits/moon.ts", to: "web/src/orbits/luna.ts" },
        { from: "web/src/orbits/orbit.ts", to: "web/src/orbits/kepler.ts" },
      ],
    },
    {
      sha: c1,
      time: T - DAY,
      files: ["web/src/orbits/moon.ts", "web/src/orbits/orbit.ts"],
      renames: [],
    },
  ]);
});

it("keeps only commits inside the 26-week window", async () => {
  // t - W - 1 is older than the window, t - W is its open end and out, t - W + 1 is in, and
  // t + 1 is newer than the built commit.
  const repo = await makeRepo(timed(T - W - 1, T - W, T - W + 1, T + 1, T));
  const [c5 = "", , c3 = ""] = shas(repo, 3);
  expect((await readHistory(repo, c5, T)).commits).toStrictEqual([
    change(c5, T),
    change(c3, T - W + 1),
  ]);
});

it("reads a shallow clone without failing", async () => {
  const full = await makeRepo(threeCommits());
  const shallow = join(tmp(), "shallow");
  git(tmp(), "clone", "--depth", "1", `file://${full}`, shallow);
  const head = await resolveCommit(shallow, "HEAD");
  const history = await readHistory(shallow, head.commit, head.commitTime);
  expect(history.commits).toHaveLength(1);
  // The commit at the clone's edge has no parent there, so it adds every file it holds.
  expect(history.commits[0]?.files).toStrictEqual([
    "@@sky.md",
    "sim/src/observatory/ephemeris.py",
    "web/src/orbits/orbit.ts",
    "web/src/sky map.ts",
  ]);
});

it("reads the first commit's files even when the repo's config sets log.showRoot false", async () => {
  const repo = await makeRepo(timed(T));
  git(repo, "config", "log.showRoot", "false");
  const [c1 = ""] = shas(repo, 1);
  expect((await readHistory(repo, c1, T)).commits).toStrictEqual([
    change(c1, T),
  ]);
});

it("reads a window that starts before 1973, or would start before 1970, exactly", async () => {
  // git reads a bare --since=@<n> as a time only from n = 100000000, in 1973.
  const t = Date.parse("1970-08-01T00:00:00Z") / 1000;
  const repo = await makeRepo(timed(DAY, t - W, t - W + 1, t));
  const [c4 = "", c3 = ""] = shas(repo, 2);
  expect((await readHistory(repo, c4, t)).commits).toStrictEqual([
    change(c4, t),
    change(c3, t - W + 1),
  ]);
  const early = await makeRepo(timed(1, DAY));
  const [e2 = "", e1 = ""] = shas(early, 2);
  expect((await readHistory(early, e2, DAY)).commits).toStrictEqual([
    change(e2, DAY),
    change(e1, 1),
  ]);
});

it("orders commits by their times, not by the order git walks them in", async () => {
  // The middle commit is older than its parent, so git walks it before the parent.
  const repo = await makeRepo(timed(T - 100, T - 200, T));
  const [c3 = "", c2 = "", c1 = ""] = shas(repo, 3);
  expect((await readHistory(repo, c3, T)).commits).toStrictEqual([
    change(c3, T),
    change(c1, T - 100),
    change(c2, T - 200),
  ]);
});

it("gives an empty commit no files", async () => {
  const orbit = (period: number) => ({
    "web/src/orbits/orbit.ts": `export const period = ${period};\n`,
  });
  const repo = await makeRepo({
    commits: [
      { date: at(T - 2 * DAY), files: orbit(1) },
      { date: at(T - DAY), files: {} },
      { date: at(T), files: orbit(2) },
    ],
  });
  const [c3 = "", c2 = "", c1 = ""] = shas(repo, 3);
  expect((await readHistory(repo, c3, T)).commits).toStrictEqual([
    change(c3, T),
    { sha: c2, time: T - DAY, files: [], renames: [] },
    change(c1, T - 2 * DAY),
  ]);
});

it("lists a commit's files in path order, whatever order the repo's diff.orderFile asks for", async () => {
  const repo = await makeRepo({
    commits: [
      {
        date: at(T),
        files: {
          "README.md": "# Observatory\n",
          "sim/src/observatory/ephemeris.py": "PERIOD = 1\n",
          "web/src/orbits/orbit.ts": "export const period = 1;\n",
        },
      },
    ],
  });
  writeFileSync(join(repo, "order.txt"), "web/*\nsim/*\n*\n");
  git(repo, "config", "diff.orderFile", "order.txt");
  const [c1 = ""] = shas(repo, 1);
  expect((await readHistory(repo, c1, T)).commits[0]?.files).toStrictEqual([
    "README.md",
    "sim/src/observatory/ephemeris.py",
    "web/src/orbits/orbit.ts",
  ]);
});

it("times each commit by its committer, not its author", async () => {
  const repo = await makeRepo(timed(T));
  git(
    repo,
    "commit",
    "--quiet",
    "--amend",
    "--no-edit",
    "--date=2020-01-01T00:00:00Z",
  );
  const head = await resolveCommit(repo, "HEAD");
  expect(
    (await readHistory(repo, head.commit, head.commitTime)).commits,
  ).toStrictEqual([change(head.commit, head.commitTime)]);
});

it("reads the history when the work tree holds a file named after the commit", async () => {
  const repo = await makeRepo(timed(T));
  const [c1 = ""] = shas(repo, 1);
  writeFileSync(join(repo, c1), "untracked\n");
  expect((await readHistory(repo, c1, T)).commits).toStrictEqual([
    change(c1, T),
  ]);
});

it("refuses a commit that is not 40 lower-case hex digits, and a time that is not one, before git runs", async () => {
  const repo = await makeRepo(timed(T));
  const [c1 = ""] = shas(repo, 1);
  const out = join(tmp(), "log.txt");
  for (const commit of [`--output=${out}`, "HEAD", c1.toUpperCase()]) {
    await expect(readHistory(repo, commit, T)).rejects.toThrow(RangeError);
  }
  expect(existsSync(out)).toBe(false);
  for (const time of [T + 0.5, -1, Number.NaN]) {
    await expect(readHistory(repo, c1, time)).rejects.toThrow(RangeError);
  }
});
