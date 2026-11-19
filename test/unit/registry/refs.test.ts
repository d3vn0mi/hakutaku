import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, expect, it } from "vitest";
import { createRefReader } from "../../../src/registry/index.js";
import { git, makeRepo, type RepoSpec } from "../../helpers/git.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-refs-"));
  made.push(dir);
  return dir;
};

// Commits a day apart, so that HEAD~1 and HEAD name different commits.
const commits = (n: number): RepoSpec => ({
  commits: Array.from({ length: n }, (_, i) => ({
    date: `2026-03-0${i + 1}T10:00:00Z`,
    files: {
      [`web/src/orbits/orbit-${i + 1}.ts`]: `export const period = ${i + 1};\n`,
    },
  })),
});

const rev = (repo: string, rev: string): string => git(repo, "rev-parse", rev);

// A whole second long before any test runs. An answer that read files this old is kept, and a
// file set back to it has exactly its earlier mtimeMs.
const OLD = 1767225600; // 2026-01-01T00:00:00Z
const age = (...paths: string[]): void => {
  for (const path of paths) utimesSync(path, OLD, OLD);
};

const unknown = (reason: string) => ({ commit: null, reason });
const cannotResolve = (ref: string) =>
  unknown(`cannot resolve ${ref} from ref files`);

it("resolves HEAD through a loose branch", async () => {
  const repo = await makeRepo(commits(2));
  expect(readFileSync(join(repo, ".git/HEAD"), "utf8")).toBe(
    "ref: refs/heads/main\n",
  );
  expect(existsSync(join(repo, ".git/refs/heads/main"))).toBe(true);
  expect(existsSync(join(repo, ".git/packed-refs"))).toBe(false);
  expect(createRefReader()(repo, "HEAD")).toEqual({
    commit: rev(repo, "HEAD"),
  });
});

it("resolves origin/main from packed-refs", async () => {
  const repo = await makeRepo(commits(2));
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(repo, "pack-refs", "--all");
  expect(existsSync(join(repo, ".git/refs/remotes/origin/main"))).toBe(false);
  expect(readFileSync(join(repo, ".git/packed-refs"), "utf8")).toContain(
    `${rev(repo, "HEAD")} refs/remotes/origin/main\n`,
  );
  expect(createRefReader()(repo, "origin/main")).toEqual({
    commit: rev(repo, "HEAD"),
  });
});

it("prefers a loose ref over packed-refs", async () => {
  const repo = await makeRepo(commits(2));
  const older = rev(repo, "HEAD~1");
  const newer = rev(repo, "HEAD");
  git(repo, "update-ref", "refs/heads/main", older);
  git(repo, "pack-refs", "--all");
  git(repo, "update-ref", "refs/heads/main", newer); // a loose file over the packed line
  expect(readFileSync(join(repo, ".git/packed-refs"), "utf8")).toContain(
    `${older} refs/heads/main\n`,
  );
  const read = createRefReader();
  expect(read(repo, "main")).toEqual({ commit: newer });
  expect(read(repo, "HEAD")).toEqual({ commit: newer });
});

it("resolves a detached HEAD", async () => {
  const repo = await makeRepo(commits(2));
  const first = rev(repo, "HEAD~1");
  git(repo, "checkout", "--quiet", "--detach", "HEAD~1");
  expect(readFileSync(join(repo, ".git/HEAD"), "utf8")).toBe(`${first}\n`);
  expect(createRefReader()(repo, "HEAD")).toEqual({ commit: first });
});

it("follows a .git file to its gitdir", async () => {
  const repo = await makeRepo(commits(2));
  const gitdir = join(tmp(), "observatory.git");
  git(repo, "init", "--quiet", "--separate-git-dir", gitdir);
  expect(readFileSync(join(repo, ".git"), "utf8")).toBe(`gitdir: ${gitdir}\n`);
  expect(createRefReader()(repo, "HEAD")).toEqual({
    commit: rev(repo, "HEAD"),
  });
});

