import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import {
  GIT_ENV,
  gitArgs,
  listTree,
  readBlobs,
  resolveCommit,
} from "../../../src/export/git.js";
import { comparePaths } from "../../../src/model/index.js";
import { git, makeRepo, type RepoSpec } from "../../helpers/git.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-export-"));
  made.push(dir);
  return dir;
};

const one = (): RepoSpec => ({
  commits: [
    {
      date: "2026-03-01T10:00:00Z",
      files: { "web/src/orbits/orbit.ts": "export const period = 1;\n" },
    },
  ],
});

const rev = (repo: string, name: string): string =>
  git(repo, "rev-parse", name);

// Control characters and U+FFFD are built from their codes, so this file holds none raw.
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xfffd);

// A `git` on PATH that runs `script` under this Node, as CommonJS.
function fakeGit(script: string): string {
  const bin = join(tmp(), "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!${process.execPath}\n${script}\n`);
  chmodSync(join(bin, "git"), 0o755);
  return bin;
}

// Runs `job` with `bin` first on PATH, then puts PATH back.
async function withPath<T>(bin: string, job: () => Promise<T>): Promise<T> {
  const old = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${old ?? ""}`;
  try {
    return await job();
  } finally {
    if (old === undefined) delete process.env.PATH;
    else process.env.PATH = old;
  }
}

it("puts the hardening options before -C", () =>
  expect(gitArgs("/r", "ls-tree")).toEqual([
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
    "-C",
    "/r",
    "ls-tree",
  ]));

it("holds exactly the seven fixed environment keys", () =>
  expect(GIT_ENV).toEqual({
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_ALLOW_PROTOCOL: "",
    LANG: "C",
  }));

it("never fetches a missing blob from a promisor remote", async () => {
  const src = await makeRepo(one());
  git(src, "config", "uploadpack.allowFilter", "true");
  const dir = tmp();
  const clone = join(dir, "clone");
  git(
    dir,
    "clone",
    "--quiet",
    "--filter=blob:none",
    "--no-checkout",
    `file://${src}`,
    clone,
  );
  const missingBlob = rev(src, "HEAD:web/src/orbits/orbit.ts");
  expect(
    git(clone, "rev-list", "--objects", "--missing=print", "HEAD"),
  ).toContain(`?${missingBlob}`);
  const canary = join(dir, "canary");
  const ssh = join(dir, "ssh.sh");
  writeFileSync(ssh, `#!/bin/sh\necho fetched > '${canary}'\nexit 1\n`);
  chmodSync(ssh, 0o755);
  git(clone, "remote", "set-url", "origin", "ssh://example.invalid/x.git");
  git(clone, "config", "core.sshCommand", ssh);
  // The control: git without the hardening does run the remote's ssh command for the blob.
  expect(() => git(clone, "cat-file", "-p", missingBlob)).toThrow();
  expect(existsSync(canary)).toBe(true);
  rmSync(canary);
  await expect(readBlobs(clone, [missingBlob], async () => {})).rejects.toThrow(
    missingBlob,
  );
  expect(existsSync(canary)).toBe(false);
});

it("refuses every transport for a promisor fetch, whatever the repo's protocol config allows", async () => {
  // git before 2.44 ignores GIT_NO_LAZY_FETCH; a fake git that drops it stands for one. The
  // repo's own protocol.<name>.allow=always outranks -c protocol.allow=never, and an ext::
  // remote runs any command, so only GIT_ALLOW_PROTOCOL keeps the fetch from starting.
  const src = await makeRepo(one());
  git(src, "config", "uploadpack.allowFilter", "true");
  const dir = tmp();
  const clone = join(dir, "clone");
  git(
    dir,
    "clone",
    "--quiet",
    "--filter=blob:none",
    "--no-checkout",
    `file://${src}`,
    clone,
  );
  const missingBlob = rev(src, "HEAD:web/src/orbits/orbit.ts");
  const real = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  const bin = fakeGit(
    [
      `const { spawnSync } = require("node:child_process");`,
      `const env = { ...process.env };`,
      `delete env.GIT_NO_LAZY_FETCH;`,
      `const run = spawnSync(${JSON.stringify(real)}, process.argv.slice(2), { stdio: "inherit", env });`,
      `process.exit(run.status === null ? 1 : run.status);`,
    ].join("\n"),
  );
  const canary = join(dir, "canary");
  const ssh = join(dir, "ssh.sh");
  writeFileSync(ssh, `#!/bin/sh\necho fetched > '${canary}'\nexit 1\n`);
  chmodSync(ssh, 0o755);
  const remotes: Array<[string, string]> = [
    ["ssh", "ssh://example.invalid/x.git"],
    ["ext", `ext::${ssh}`],
  ];
  git(clone, "config", "core.sshCommand", ssh);
  for (const [protocol, url] of remotes) {
    git(clone, "remote", "set-url", "origin", url);
    git(clone, "config", `protocol.${protocol}.allow`, "always");
    await expect(
      withPath(bin, () => readBlobs(clone, [missingBlob], async () => {})),
    ).rejects.toThrow(missingBlob);
    expect(existsSync(canary)).toBe(false);
  }
});

