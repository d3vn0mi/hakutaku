import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import * as build from "../../../src/build.js";
import {
  type ExportManifest,
  type ExportOptions,
  exportRepo,
  type History,
  ProfileConflictError,
  removeTree,
} from "../../../src/export/index.js";
import { comparePaths } from "../../../src/model/index.js";
import {
  DEFAULT_PROFILE,
  generateProfile,
  type Profile,
  ProfileError,
} from "../../../src/profile/index.js";
import { HAKUTAKU_VERSION } from "../../../src/version.js";
import { git, makeRepo, type RepoSpec } from "../../helpers/git.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) removeTree(dir);
});

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-export-"));
  made.push(dir);
  return dir;
};

// Control characters and U+FFFD are built from their codes, so this file holds none raw.
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const REPLACEMENT = String.fromCharCode(0xfffd);

const DATE = "2026-03-01T10:00:00Z";
const TIME = Date.parse(DATE) / 1000;

type Files = RepoSpec["commits"][number]["files"];
const repoWith = (files: Files): Promise<string> =>
  makeRepo({ commits: [{ date: DATE, files }] });

const rev = (repo: string, name: string): string =>
  git(repo, "rev-parse", name);

const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(path, "utf8")) as T;

// Exports HEAD into a fresh directory that does not exist yet.
async function exported(repo: string, extra: Partial<ExportOptions> = {}) {
  const out = join(tmp(), "out");
  const result = await exportRepo({ repo, ref: "HEAD", out, ...extra });
  return {
    out,
    result,
    manifest: readJson<ExportManifest>(join(out, "export.json")),
  };
}

const failure = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (error: unknown) => error,
  );

// Every entry under dir, relative to it, with its kind and permission bits, in path order.
function onDisk(dir: string): Array<[string, string, number]> {
  const found: Array<[string, string, number]> = [];
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(dir, rel))) {
      const path = rel === "" ? name : `${rel}/${name}`;
      const stats = lstatSync(join(dir, path));
      const kind = stats.isDirectory()
        ? "dir"
        : stats.isFile()
          ? "file"
          : "other";
      found.push([path, kind, stats.mode & 0o777]);
      if (stats.isDirectory()) walk(path);
    }
  };
  walk("");
  return found.sort((a, b) => comparePaths(a[0], b[0]));
}

const filesOnDisk = (dir: string): string[] =>
  onDisk(dir)
    .filter(([, kind]) => kind !== "dir")
    .map(([path]) => path);

const treeRow = (repo: string, path: string, text: string) => ({
  path,
  mode: "100644",
  blob: rev(repo, `HEAD:${path}`),
  bytes: Buffer.byteLength(text),
});

const profileJson = (profile: Profile): string =>
  `${JSON.stringify(profile, null, 2)}\n`;

const freshProfile = (): Profile => structuredClone(DEFAULT_PROFILE) as Profile;