it("resolves HEAD in a linked worktree through commondir", async () => {
  const repo = await makeRepo(commits(2));
  const wt = join(tmp(), "side");
  git(repo, "worktree", "add", "--quiet", wt, "-b", "side");
  git(wt, "commit", "--quiet", "--allow-empty", "-m", "side"); // side moves past main
  const side = rev(wt, "HEAD");
  expect(side).not.toBe(rev(repo, "HEAD"));
  expect(
    readFileSync(join(repo, ".git/worktrees/side/commondir"), "utf8"),
  ).toBe("../..\n");
  expect(existsSync(join(repo, ".git/worktrees/side/refs/heads/side"))).toBe(
    false,
  );
  const read = createRefReader();
  expect(read(wt, "HEAD")).toEqual({ commit: side });
  expect(read(repo, "HEAD")).toEqual({ commit: rev(repo, "HEAD") });
});

it("sees a ref that gc packed and a fetch wrote loose again", async () => {
  const repo = await makeRepo(commits(2));
  const first = rev(repo, "HEAD~1");
  const second = rev(repo, "HEAD");
  const loose = join(repo, ".git/refs/remotes/origin/main");
  const packed = join(repo, ".git/packed-refs");
  const read = createRefReader();
  git(repo, "update-ref", "refs/remotes/origin/main", first);
  age(loose);
  expect(read(repo, "origin/main")).toEqual({ commit: first }); // loose
  git(repo, "pack-refs", "--all");
  age(packed); // so that the answer from packed-refs is kept
  expect(existsSync(loose)).toBe(false);
  expect(read(repo, "origin/main")).toEqual({ commit: first }); // packed
  git(repo, "update-ref", "refs/remotes/origin/main", second); // loose again
  expect(statSync(packed).mtimeMs).toBe(OLD * 1000); // packed-refs keeps its mtime
  expect(read(repo, "origin/main")).toEqual({ commit: second });
});

it("resolves a packed annotated tag through its peel line", async () => {
  const repo = await makeRepo(commits(2));
  git(repo, "tag", "-a", "v1", "-m", "v1");
  git(repo, "pack-refs", "--all");
  const tag = rev(repo, "v1");
  const commit = rev(repo, "v1^{commit}");
  expect(tag).not.toBe(commit);
  expect(readFileSync(join(repo, ".git/packed-refs"), "utf8")).toContain(
    `${tag} refs/tags/v1\n^${commit}\n`,
  );
  expect(createRefReader()(repo, "v1")).toEqual({ commit });
});

it("answers unknown for a loose annotated tag", async () => {
  const repo = await makeRepo(commits(2));
  git(repo, "tag", "-a", "v1", "-m", "v1");
  expect(existsSync(join(repo, ".git/refs/tags/v1"))).toBe(true);
  const reason =
    "a loose tag may name a tag object; only packed peeled tags are read";
  expect(createRefReader()(repo, "v1")).toEqual(unknown(reason));
  git(repo, "branch", "v1", "HEAD~1"); // refs/heads/v1 comes after refs/tags/v1
  expect(createRefReader()(repo, "v1")).toEqual(unknown(reason));
});

it("answers unknown for a reftable store", async () => {
  const repo = await makeRepo(commits(2));
  mkdirSync(join(repo, ".git/reftable"));
  const read = createRefReader();
  expect(read(repo, "HEAD")).toEqual(
    unknown("reftable ref storage is not read"),
  );
  expect(read(repo, "main")).toEqual(
    unknown("reftable ref storage is not read"),
  );
});

it("answers unknown for HEAD~1 and a missing ref, never throwing", async () => {
  const repo = await makeRepo(commits(2));
  const read = createRefReader();
  expect(read(repo, "HEAD~1")).toEqual(cannotResolve("HEAD~1"));
  expect(read(repo, "main@{u}")).toEqual(cannotResolve("main@{u}"));
  expect(read(repo, "nebula")).toEqual(cannotResolve("nebula"));
  expect(read(repo, "refs/heads/nebula")).toEqual(
    cannotResolve("refs/heads/nebula"),
  );
});