it("resolves a branch, a tag and a full sha to the commit and its committer time", async () => {
  const repo = await makeRepo({
    commits: [{ date: "2026-03-01T10:00:00Z", files: { "web/a.ts": "a" } }],
  });
  git(repo, "tag", "-a", "v1", "-m", "v1");
  const sha = rev(repo, "HEAD");
  for (const ref of ["main", "v1", sha]) {
    expect(await resolveCommit(repo, ref)).toEqual({
      commit: sha,
      commitTime: Date.parse("2026-03-01T10:00:00Z") / 1000,
    });
  }
});

it("takes the committer's time, not the author's", async () => {
  const repo = await makeRepo(one());
  git(
    repo,
    "commit",
    "--quiet",
    "--amend",
    "--no-edit",
    "--date=2020-01-01T00:00:00Z",
  );
  const authored = Number(git(repo, "log", "-1", "--format=%at"));
  const committed = Number(git(repo, "log", "-1", "--format=%ct"));
  expect(authored).toBe(Date.parse("2020-01-01T00:00:00Z") / 1000);
  expect(committed).not.toBe(authored);
  expect(await resolveCommit(repo, "main")).toEqual({
    commit: rev(repo, "HEAD"),
    commitTime: committed,
  });
});

it("fails with ref not found for a missing ref", async () =>
  expect(resolveCommit(await makeRepo(one()), "nebula")).rejects.toThrow(
    "ref not found: nebula",
  ));

it("fails with ref not found for a tree, a blob, and a ref holding a control character", async () => {
  // Without the control-character rule, "main<LF>main" asks git two questions and answers
  // the first, and "main<NUL>" reads as main.
  const repo = await makeRepo(one());
  const refs = [
    rev(repo, "HEAD^{tree}"),
    rev(repo, "HEAD:web/src/orbits/orbit.ts"),
    `main${LF}main`,
    `main${NUL}`,
    `main${TAB}`,
  ];
  for (const ref of refs) {
    await expect(resolveCommit(repo, ref)).rejects.toThrow(
      `ref not found: ${ref}`,
    );
  }
});

it("adds what git wrote to its standard error, if anything, on the lines after ref not found", async () => {
  // For a tree, git explains on its standard error why the tree is no commit; for a missing
  // name it writes nothing.
  const repo = await makeRepo(one());
  const tree = rev(repo, "HEAD^{tree}");
  const message = (ref: string) =>
    resolveCommit(repo, ref).then(
      () => "",
      (e: unknown) => (e as Error).message,
    );
  const [first, ...rest] = (await message(tree)).split(LF);
  expect(first).toBe(`ref not found: ${tree}`);
  expect(rest.join(LF)).toContain(tree);
  expect(await message("nebula")).toBe("ref not found: nebula");
});

it("lists odd names exactly", async () => {
  const names = [
    "sky map.ts",
    "a#b.ts",
    "100%.ts",
    "c:d.ts",
    "notes~old/x.md",
    "scripts/sync-",
    "web/a--b/c.ts",
    "étoile/漢.ts",
    "<b>bold</b>.ts",
  ];
  const repo = await makeRepo({
    commits: [
      {
        date: "2026-03-01T10:00:00Z",
        files: Object.fromEntries(names.map((n) => [n, n])),
      },
    ],
  });
  const tree = await listTree(repo, git(repo, "rev-parse", "HEAD"));
  expect(tree.map((e) => e.path).sort(comparePaths)).toEqual(
    [...names].sort(comparePaths),
  );
});

