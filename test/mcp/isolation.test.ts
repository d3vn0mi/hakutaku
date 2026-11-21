// What hakutaku mcp touches while it answers, read from strace. The built CLI serves the
// observatory sample under strace -f and answers every golden call, then repos, targets and
// globs that name things outside the store: paths, "..", absolute paths, URLs and globs, with a
// canary file outside the store among them. From the initialize answer on, the trace must show
// no process started and no internet socket, and every path the server named must lie in the
// store's directory, the sample checkout's .git, hakutaku's own tree, or /proc, /sys and /dev.
// The canary is never named and never answered. Needs strace that can trace a process (skipped
// without it, failing in CI) and the engines' Python, as the sample does; run `npm run build`
// first.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { removeTree } from "../../src/export/index.js";
import { findEntry, storePathFor } from "../../src/registry/index.js";
import {
  fuzzGlobs,
  fuzzRepos,
  fuzzTargets,
  PATHOLOGICAL_GLOB,
} from "../helpers/fuzz.js";
import { requireInCI } from "../helpers/live.js";
import {
  call,
  goldenReplays,
  needStrace,
  REPO_ROOT,
  readStrace,
  startStdioClient,
  type TraceLine,
} from "../helpers/mcp-client.js";
import { sampleEnv, samplePythonProbe } from "../helpers/sample.js";

const PYTHON = samplePythonProbe();
const TIMEOUT = 600_000;
const REPO = "observatory";
const KEPLER = "web/src/orbits/kepler.ts";
const CANARY = "HAKUTAKU-CANARY-7c1d";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) removeTree(dir);
});

// The store's directory and the sample checkout's .git, as the registry under env names them.
function servedPaths(env: NodeJS.ProcessEnv): {
  storeDir: string;
  gitDir: string;
} {
  vi.stubEnv("XDG_DATA_HOME", env.XDG_DATA_HOME ?? "");
  vi.stubEnv("XDG_CONFIG_HOME", env.XDG_CONFIG_HOME ?? "");
  vi.stubEnv("XDG_CACHE_HOME", env.XDG_CACHE_HOME ?? "");
  try {
    const entry = findEntry(REPO);
    if (entry === null) throw new Error(`${REPO} is not registered`);
    return {
      storeDir: dirname(storePathFor(REPO)),
      gitDir: join(entry.source, ".git"),
    };
  } finally {
    vi.unstubAllEnvs();
  }
}

const under = (path: string, dir: string): boolean =>
  path === dir || path.startsWith(`${dir}/`);

// The calls that look at a path without opening it, as each C library and kernel names them.
const LOOKS = new Set([
  "stat",
  "lstat",
  "stat64",
  "lstat64",
  "newfstatat",
  "fstatat64",
  "statx",
]);

// SQLite resolves a database's path one directory at a time, looking at each with lstat to
// follow links, before it opens the file, and again when it reopens a swapped store. So the
// directories above the store's are looked at, never opened, and nothing else in them.
const looksAbove = (l: TraceLine, path: string, dir: string): boolean =>
  LOOKS.has(l.call) && (path === "/" || dir.startsWith(`${path}/`));

// The lines that break a rule, shown whole when a check fails.
const shown = (lines: TraceLine[]): string[] =>
  lines.slice(0, 20).map((l) => l.text);

it(
  "starts no process, opens no internet socket and names no file outside the store, the checkout's .git and hakutaku's tree, whatever a model passes",
  async (ctx) => {
    needStrace(ctx);
    requireInCI(ctx, PYTHON);
    const { env } = await sampleEnv();
    const { storeDir, gitDir } = servedPaths(env);
    const root = mkdtempSync(join(tmpdir(), "hakutaku-isolation-"));
    made.push(root);
    const canary = join(root, "outside", "secret.txt");
    mkdirSync(dirname(canary));
    writeFileSync(canary, `${CANARY}\n`);
    const log = join(root, "strace.log");

    const session = await startStdioClient({
      args: ["mcp", REPO],
      env,
      straceLog: log,
    });
    const texts: string[] = [];
    let pathologicalMs = Number.POSITIVE_INFINITY;
    try {
      const { client } = session;
      for (const replay of goldenReplays()) {
        texts.push((await call(client, replay.tool, replay.args)).text);
      }
      for (const repo of fuzzRepos(REPO, canary)) {
        texts.push((await call(client, "code_overview", { repo })).text);
      }
      for (const target of fuzzTargets(REPO, canary, KEPLER)) {
        texts.push(
          (await call(client, "code_explain", { repo: REPO, target })).text,
        );
      }
      for (const glob of fuzzGlobs(canary)) {
        const r = await call(client, "code_search_text", {
          repo: REPO,
          text: "import",
          path_glob: glob,
        });
        texts.push(r.text);
        if (glob === PATHOLOGICAL_GLOB) pathologicalMs = r.ms;
      }
    } finally {
      await session.close();
    }

    const lines = readStrace(log, session.t0);
    // the trace was read, and holds the calls the server made: it looks at its store on every call
    expect(lines.length).toBeGreaterThan(0);
    expect(
      lines.some((l) => l.path !== undefined && under(l.path, storeDir)),
    ).toBe(true);

    // no process started, and no internet socket opened or connected
    const started = lines.filter(
      (l) => l.call === "execve" || l.call === "execveat",
    );
    expect(shown(started)).toEqual([]);
    const sockets = lines.filter(
      (l) =>
        /socket\(AF_INET6?\b/.test(l.text) ||
        (l.text.includes("connect(") && l.text.includes("sa_family=AF_INET")),
    );
    expect(shown(sockets)).toEqual([]);

    // nothing a model passed was looked up as a file
    const named = lines.filter((l) =>
      [canary, "/etc/passwd", "id_rsa"].some((s) => l.text.includes(s)),
    );
    expect(shown(named)).toEqual([]);
    // every path lies in the store's directory, the checkout's .git, hakutaku's tree (the modules
    // node loads on first use), or /proc, /sys and /dev, or is a directory above the store's that
    // SQLite looks at, once its "." and ".." are taken out; an empty path names a descriptor. A
    // relative path is outside: it is read from the server's working directory, which its client
    // chooses, often the user's own project
    const root0 = resolve(REPO_ROOT);
    const outside = lines.filter((l) => {
      if (l.path === undefined || l.path === "") return false;
      if (!isAbsolute(l.path)) return true;
      const path = resolve(l.path);
      return !(
        under(path, storeDir) ||
        under(path, gitDir) ||
        under(path, root0) ||
        ["/proc/", "/sys/", "/dev/"].some((p) => path.startsWith(p)) ||
        looksAbove(l, path, storeDir)
      );
    });
    expect(shown(outside)).toEqual([]);

    // no answer holds the canary's text
    expect(texts.filter((t) => t.includes(CANARY))).toEqual([]);
    // the glob a backtracking matcher takes exponential time on answers at once
    expect(pathologicalMs).toBeLessThan(1000);
  },
  TIMEOUT,
);