it("follows a new commit on the checked-out branch", async () => {
  const repo = await makeRepo(commits(2));
  age(join(repo, ".git/HEAD"), join(repo, ".git/refs/heads/main")); // so that the answer is kept
  const read = createRefReader();
  const before = rev(repo, "HEAD");
  expect(read(repo, "HEAD")).toEqual({ commit: before });
  git(repo, "commit", "--quiet", "--allow-empty", "-m", "next");
  const after = rev(repo, "HEAD");
  expect(after).not.toBe(before);
  expect(read(repo, "HEAD")).toEqual({ commit: after });
});

it("finds a bare repo by its HEAD and objects/", async () => {
  const repo = await makeRepo(commits(2));
  const bare = join(tmp(), "observatory.git");
  git(repo, "clone", "--quiet", "--bare", `file://${repo}`, bare);
  expect(existsSync(join(bare, "refs/heads/main"))).toBe(false); // the clone packed it
  const read = createRefReader();
  expect(read(bare, "HEAD")).toEqual({ commit: rev(repo, "HEAD") });
  expect(read(bare, "main")).toEqual({ commit: rev(repo, "HEAD") });
});

it("follows a .git file whose gitdir is relative to the repo", async () => {
  const repo = await makeRepo(commits(2));
  const gitdir = join(tmp(), "observatory.git");
  git(repo, "init", "--quiet", "--separate-git-dir", gitdir);
  writeFileSync(join(repo, ".git"), `gitdir: ${relative(repo, gitdir)}\n`);
  expect(rev(repo, "HEAD")).toBe(rev(gitdir, "HEAD"));
  expect(createRefReader()(repo, "HEAD")).toEqual({
    commit: rev(gitdir, "HEAD"),
  });
});

it("reads HEAD, refs/bisect/, refs/worktree/ and refs/rewritten/ from a worktree's gitdir, and other refs from the common directory", async () => {
  const repo = await makeRepo(commits(2));
  const first = rev(repo, "HEAD~1");
  const second = rev(repo, "HEAD");
  const wt = join(tmp(), "side");
  git(repo, "worktree", "add", "--quiet", "-b", "side", wt, "HEAD~1");
  const own = ["refs/bisect/bad", "refs/worktree/mark", "refs/rewritten/onto"];
  for (const ref of own) git(wt, "update-ref", ref, first);
  git(wt, "update-ref", "refs/heads/nebula", second);
  const read = createRefReader();
  for (const ref of own) {
    expect(existsSync(join(repo, ".git/worktrees/side", ref))).toBe(true);
    expect(read(wt, ref)).toEqual({ commit: first });
    expect(read(repo, ref)).toEqual(cannotResolve(ref));
  }
  expect(existsSync(join(repo, ".git/refs/heads/nebula"))).toBe(true);
  expect(read(wt, "nebula")).toEqual({ commit: second });
  expect(read(repo, "nebula")).toEqual({ commit: second });
  expect(read(wt, "HEAD")).toEqual({ commit: first });
  expect(read(repo, "HEAD")).toEqual({ commit: second });
});

it("takes the first of <x>, refs/<x>, refs/tags/<x>, refs/heads/<x>, refs/remotes/<x> and refs/remotes/<x>/HEAD, as git does", async () => {
  const repo = await makeRepo(commits(4));
  const [c0, c1, c2, c3] = ["HEAD~3", "HEAD~2", "HEAD~1", "HEAD"].map((r) =>
    rev(repo, r),
  );
  const read = createRefReader();
  const step = (name: string, commit: string): void => {
    expect(read(repo, name)).toEqual({ commit });
    expect(rev(repo, name)).toBe(commit);
  };
  git(repo, "update-ref", "refs/remotes/origin/main", c3);
  git(
    repo,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  );
  step("origin", c3); // refs/remotes/origin/HEAD
  git(repo, "update-ref", "refs/remotes/orbit", c0);
  step("orbit", c0); // refs/remotes/orbit
  git(repo, "update-ref", "refs/heads/orbit", c1);
  step("orbit", c1); // refs/heads/orbit
  git(repo, "update-ref", "refs/tags/orbit", c2);
  git(repo, "pack-refs", "--all"); // a packed lightweight tag
  step("orbit", c2); // refs/tags/orbit
  git(repo, "update-ref", "refs/orbit", c3);
  step("orbit", c3); // refs/orbit
  git(repo, "update-ref", "refs/refs/heads/orbit", c0);
  step("refs/heads/orbit", c1); // the name itself, before refs/<name>
  writeFileSync(join(repo, ".git/ORIG_HEAD"), `${c0}\n`);
  expect(read(repo, "ORIG_HEAD")).toEqual(cannotResolve("ORIG_HEAD")); // only HEAD is itself
});