it("lists each entry's mode, type and object in path order, names holding a tab or a newline included", async () => {
  // git lists U+FF5A before U+1F600 (UTF-8 bytes EF BD 9A, F0 9F 98 80); in UTF-16 code
  // units the order is the other way round (FF5A, D83D DE00).
  const wide = `sky/${String.fromCharCode(0xff5a)}.ts`;
  const astral = `sky/${String.fromCodePoint(0x1f600)}.ts`;
  const repo = await makeRepo({
    commits: [
      {
        date: "2026-03-01T10:00:00Z",
        files: {
          "web/src/orbits/orbit.ts": "export const period = 1;\n",
          "scripts/sync.sh": { mode: "100755", text: "#!/bin/sh\n" },
          "web/link.ts": { link: "src/orbits/orbit.ts" },
          [`sky${TAB}map.ts`]: "tab",
          [`sky${LF}map.ts`]: "newline",
          [wide]: "wide",
          [astral]: "astral",
        },
      },
    ],
  });
  const lib = rev(repo, "HEAD");
  git(repo, "update-index", "--add", "--cacheinfo", `160000,${lib},vendor/lib`);
  git(repo, "commit", "--quiet", "-m", "vendor lib");
  const entry = (path: string, mode: string, type: string) => ({
    path,
    mode,
    type,
    sha: type === "commit" ? lib : rev(repo, `HEAD:${path}`),
  });
  expect(await listTree(repo, rev(repo, "HEAD"))).toStrictEqual([
    entry("scripts/sync.sh", "100755", "blob"),
    entry(`sky${TAB}map.ts`, "100644", "blob"),
    entry(`sky${LF}map.ts`, "100644", "blob"),
    entry(astral, "100644", "blob"),
    entry(wide, "100644", "blob"),
    entry("vendor/lib", "160000", "commit"),
    entry("web/link.ts", "120000", "blob"),
    entry("web/src/orbits/orbit.ts", "100644", "blob"),
  ]);
});

it("reads a name that is not UTF-8 with U+FFFD for each byte it cannot decode", async () => {
  const repo = await makeRepo(one());
  const name = Buffer.concat([
    Buffer.from(join(repo, "web/caf")),
    Buffer.from([0xe9]),
    Buffer.from(".ts"),
  ]);
  writeFileSync(name, "export const cafe = 1;\n");
  git(repo, "add", "--all");
  git(repo, "commit", "--quiet", "-m", "a Latin-1 name");
  const tree = await listTree(repo, rev(repo, "HEAD"));
  expect(tree.map((e) => e.path)).toStrictEqual([
    `web/caf${REPLACEMENT}.ts`,
    "web/src/orbits/orbit.ts",
  ]);
});

it("reads blobs byte for byte, including a 2 MB file and an empty file", async () => {
  // The 2 MB blob first, so the next header arrives inside a chunk the blob began in; each
  // blob in the order asked, a repeated one twice, each handed over only once the last
  // onBlob has finished.
  const big = Uint8Array.from(
    { length: 2 * 1024 * 1024 + 3 },
    (_, i) => (i * 7 + (i >> 9)) & 0xff,
  );
  const files: Record<string, string | Uint8Array> = {
    "data/big.bin": big,
    "web/empty.ts": "",
    "web/crlf.ts": "export const a = 1;\r\nexport const b = 2;\r\n",
    "data/bytes.bin": Uint8Array.from({ length: 256 }, (_, i) => i),
  };
  const repo = await makeRepo({
    commits: [{ date: "2026-03-01T10:00:00Z", files }],
  });
  const order = [
    "data/big.bin",
    "web/empty.ts",
    "data/bytes.bin",
    "data/big.bin",
    "web/crlf.ts",
  ];
  const seen: Array<[string, Uint8Array]> = [];
  let busy = false;
  await readBlobs(
    repo,
    order.map((p) => rev(repo, `HEAD:${p}`)),
    async (sha, bytes) => {
      expect(busy).toBe(false);
      busy = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push([sha, bytes]);
      busy = false;
    },
  );
  expect(seen.map(([sha]) => sha)).toEqual(
    order.map((p) => rev(repo, `HEAD:${p}`)),
  );
  for (const [i, [, bytes]] of seen.entries()) {
    const want = files[order[i] ?? ""] ?? "";
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(bytes).equals(Buffer.from(want))).toBe(true);
  }
});