it("writes tracked regular files read-only and nothing else", async () => {
  const files = {
    "web/src/orbits/orbit.ts": "export const period = 1;\n",
    "sim/src/observatory/sky.py": "SKY = 1\n",
    "README.md": "# Observatory\n",
  };
  const script = "#!/bin/sh\necho sky\n";
  const repo = await repoWith({
    ...files,
    "scripts/sync.sh": { mode: "100755", text: script },
  });
  writeFileSync(join(repo, "notes.txt"), "untracked\n");
  writeFileSync(join(repo, "web/src/draft.ts"), "untracked\n");
  // The modes are 0444 and 0555 whatever the umask.
  const umask = process.umask(0o077);
  let done: Awaited<ReturnType<typeof exported>>;
  try {
    done = await exported(repo, { id: "observatory" });
  } finally {
    process.umask(umask);
  }
  const { out, result, manifest } = done;
  const snapshot = join(out, "snapshot");
  expect(lstatSync(snapshot).mode & 0o777).toBe(0o555);
  expect(onDisk(snapshot)).toEqual([
    ["README.md", "file", 0o444],
    ["scripts", "dir", 0o555],
    ["scripts/sync.sh", "file", 0o444],
    ["sim", "dir", 0o555],
    ["sim/src", "dir", 0o555],
    ["sim/src/observatory", "dir", 0o555],
    ["sim/src/observatory/sky.py", "file", 0o444],
    ["web", "dir", 0o555],
    ["web/src", "dir", 0o555],
    ["web/src/orbits", "dir", 0o555],
    ["web/src/orbits/orbit.ts", "file", 0o444],
  ]);
  for (const [path, text] of Object.entries({
    ...files,
    "scripts/sync.sh": script,
  })) {
    expect(readFileSync(join(snapshot, path), "utf8")).toBe(text);
  }
  expect(readdirSync(out).sort()).toEqual([
    "ast-grep",
    "depcruise.json",
    "empty-env.json",
    "export.json",
    "history.json",
    "profile.json",
    "pyrightconfig.json",
    "sgconfig.yml",
    "snapshot",
    "tsconfig.json",
  ]);
  const head = rev(repo, "HEAD");
  expect(manifest).toStrictEqual({
    formatVersion: 1,
    id: "observatory",
    commit: head,
    commitTime: TIME,
    ref: "HEAD",
    hakutakuVersion: HAKUTAKU_VERSION,
    files: 4,
    denied: 0,
    engineConfigsRemoved: [],
    symlinks: [],
    submodules: [],
    refused: [],
    metadataOnly: [],
    tree: [
      treeRow(repo, "README.md", files["README.md"]),
      { ...treeRow(repo, "scripts/sync.sh", script), mode: "100755" },
      treeRow(
        repo,
        "sim/src/observatory/sky.py",
        files["sim/src/observatory/sky.py"],
      ),
      treeRow(
        repo,
        "web/src/orbits/orbit.ts",
        files["web/src/orbits/orbit.ts"],
      ),
    ],
  });
  expect(result).toStrictEqual({
    id: "observatory",
    commit: head,
    commitTime: TIME,
    ref: "HEAD",
    files: 4,
    denied: 0,
    out,
  });
  expect(readJson<History>(join(out, "history.json"))).toStrictEqual({
    commit: head,
    commitTime: TIME,
    windowSeconds: 15724800,
    commits: [
      {
        sha: head,
        time: TIME,
        files: [
          "README.md",
          "scripts/sync.sh",
          "sim/src/observatory/sky.py",
          "web/src/orbits/orbit.ts",
        ],
        renames: [],
      },
    ],
  });
  // No package.json, tsconfig or __init__.py: the generated profile is the default one.
  expect(readFileSync(join(out, "profile.json"), "utf8")).toBe(
    profileJson(freshProfile()),
  );
});

it("leaves out denylisted files and counts them", async () => {
  const repo = await repoWith({
    "sim/.env": "SKY_MODE=night\n",
    "secrets/x.txt": "x\n",
    "deploy/site.pem": "pem\n",
    "web/src/a.ts": "export {};\n",
  });
  const { out, result, manifest } = await exported(repo);
  expect(result.denied).toBe(3);
  expect(manifest.denied).toBe(3);
  expect(manifest.files).toBe(1);
  expect(manifest.tree.map((e) => e.path)).toEqual(["web/src/a.ts"]);
  expect(filesOnDisk(join(out, "snapshot"))).toEqual(["web/src/a.ts"]);
});

it("applies the given profile's extra denylist globs as well", async () => {
  const repo = await repoWith({
    "sim/.env": "SKY_MODE=night\n",
    "web/sky.secret.json": "{}\n",
    "web/src/a.ts": "export {};\n",
  });
  const profile = freshProfile();
  profile.denylist.extra = ["*.secret.json"];
  const file = join(tmp(), "profile.json");
  writeFileSync(file, profileJson(profile));
  const { out, manifest } = await exported(repo, { profile: file });
  expect(manifest.denied).toBe(2);
  expect(manifest.tree.map((e) => e.path)).toEqual(["web/src/a.ts"]);
  expect(filesOnDisk(join(out, "snapshot"))).toEqual(["web/src/a.ts"]);
});

it("removes engine configs and lists them", async () => {
  const repo = await repoWith({
    ".dependency-cruiser.js": "module.exports = {};\n",
    "web/sgconfig.yml": "ruleDirs: [rules]\n",
    "pyrightconfig.json": "{}\n",
    "babel.config.js": "module.exports = {};\n",
    "web/src/a.ts": "export {};\n",
  });
  const { out, manifest } = await exported(repo);
  expect(manifest.engineConfigsRemoved).toEqual([
    ".dependency-cruiser.js",
    "babel.config.js",
    "pyrightconfig.json",
    "web/sgconfig.yml",
  ]);
  expect(manifest.tree.map((e) => e.path)).toEqual(["web/src/a.ts"]);
  expect(manifest.files).toBe(1);
  expect(manifest.denied).toBe(0);
  expect(filesOnDisk(join(out, "snapshot"))).toEqual(["web/src/a.ts"]);
  // The sgconfig.yml beside the snapshot is hakutaku's own.
  expect(readFileSync(join(out, "sgconfig.yml"), "utf8")).toMatch(
    /^ruleDirs:\n {2}- ast-grep\/rules\n/,
  );
});