it("follows symbolic refs through at most five ref files, as git does", async () => {
  const repo = await makeRepo(commits(2));
  let target = "refs/heads/main";
  for (const link of ["l4", "l3", "l2", "l1", "l0"]) {
    git(repo, "symbolic-ref", `refs/heads/${link}`, target);
    target = `refs/heads/${link}`;
  }
  const read = createRefReader();
  expect(read(repo, "refs/heads/l1")).toEqual({ commit: rev(repo, "HEAD") }); // l1, l2, l3, l4, main
  expect(read(repo, "refs/heads/l0")).toEqual(cannotResolve("refs/heads/l0")); // a sixth file
  expect(() =>
    git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/l0"),
  ).toThrow();
});

it("skips a dangling symbolic ref for the next candidate, as git does", async () => {
  const repo = await makeRepo(commits(2));
  git(repo, "symbolic-ref", "refs/heads/orbit", "refs/heads/gone");
  git(repo, "update-ref", "refs/remotes/orbit", "HEAD~1");
  expect(createRefReader()(repo, "orbit")).toEqual({
    commit: rev(repo, "HEAD~1"),
  });
  expect(rev(repo, "orbit")).toBe(rev(repo, "HEAD~1"));
});

it("takes a packed tag with no peel line as its own commit only under a fully-peeled header", async () => {
  const repo = await makeRepo(commits(2));
  git(repo, "tag", "nebula", "HEAD~1"); // a lightweight tag
  git(repo, "pack-refs", "--all");
  const packed = join(repo, ".git/packed-refs");
  const header = "# pack-refs with: peeled fully-peeled sorted \n";
  const text = readFileSync(packed, "utf8");
  expect(text.startsWith(header)).toBe(true);
  expect(text).not.toContain("^");
  expect(createRefReader()(repo, "nebula")).toEqual({
    commit: rev(repo, "HEAD~1"),
  });
  writeFileSync(
    packed,
    `# pack-refs with: peeled sorted \n${text.slice(header.length)}`,
  );
  const read = createRefReader();
  expect(read(repo, "nebula")).toEqual(
    unknown("a packed tag without a peel line may name a tag object"),
  );
  expect(read(repo, "refs/heads/main")).toEqual({ commit: rev(repo, "HEAD") }); // not a tag
});

it("answers a 40-hex ref as itself, in lower case, without reading the repo", () => {
  const sha = "fedcba9876543210fedcba9876543210fedcba98";
  const read = createRefReader();
  expect(read(join(tmp(), "nowhere"), sha)).toEqual({ commit: sha });
  expect(read(join(tmp(), "nowhere"), sha.toUpperCase())).toEqual({
    commit: sha,
  });
});

// Each name would resolve if it were looked up: through a path that leaves its directory, or
// through the file planted at its path under refs/heads/.
it.each<[string, string | null]>([
  ["../HEAD", null], // refs/../HEAD is .git/HEAD
  ["refs/heads/../../HEAD", null],
  ["heads/./main", null], // refs/heads/./main is refs/heads/main
  ["heads//main", null],
  ["/main", null], // refs/heads//main
  [".main", ".main"],
  ["main.lock", "main.lock"],
  ["main.", "main."],
  ["@", "@"],
  ["main^", "main^"],
  ["main@{1}", "main@{1}"],
  ["main:web", "main:web"],
  ["ma in", "ma in"],
  ["main\\web", "main\\web"],
  ["ma*", "ma*"],
  ["ma?", "ma?"],
  ["ma[", "ma["],
  ["main\u007f", "main\u007f"],
  ["main\u0000", null], // a path holding NUL is refused by the file system
  ["", null],
])(
  "answers cannot resolve for %j, a name git refuses, whatever its path holds",
  async (name, plant) => {
    const repo = await makeRepo(commits(2));
    if (plant !== null) {
      writeFileSync(
        join(repo, ".git/refs/heads", plant),
        `${rev(repo, "HEAD~1")}\n`,
      );
    }
    expect(createRefReader()(repo, name)).toEqual(cannotResolve(name));
  },
);