it("stops git and rejects with onBlob's own error when onBlob throws", async () => {
  const repo = await makeRepo({
    commits: [
      {
        date: "2026-03-01T10:00:00Z",
        files: { "a.ts": "a", "b.ts": "b", "c.ts": "c" },
      },
    ],
  });
  const failure = new Error("the disk is full");
  let calls = 0;
  await expect(
    readBlobs(
      repo,
      ["a.ts", "b.ts", "c.ts"].map((p) => rev(repo, `HEAD:${p}`)),
      async () => {
        calls += 1;
        if (calls === 2) throw failure;
      },
    ),
  ).rejects.toBe(failure);
  expect(calls).toBe(2);
});

it("fails for a blob the repo does not hold, and for an object that is not a blob", async () => {
  const repo = await makeRepo(one());
  const absent = "0123456789abcdef0123456789abcdef01234567";
  await expect(readBlobs(repo, [absent], async () => {})).rejects.toThrow(
    `blob not found: ${absent}`,
  );
  const tree = rev(repo, "HEAD^{tree}");
  await expect(readBlobs(repo, [tree], async () => {})).rejects.toThrow(
    `not a blob: ${tree} is a tree`,
  );
});

it("raises no stray EPIPE when it stops git before git has read all its input", async () => {
  // 5,000 names after the absent one are more than a pipe holds, so git is stopped with
  // input still unwritten; vitest fails the run on the write's unhandled EPIPE.
  const repo = await makeRepo(one());
  const absent = "0123456789abcdef0123456789abcdef01234567";
  const blob = rev(repo, "HEAD:web/src/orbits/orbit.ts");
  await expect(
    readBlobs(repo, [absent, ...Array(5000).fill(blob)], async () => {}),
  ).rejects.toThrow(`blob not found: ${absent}`);
  await new Promise((resolve) => setTimeout(resolve, 200));
});

it("refuses an object name that is not 40 lower-case hex digits before git runs", async () => {
  const repo = await makeRepo(one());
  const sha = rev(repo, "HEAD");
  const out = join(tmp(), "out.txt");
  for (const name of [`--output=${out}`, "HEAD", sha.toUpperCase(), ""]) {
    await expect(listTree(repo, name)).rejects.toThrow(RangeError);
  }
  for (const name of [`${sha}${LF}${sha}`, "HEAD", sha.slice(0, 39)]) {
    await expect(readBlobs(repo, [name], async () => {})).rejects.toThrow(
      RangeError,
    );
  }
  expect(existsSync(out)).toBe(false);
});

it("runs git with only GIT_ENV, a fresh empty HOME it removes afterwards, and this process's PATH", async () => {
  const repo = await makeRepo(one());
  const real = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  const dump = join(tmp(), "calls.jsonl");
  const bin = fakeGit(
    [
      `const fs = require("node:fs");`,
      `const { spawnSync } = require("node:child_process");`,
      `const home = fs.readdirSync(process.env.HOME);`,
      `fs.appendFileSync(${JSON.stringify(dump)}, JSON.stringify({ env: process.env, home }) + "\\n");`,
      `const run = spawnSync(${JSON.stringify(real)}, process.argv.slice(2), { stdio: "inherit" });`,
      `process.exit(run.status === null ? 1 : run.status);`,
    ].join("\n"),
  );
  // A parent's GIT_ variables never reach git.
  const parentGitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = join(tmp(), "elsewhere");
  let answer: Awaited<ReturnType<typeof resolveCommit>>;
  let path: string | undefined;
  try {
    answer = await withPath(bin, () => {
      path = process.env.PATH;
      return resolveCommit(repo, "main");
    });
  } finally {
    if (parentGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = parentGitDir;
  }
  expect(answer.commit).toBe(rev(repo, "HEAD"));
  const calls = readFileSync(dump, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls).toHaveLength(2);
  const homes = new Set<string>();
  for (const { env, home } of calls) {
    const { HOME, PATH, ...rest } = env;
    expect(rest).toEqual(GIT_ENV);
    expect(PATH).toBe(path);
    expect(home).toEqual([]);
    expect(existsSync(HOME)).toBe(false);
    homes.add(HOME);
  }
  expect(homes.size).toBe(2);
});

it("puts the last 4 KiB of git's standard error into its errors", async () => {
  const said = `fatal: the first line\n${"orbit ".repeat(1000)}\nfatal: the last line\n`;
  const bin = fakeGit(
    `require("node:fs").writeSync(2, ${JSON.stringify(said)}); process.exit(3);`,
  );
  const error = await withPath(bin, () =>
    listTree(tmp(), "0123456789abcdef0123456789abcdef01234567"),
  ).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(
    `git ls-tree exited with code 3\n${said.slice(-4096).trimEnd()}`,
  );
});