it("records a symlink with its target and never creates it", async () => {
  const repo = await repoWith({
    "web/link.ts": { link: "../outside.txt" },
    "web/src/a.ts": "export {};\n",
  });
  const { out, manifest } = await exported(repo);
  expect(manifest.symlinks).toEqual([
    { path: "web/link.ts", target: "../outside.txt" },
  ]);
  let code: unknown;
  try {
    lstatSync(join(out, "snapshot/web/link.ts"));
  } catch (error) {
    code = (error as NodeJS.ErrnoException).code;
  }
  expect(code).toBe("ENOENT");
  expect(manifest.tree).toStrictEqual([
    {
      path: "web/link.ts",
      mode: "120000",
      blob: rev(repo, "HEAD:web/link.ts"),
      bytes: 14,
    },
    treeRow(repo, "web/src/a.ts", "export {};\n"),
  ]);
  expect(manifest.files).toBe(2);
  expect(filesOnDisk(join(out, "snapshot"))).toEqual(["web/src/a.ts"]);
});

it("records a submodule with its commit", async () => {
  const repo = await repoWith({ "web/src/a.ts": "export {};\n" });
  const lib = rev(repo, "HEAD");
  git(repo, "update-index", "--add", "--cacheinfo", `160000,${lib},vendor/lib`);
  git(repo, "commit", "--quiet", "-m", "vendor lib");
  const { out, manifest } = await exported(repo);
  expect(manifest.submodules).toEqual([{ path: "vendor/lib", commit: lib }]);
  expect(manifest.tree).toStrictEqual([
    { path: "vendor/lib", mode: "160000", blob: lib, bytes: 0 },
    treeRow(repo, "web/src/a.ts", "export {};\n"),
  ]);
  expect(existsSync(join(out, "snapshot/vendor"))).toBe(false);
  expect(manifest.files).toBe(2);
});

it("exports odd names exactly", async () => {
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
  const control = [`sky${TAB}map.ts`, `sky${LF}map.ts`];
  const repo = await repoWith(
    Object.fromEntries([...names, ...control].map((n) => [n, n])),
  );
  const { out, manifest } = await exported(repo);
  const sorted = [...names].sort(comparePaths);
  expect(manifest.tree.map((e) => e.path)).toEqual(sorted);
  expect(filesOnDisk(join(out, "snapshot"))).toEqual(sorted);
  for (const name of names) {
    expect(readFileSync(join(out, "snapshot", name), "utf8")).toBe(name);
  }
  expect(manifest.refused).toEqual([
    { path: `sky${TAB}map.ts`, reason: "control-char" },
    { path: `sky${LF}map.ts`, reason: "control-char" },
  ]);
});