it("answers not a git repository for a directory or a file without one", async () => {
  const read = createRefReader();
  expect(read(tmp(), "HEAD")).toEqual(unknown("not a git repository"));
  expect(read(join(tmp(), "nowhere"), "HEAD")).toEqual(
    unknown("not a git repository"),
  );
  const file = join(tmp(), "notes.md");
  writeFileSync(file, "# Observatory\n");
  expect(read(file, "HEAD")).toEqual(unknown("not a git repository"));
  const odd = tmp();
  writeFileSync(join(odd, ".git"), "nebula\n"); // a .git file with no gitdir: line
  expect(read(odd, "HEAD")).toEqual(unknown("not a git repository"));
  const pruned = tmp();
  writeFileSync(join(pruned, ".git"), `gitdir: ${join(pruned, "gone")}\n`);
  expect(read(pruned, "HEAD")).toEqual(unknown("not a git repository"));
});

it.skipIf(process.getuid?.() === 0)(
  "answers unknown with the error code when a ref file cannot be read, and reads it once it can",
  async () => {
    const repo = await makeRepo(commits(2));
    age(join(repo, ".git/HEAD"));
    const heads = join(repo, ".git/refs/heads");
    const read = createRefReader();
    chmodSync(heads, 0o000);
    try {
      expect(read(repo, "HEAD")).toEqual(
        unknown("cannot read refs/heads/main: EACCES"),
      );
    } finally {
      chmodSync(heads, 0o755);
    }
    expect(read(repo, "HEAD")).toEqual({ commit: rev(repo, "HEAD") });
  },
);

it("keeps one answer per repo and ref", async () => {
  const a = await makeRepo(commits(2));
  const b = await makeRepo(commits(3)); // so that a's HEAD, a's nebula and b's HEAD all differ
  git(a, "branch", "nebula", "HEAD~1");
  const nebula = join(a, ".git/refs/heads/nebula");
  for (const repo of [a, b])
    age(join(repo, ".git/HEAD"), join(repo, ".git/refs/heads/main"));
  age(nebula);
  const read = createRefReader();
  expect(read(a, "HEAD")).toEqual({ commit: rev(a, "HEAD") });
  expect(read(b, "HEAD")).toEqual({ commit: rev(b, "HEAD") });
  expect(read(a, "nebula")).toEqual({ commit: rev(a, "HEAD~1") });
  expect(read(b, "nebula")).toEqual(cannotResolve("nebula"));
  expect(read(a, "HEAD")).toEqual({ commit: rev(a, "HEAD") });
});

it("answers from its cache while every file it read keeps its inode, size and mtime", async () => {
  const repo = await makeRepo(commits(2));
  const first = rev(repo, "HEAD~1");
  const second = rev(repo, "HEAD");
  const main = join(repo, ".git/refs/heads/main");
  age(join(repo, ".git/HEAD"), main);
  const read = createRefReader();
  expect(read(repo, "HEAD")).toEqual({ commit: second });
  const ino = statSync(main).ino;
  writeFileSync(main, `${first}\n`); // in place: the same inode and size
  age(main); // and the same mtime
  expect(statSync(main).ino).toBe(ino);
  expect(read(repo, "HEAD")).toEqual({ commit: second }); // the kept answer
  expect(createRefReader()(repo, "HEAD")).toEqual({ commit: first });
});