// git without a work tree's help: an object written from `input`.
function gitInput(repo: string, input: string, ...args: string[]): string {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && key !== "XDG_CONFIG_HOME") env[key] = value;
  }
  return execFileSync("git", args, {
    cwd: repo,
    input,
    encoding: "utf8",
    env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
}

it("refuses a path holding .., and writes nothing outside snapshot/", async () => {
  const repo = await repoWith({ "web/src/a.ts": "export {};\n" });
  const blob = rev(repo, "HEAD:web/src/a.ts");
  const sub = gitInput(repo, `100644 blob ${blob}${TAB}x\n`, "mktree");
  const web = rev(repo, "HEAD:web");
  const root = gitInput(
    repo,
    `040000 tree ${sub}${TAB}..\n040000 tree ${web}${TAB}web\n`,
    "mktree",
  );
  const commit = git(repo, "commit-tree", root, "-m", "a crafted tree");
  const parent = tmp();
  const out = join(parent, "out");
  const result = await exportRepo({ repo, ref: commit, out });
  const manifest = readJson<ExportManifest>(join(out, "export.json"));
  expect(manifest.refused).toEqual([{ path: "../x", reason: "dotdot" }]);
  expect(manifest.tree.map((e) => e.path)).toEqual(["web/src/a.ts"]);
  expect(result.files).toBe(1);
  expect(readdirSync(parent)).toEqual(["out"]);
  expect(existsSync(join(out, "x"))).toBe(false);
  expect(filesOnDisk(join(out, "snapshot"))).toEqual(["web/src/a.ts"]);
});

it("refuses a path holding a .git component, so no git directory is planted in snapshot/", async () => {
  // A crafted tree: a .git tree under web/ whose config names a core.fsmonitor command, and a
  // .git blob at the top that points git elsewhere. git refuses both on checkout.
  const repo = await repoWith({ "web/src/a.ts": "export {};\n" });
  const NUL = String.fromCharCode(0);
  const blob = (text: string): string => {
    const file = join(tmp(), "blob");
    writeFileSync(file, text);
    return git(repo, "hash-object", "-w", file);
  };
  // mktree, or the tree object written by hand when a newer git's mktree refuses the name.
  const tree = (entries: Array<[string, string, string]>): string => {
    const sorted = [...entries].sort((a, b) =>
      Buffer.compare(
        Buffer.from(a[0] === "040000" ? `${a[2]}/` : a[2]),
        Buffer.from(b[0] === "040000" ? `${b[2]}/` : b[2]),
      ),
    );
    try {
      return gitInput(
        repo,
        sorted
          .map(
            ([m, s, n]) =>
              `${m} ${m === "040000" ? "tree" : "blob"} ${s}${TAB}${n}${NUL}`,
          )
          .join(""),
        "mktree",
        "-z",
      );
    } catch {
      const file = join(tmp(), "tree");
      writeFileSync(
        file,
        Buffer.concat(
          sorted.map(([m, s, n]) =>
            Buffer.concat([
              Buffer.from(`${m === "040000" ? "40000" : m} ${n}${NUL}`),
              Buffer.from(s, "hex"),
            ]),
          ),
        ),
      );
      return git(repo, "hash-object", "-t", "tree", "-w", "--literally", file);
    }
  };
  const empty = tree([["100644", blob(""), "keep"]]);
  const dotGit = tree([
    ["100644", blob("[core]\n\tfsmonitor = false\n"), "config"],
    ["100644", blob("ref: refs/heads/main\n"), "HEAD"],
    ["040000", empty, "objects"],
    ["040000", empty, "refs"],
  ]);
  const src = rev(repo, "HEAD:web/src");
  const web = tree([
    ["040000", dotGit, ".GIT"],
    ["040000", dotGit, ".git"],
    ["040000", src, "src"],
  ]);
  const root = tree([
    ["100644", blob("gitdir: /nonexistent\n"), ".git"],
    ["040000", web, "web"],
  ]);
  const commit = git(repo, "commit-tree", root, "-m", "a crafted tree");
  const out = join(tmp(), "out");
  await exportRepo({ repo, ref: commit, out });
  const manifest = readJson<ExportManifest>(join(out, "export.json"));
  const inside = ["HEAD", "config", "objects/keep", "refs/keep"];
  expect(manifest.refused).toEqual([
    { path: ".git", reason: "dotgit" },
    ...inside.map((p) => ({ path: `web/.GIT/${p}`, reason: "dotgit" })),
    ...inside.map((p) => ({ path: `web/.git/${p}`, reason: "dotgit" })),
  ]);
  expect(manifest.tree.map((e) => e.path)).toEqual(["web/src/a.ts"]);
  expect(onDisk(join(out, "snapshot"))).toEqual([
    ["web", "dir", 0o555],
    ["web/src", "dir", 0o555],
    ["web/src/a.ts", "file", 0o444],
  ]);
});

it("refuses a second path that a case-insensitive file system cannot hold beside the first", async () => {
  const precomposed = `${String.fromCharCode(0xe9)}toile.ts`;
  const decomposed = `e${String.fromCharCode(0x301)}toile.ts`;
  const repo = await repoWith({
    "README.md": "upper\n",
    "Readme.md": "mixed\n",
    "SKY/a.ts": "a\n",
    sky: "a file\n",
    Map: "a file\n",
    "map/b.ts": "b\n",
    [precomposed]: "precomposed\n",
    [decomposed]: "decomposed\n",
    "web/src/a.ts": "export {};\n",
  });
  // Two names that are not UTF-8, which both read web/caf<U+FFFD>.ts.
  for (const [byte, text] of [
    [0xe8, "e8\n"],
    [0xe9, "e9\n"],
  ] as const) {
    const name = Buffer.concat([
      Buffer.from(join(repo, "web/caf")),
      Buffer.from([byte]),
      Buffer.from(".ts"),
    ]);
    writeFileSync(name, text);
  }
  git(repo, "add", "--all");
  git(repo, "commit", "--quiet", "-m", "Latin-1 names");
  const { out, manifest } = await exported(repo);
  const cafe = `web/caf${REPLACEMENT}.ts`;
  // A file under a directory a file holds (map/b.ts after Map), and a file a directory holds
  // (sky after SKY/), as well as the same name in another case or composition.
  expect(manifest.refused).toEqual([
    { path: "Readme.md", reason: "collision" },
    { path: "map/b.ts", reason: "collision" },
    { path: "sky", reason: "collision" },
    { path: cafe, reason: "collision" },
    { path: precomposed, reason: "collision" },
  ]);
  const kept = [
    "Map",
    "README.md",
    "SKY/a.ts",
    decomposed,
    cafe,
    "web/src/a.ts",
  ];
  expect(manifest.tree.map((e) => e.path)).toEqual(kept);
  expect(manifest.files).toBe(6);
  expect(filesOnDisk(join(out, "snapshot"))).toEqual(kept);
  expect(readFileSync(join(out, "snapshot/README.md"), "utf8")).toBe("upper\n");
  // git lists the names in byte order, so the 0xe8 name came first and was kept.
  expect(readFileSync(join(out, "snapshot", cafe), "utf8")).toBe("e8\n");
  expect(readFileSync(join(out, "snapshot", decomposed), "utf8")).toBe(
    "decomposed\n",
  );
});

it("refuses a path the file system already holds as a collision, found while writing", async () => {
  // A crafted tree whose "." entry lists ./x and ./y, which the file system writes at x and y.
  const repo = await repoWith({ "web/src/a.ts": "export {};\n" });
  const blob = (text: string): string => {
    const file = join(tmp(), "blob");
    writeFileSync(file, text);
    return git(repo, "hash-object", "-w", file);
  };
  const NUL = String.fromCharCode(0);
  const tree = (entries: string[]): string =>
    gitInput(repo, entries.map((e) => `${e}${NUL}`).join(""), "mktree", "-z");
  const dot = tree([
    `100644 blob ${blob("dot x\n")}${TAB}x`,
    `100644 blob ${blob("dot y\n")}${TAB}y`,
  ]);
  const y = tree([`100644 blob ${blob("y z\n")}${TAB}z`]);
  const root = tree([
    `040000 tree ${dot}${TAB}.`,
    `100644 blob ${blob("plain x\n")}${TAB}x`,
    `040000 tree ${y}${TAB}y`,
    `100644 blob ${blob("tab\n")}${TAB}z${TAB}z`,
  ]);
  const commit = git(repo, "commit-tree", root, "-m", "a crafted tree");
  const out = join(tmp(), "out");
  await exportRepo({ repo, ref: commit, out });
  const manifest = readJson<ExportManifest>(join(out, "export.json"));
  // In path order, though the control character was refused before the writing began.
  expect(manifest.refused).toEqual([
    { path: "x", reason: "collision" },
    { path: "y/z", reason: "collision" },
    { path: `z${TAB}z`, reason: "control-char" },
  ]);
  expect(manifest.tree.map((e) => e.path)).toEqual(["./x", "./y"]);
  expect(manifest.files).toBe(2);
  expect(filesOnDisk(join(out, "snapshot"))).toEqual(["x", "y"]);
  expect(readFileSync(join(out, "snapshot/x"), "utf8")).toBe("dot x\n");
  expect(readFileSync(join(out, "snapshot/y"), "utf8")).toBe("dot y\n");
});

it("marks oversized, minified and generated files metadata-only", async () => {
  const big = `${"// the sky is large\n".repeat(52429)}`; // 1,048,580 bytes
  const bundle = `${"x".repeat(12000)}\n`;
  const repo = await repoWith({
    "web/big.js": big,
    "web/app.min.js": "x\n",
    "web/bundle.js": bundle,
    "web/gen.ts": "// Code generated by sky-gen. DO NOT EDIT.\nexport {};\n",
    "web/ok.ts": "export {};\n",
  });
  const { out, manifest } = await exported(repo);
  const metadataOnly = [
    { path: "web/app.min.js", reason: "minified" },
    { path: "web/big.js", reason: "size" },
    { path: "web/bundle.js", reason: "minified" },
    { path: "web/gen.ts", reason: "generated" },
  ];
  expect(manifest.metadataOnly).toEqual(metadataOnly);
  // They stay in the snapshot and the tree, whole: extract reads their metadata.
  expect(manifest.tree.map((e) => e.path)).toEqual([
    "web/app.min.js",
    "web/big.js",
    "web/bundle.js",
    "web/gen.ts",
    "web/ok.ts",
  ]);
  expect(readFileSync(join(out, "snapshot/web/big.js"), "utf8")).toBe(big);
  expect(manifest.tree[1]?.bytes).toBe(Buffer.byteLength(big));
  // And out of every engine's input.
  const paths = metadataOnly.map((m) => m.path);
  expect(
    readJson<{ exclude: string[] }>(join(out, "tsconfig.json")).exclude,
  ).toEqual(paths.map((p) => `snapshot/${p}`));
  expect(
    readJson<{ options: { exclude: unknown } }>(join(out, "depcruise.json"))
      .options.exclude,
  ).toEqual({
    path: "^(web/app\\.min\\.js|web/big\\.js|web/bundle\\.js|web/gen\\.ts)$",
  });
});

it("fails with too many files when maxFiles is exceeded", async () => {
  const repo = await repoWith({
    "web/a.ts": "a\n",
    "web/b.ts": "b\n",
    "web/c.ts": "c\n",
  });
  const out = join(tmp(), "out");
  const error = await failure(
    exportRepo({ repo, ref: "HEAD", out, maxFiles: 2 }),
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("too many files: 3 > 2");
  expect(existsSync(out)).toBe(false);
  const { manifest } = await exported(repo, { maxFiles: 3 });
  expect(manifest.files).toBe(3);
});

it("refuses an out directory that is not empty", async () => {
  const repo = await repoWith({ "web/a.ts": "a\n" });
  const out = tmp();
  writeFileSync(join(out, "keep.txt"), "keep\n");
  const error = await failure(exportRepo({ repo, ref: "HEAD", out }));
  expect((error as Error).message).toBe("the out directory is not empty");
  expect(readdirSync(out)).toEqual(["keep.txt"]);
  const file = join(tmp(), "out");
  writeFileSync(file, "a file\n");
  const notDir = await failure(exportRepo({ repo, ref: "HEAD", out: file }));
  expect((notDir as Error).message).toBe(
    "the out directory is not a directory",
  );
  // An empty one is used as it is.
  const empty = tmp();
  await exportRepo({ repo, ref: "HEAD", out: empty });
  expect(existsSync(join(empty, "export.json"))).toBe(true);
});

it("refuses a folder that is not a checkout's top level or a bare repo", async () => {
  const repo = await repoWith({ "web/src/a.ts": "export {};\n" });
  // Inside the checkout: a folder, one with an empty .git/, and one with HEAD and objects/ but
  // no refs/, none of which git takes as a repo, so git -C would walk up to the checkout.
  const empty = join(repo, "web/empty");
  mkdirSync(join(empty, ".git"), { recursive: true });
  const fake = join(repo, "web/fake");
  mkdirSync(join(fake, "objects"), { recursive: true });
  writeFileSync(join(fake, "HEAD"), "ref: refs/heads/main\n");
  for (const path of [join(repo, "web"), empty, fake, tmp()]) {
    const out = join(tmp(), "out");
    const error = await failure(exportRepo({ repo: path, ref: "HEAD", out }));
    expect((error as Error).message).toBe(
      "not a checkout's top level or a bare repo",
    );
    expect(existsSync(out)).toBe(false);
  }
});

it("exports a bare repo", async () => {
  const repo = await repoWith({ "web/src/a.ts": "export {};\n" });
  const bare = join(tmp(), "observatory.git");
  git(dirname(bare), "clone", "--quiet", "--bare", repo, bare);
  const { result, manifest } = await exported(bare);
  expect(result.id).toBe("observatory.git");
  expect(manifest.commit).toBe(rev(repo, "HEAD"));
  expect(manifest.tree.map((e) => e.path)).toEqual(["web/src/a.ts"]);
});

it("derives the default id from the folder name", async () => {
  const repo = await repoWith({ "web/src/a.ts": "export {};\n" });
  const checkout = join(tmp(), "Observatory Sky");
  git(dirname(checkout), "clone", "--quiet", repo, checkout);
  const { result, manifest } = await exported(checkout);
  expect(result.id).toBe("observatory-sky");
  expect(manifest.id).toBe("observatory-sky");
  const given = await exported(checkout, { id: "sky-map" });
  expect(given.manifest.id).toBe("sky-map");
  for (const [id, message] of [
    ["Sky", 'not a valid repo id: "Sky"'],
    ["../sky", 'not a valid repo id: "../sky"'],
  ]) {
    const out = join(tmp(), "out");
    const error = await failure(
      exportRepo({ repo: checkout, ref: "HEAD", out, id }),
    );
    expect((error as Error).message).toBe(message);
    expect(existsSync(out)).toBe(false);
  }
  const odd = join(tmp(), "_sky");
  git(dirname(odd), "clone", "--quiet", repo, odd);
  const error = await failure(
    exportRepo({ repo: odd, ref: "HEAD", out: join(tmp(), "out") }),
  );
  expect((error as Error).message).toBe(
    'the folder name gives no valid repo id ("_sky")',
  );
});

const RULES_TEXT =
  '{ "schema": 1,\r\n  "forbidden": [ { "name": "no-sim-from-web", "severity": "error",\r\n' +
  '    "from": { "path": "^web/" }, "to": { "path": "^sim/" } } ] }';

it("copies --profile and --rules byte for byte, and generates a profile without one", async () => {
  const repo = await repoWith({
    "web/package.json": '{ "name": "@obs/web", "main": "src/index.ts" }\n',
    "web/src/index.ts": "export const sky = 1;\n",
    "sim/src/observatory/__init__.py": "",
  });
  const dir = tmp();
  const profile = freshProfile();
  profile.typescript.aliases = { "@obs/web": ["web/src/index.ts"] };
  // Compact JSON, no final line feed: copied as it is, never rewritten.
  const profileText = JSON.stringify(profile);
  writeFileSync(join(dir, "sky profile.json"), profileText);
  writeFileSync(join(dir, "sky rules.json"), RULES_TEXT);
  const given = await exported(repo, {
    profile: join(dir, "sky profile.json"),
    rules: join(dir, "sky rules.json"),
  });
  expect(readFileSync(join(given.out, "profile.json"))).toEqual(
    Buffer.from(profileText),
  );
  expect(readFileSync(join(given.out, "rules.json"))).toEqual(
    Buffer.from(RULES_TEXT),
  );
  const depcruise = readJson<{ forbidden: Array<{ name: string }> }>(
    join(given.out, "depcruise.json"),
  );
  expect(depcruise.forbidden.map((r) => r.name)).toEqual([
    "no-sim-from-web",
    "hakutaku-cycle",
  ]);
  expect(
    readJson<{ compilerOptions: { paths: unknown } }>(
      join(given.out, "tsconfig.json"),
    ).compilerOptions.paths,
  ).toEqual({ "@obs/web": ["web/src/index.ts"] });

  const generated = await exported(repo);
  const g = await generateProfile(join(generated.out, "snapshot"));
  expect(g.profile.typescript.aliases).toEqual({
    "@obs/web": ["web/src/index.ts"],
    "@obs/web/*": ["web/src/*"],
  });
  expect(g.profile.python.roots).toEqual(["sim/src"]);
  expect(readFileSync(join(generated.out, "profile.json"), "utf8")).toBe(
    profileJson(g.profile),
  );
  expect(existsSync(join(generated.out, "rules.json"))).toBe(false);
  expect(
    readJson<{ compilerOptions: { paths: unknown } }>(
      join(generated.out, "tsconfig.json"),
    ).compilerOptions.paths,
  ).toEqual(g.profile.typescript.aliases);
});

it("takes the rules file the profile names, relative to the profile file, unless --rules names one", async () => {
  const repo = await repoWith({ "web/src/a.ts": "export {};\n" });
  const dir = tmp();
  mkdirSync(join(dir, "profiles"));
  mkdirSync(join(dir, "rules"));
  const profile = freshProfile();
  profile.rules = "../rules/sky.json";
  writeFileSync(join(dir, "profiles/sky.json"), profileJson(profile));
  writeFileSync(join(dir, "rules/sky.json"), RULES_TEXT);
  const named = await exported(repo, {
    profile: join(dir, "profiles/sky.json"),
  });
  expect(readFileSync(join(named.out, "rules.json"), "utf8")).toBe(RULES_TEXT);
  const other = '{ "schema": 1 }\n';
  writeFileSync(join(dir, "other.json"), other);
  const given = await exported(repo, {
    profile: join(dir, "profiles/sky.json"),
    rules: join(dir, "other.json"),
  });
  expect(readFileSync(join(given.out, "rules.json"), "utf8")).toBe(other);
  const plain = await exported(repo, { rules: join(dir, "other.json") });
  expect(readFileSync(join(plain.out, "rules.json"), "utf8")).toBe(other);
});

it("refuses a profile or rules file that does not load, naming the field", async () => {
  const repo = await repoWith({ "web/src/a.ts": "export {};\n" });
  const dir = tmp();
  writeFileSync(join(dir, "bad.json"), '{ "schema": 1, "sky": true }');
  const out = join(tmp(), "out");
  const error = await failure(
    exportRepo({ repo, ref: "HEAD", out, profile: join(dir, "bad.json") }),
  );
  expect(error).toBeInstanceOf(ProfileError);
  expect((error as Error).message).toBe("profile.sky: unknown field");
  expect(existsSync(out)).toBe(false);
  const missing = await failure(
    exportRepo({ repo, ref: "HEAD", out, rules: join(dir, "none.json") }),
  );
  expect((missing as Error).message).toBe(
    "rules: cannot read the file (ENOENT)",
  );
  expect(existsSync(out)).toBe(false);
  const notFile = await failure(
    exportRepo({ repo, ref: "HEAD", out, profile: dir }),
  );
  expect((notFile as Error).message).toBe("profile: not a regular file");
  // A FIFO with no writer would block a plain open forever.
  const fifo = join(dir, "fifo.json");
  execFileSync("mkfifo", [fifo]);
  for (const field of ["profile", "rules"] as const) {
    const blocked = await failure(
      exportRepo({ repo, ref: "HEAD", out, [field]: fifo }),
    );
    expect((blocked as Error).message).toBe(`${field}: not a regular file`);
    expect(existsSync(out)).toBe(false);
  }
});

const CONFLICTED = {
  "a/package.json": '{ "name": "@obs/core", "main": "src/index.ts" }',
  "a/src/index.ts": "",
  "b/package.json": '{ "name": "@obs/core", "main": "src/index.ts" }',
  "b/src/index.ts": "",
};

it("throws ProfileConflictError when the generated profile has conflicts", async () => {
  const repo = await repoWith(CONFLICTED);
  const out = join(tmp(), "out");
  const error = await failure(exportRepo({ repo, ref: "HEAD", out }));
  expect(error).toBeInstanceOf(ProfileConflictError);
  const conflict = error as ProfileConflictError;
  const conflicts = [
    'two packages export "@obs/core": a/src/index.ts and b/src/index.ts; name one in the profile',
    'two packages export "@obs/core/*": a/src/* and b/src/*; name one in the profile',
  ];
  expect(conflict.conflicts).toEqual(conflicts);
  expect(conflict.message).toBe(
    `the generated profile has conflicts:\n${conflicts.join("\n")}`,
  );
  // found is the generator's own, over the same files.
  const same = tmp();
  for (const [path, text] of Object.entries(CONFLICTED)) {
    mkdirSync(dirname(join(same, path)), { recursive: true });
    writeFileSync(join(same, path), text);
  }
  expect(conflict.found).toEqual((await generateProfile(same)).found);
  // A given profile names the alias, and the same repo exports.
  const profile = freshProfile();
  profile.typescript.aliases = { "@obs/core": ["a/src/index.ts"] };
  const file = join(tmp(), "profile.json");
  writeFileSync(file, profileJson(profile));
  const { manifest } = await exported(repo, { profile: file });
  expect(manifest.files).toBe(4);
});

it("removes what it wrote when it fails, and keeps an out directory it did not make", async () => {
  const repo = await repoWith(CONFLICTED);
  const out = join(tmp(), "deep/out");
  expect(await failure(exportRepo({ repo, ref: "HEAD", out }))).toBeInstanceOf(
    ProfileConflictError,
  );
  expect(existsSync(out)).toBe(false);
  const empty = tmp();
  expect(
    await failure(exportRepo({ repo, ref: "HEAD", out: empty })),
  ).toBeInstanceOf(ProfileConflictError);
  expect(readdirSync(empty)).toEqual([]);
  const missing = await failure(
    exportRepo({ repo, ref: "nebula", out: join(tmp(), "out") }),
  );
  expect((missing as Error).message).toBe("ref not found: nebula");
});

it("exports a shallow clone", async () => {
  const full = await makeRepo({
    commits: [
      { date: "2026-01-01T10:00:00Z", files: { "web/a.ts": "1\n" } },
      { date: "2026-02-01T10:00:00Z", files: { "web/a.ts": "2\n" } },
      { date: DATE, files: { "web/b.ts": "3\n" } },
    ],
  });
  const shallow = join(tmp(), "shallow");
  git(
    dirname(shallow),
    "clone",
    "--quiet",
    "--depth",
    "1",
    `file://${full}`,
    shallow,
  );
  const { out, manifest } = await exported(shallow);
  const head = rev(full, "HEAD");
  expect(manifest.commit).toBe(head);
  expect(manifest.tree.map((e) => e.path)).toEqual(["web/a.ts", "web/b.ts"]);
  const history = readJson<History>(join(out, "history.json"));
  expect(history.commits).toStrictEqual([
    { sha: head, time: TIME, files: ["web/a.ts", "web/b.ts"], renames: [] },
  ]);
});

it("is exported by ./build", () => {
  expect(typeof build.exportRepo).toBe("function");
});