it("reads a file again when it was read within two seconds of its mtime", async () => {
  const repo = await makeRepo(commits(2));
  const first = rev(repo, "HEAD~1");
  const second = rev(repo, "HEAD");
  const main = join(repo, ".git/refs/heads/main");
  age(join(repo, ".git/HEAD"));
  const now = Math.floor(Date.now() / 1000); // a whole second, under a second ago
  utimesSync(main, now, now);
  const read = createRefReader();
  expect(read(repo, "HEAD")).toEqual({ commit: second });
  const ino = statSync(main).ino;
  writeFileSync(main, `${first}\n`); // in place: the same inode and size
  utimesSync(main, now, now); // and the same mtime, as a write in the same clock tick leaves
  expect(statSync(main).ino).toBe(ino);
  expect(read(repo, "HEAD")).toEqual({ commit: first });
});

it.each<[string, (main: string, sha: string) => void]>([
  [
    "its mtime",
    (main, sha) => {
      writeFileSync(main, `${sha}\n`); // in place: the same inode and size
      utimesSync(main, OLD + 60, OLD + 60);
    },
  ],
  [
    "its inode",
    (main, sha) => {
      writeFileSync(`${main}.next`, `${sha}\n`); // the same size
      utimesSync(`${main}.next`, OLD, OLD); // and the same mtime
      renameSync(`${main}.next`, main);
    },
  ],
  [
    "its size",
    (main, sha) => {
      writeFileSync(main, `${sha}\n\n`); // in place: the same inode
      utimesSync(main, OLD, OLD); // and the same mtime
    },
  ],
])("reads a file again when %s alone changes", async (_, change) => {
  const repo = await makeRepo(commits(2));
  const first = rev(repo, "HEAD~1");
  const main = join(repo, ".git/refs/heads/main");
  age(join(repo, ".git/HEAD"), main);
  const read = createRefReader();
  expect(read(repo, "HEAD")).toEqual({ commit: rev(repo, "HEAD") });
  change(main, first);
  expect(read(repo, "HEAD")).toEqual({ commit: first });
});

it("recomputes when a path it found absent appears: a reftable directory, or a repo's .git", async () => {
  const repo = await makeRepo(commits(2));
  const head = rev(repo, "HEAD");
  age(join(repo, ".git/HEAD"), join(repo, ".git/refs/heads/main"));
  const read = createRefReader();
  renameSync(join(repo, ".git"), join(repo, ".git-away"));
  expect(read(repo, "HEAD")).toEqual(unknown("not a git repository"));
  renameSync(join(repo, ".git-away"), join(repo, ".git"));
  expect(read(repo, "HEAD")).toEqual({ commit: head });
  mkdirSync(join(repo, ".git/reftable"));
  expect(read(repo, "HEAD")).toEqual(
    unknown("reftable ref storage is not read"),
  );
});

it("skips a symbolic ref whose target leaves its directory for the next candidate, as git does", async () => {
  const repo = await makeRepo(commits(2));
  // refs/heads/../../HEAD joins to .git/HEAD, which would resolve to main's commit
  writeFileSync(
    join(repo, ".git/refs/heads/orbit"),
    "ref: refs/heads/../../HEAD\n",
  );
  git(repo, "update-ref", "refs/remotes/orbit", "HEAD~1");
  expect(createRefReader()(repo, "orbit")).toEqual({
    commit: rev(repo, "HEAD~1"),
  });
  expect(rev(repo, "orbit")).toBe(rev(repo, "HEAD~1"));
});

it("answers unknown with EFBIG for a ref file over 64 KiB", async () => {
  const repo = await makeRepo(commits(2));
  const main = join(repo, ".git/refs/heads/main");
  writeFileSync(main, `${rev(repo, "HEAD")}\n${" ".repeat(64 * 1024)}`); // a sha, then white space
  expect(createRefReader()(repo, "HEAD")).toEqual(
    unknown("cannot read refs/heads/main: EFBIG"),
  );
});

it("answers unknown, without blocking, for a FIFO at a ref path", async () => {
  const repo = await makeRepo(commits(2));
  const main = join(repo, ".git/refs/heads/main");
  rmSync(main);
  execFileSync("mkfifo", [main]);
  expect(createRefReader()(repo, "HEAD")).toEqual(
    unknown("cannot read refs/heads/main: not a regular file"),
  );
});
