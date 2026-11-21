// Builds that die part-way. Each case builds the sample's HEAD~1 into a fresh store directory,
// then runs test/helpers/extract-child.mjs on an export of HEAD: it takes the build lock, under
// XDG directories of its own, and kills its whole process group at one stage. What the dead
// build left must explain it: the previous store still serves, the last attempt names the
// build's pid and stage, and its temporary files and its lock are still there. The next build
// must then clear them and build. The child runs dist/, so run `npm run build` first, and
// `node dist/cli/main.js engines install --yes` once. Every build is checked engine by engine,
// so each case needs the Python the engines were installed with: where it does not start, the
// cases are skipped, and in CI they fail.
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { defaultEnginesDir } from "../../../src/engines/index.js";
import { exportRepo, removeTree } from "../../../src/export/index.js";
import { extractSnapshot } from "../../../src/extract/index.js";
import { hakutakuDirs, withBuildLock } from "../../../src/registry/index.js";
import {
  openStore,
  readAttempt,
  type Store,
} from "../../../src/store/index.js";
import { git } from "../../helpers/git.js";
import { requireInCI } from "../../helpers/live.js";
import { samplePythonProbe, sampleRepo } from "../../helpers/sample.js";

const TIMEOUT = 300_000;
const CHILD = fileURLToPath(
  new URL("../../helpers/extract-child.mjs", import.meta.url),
);
const PROFILE = fileURLToPath(
  new URL("../../../fixtures/observatory/profile.json", import.meta.url),
);
// The installed engines, read before any test points XDG_DATA_HOME elsewhere.
const ENGINES_DIR = defaultEnginesDir();
const PYTHON = samplePythonProbe();
const ALL_RAN = {
  "ast-grep": "ran",
  "dependency-cruiser": "ran",
  grimp: "ran",
  "scip-typescript": "ran",
};
// How long the dead build's process group may take to be gone.
const GROUP_GONE_MS = 30_000;

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) removeTree(dir);
});

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-oracle-interrupted-"));
  made.push(dir);
  return dir;
};

// The sample at ref, exported with its profile into a fresh directory.
async function exportOf(ref: string): Promise<string> {
  const out = join(tmp(), "export");
  await exportRepo({
    repo: await sampleRepo(),
    ref,
    out,
    id: "observatory",
    profile: PROFILE,
  });
  return out;
}

// The store's commit and each engine's tier.
function storeOf(path: string): {
  commit: string;
  tiers: Store["meta"]["coverage"]["tiers"];
} {
  const store = openStore(path);
  if ("code" in store) throw new Error(`${path}: ${store.reason}`);
  try {
    return { commit: store.meta.commit, tiers: store.meta.coverage.tiers };
  } finally {
    store.close();
  }
}

// Runs the child as the leader of a process group of its own, with XDG_DATA_HOME at dataHome,
// and waits until it has died and its whole group is gone, so that no engine it started still
// writes beside the store. stderr is its standard error, for a failure's message.
async function killedBuild(
  dir: string,
  out: string,
  stage: string,
  dataHome: string,
): Promise<{
  pid: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}> {
  const log = join(tmp(), "child.stderr");
  const fd = openSync(log, "w");
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [CHILD, dir, out, ENGINES_DIR, stage], {
      detached: true,
      stdio: ["ignore", "ignore", fd],
      env: { ...process.env, XDG_DATA_HOME: dataHome },
    });
  } finally {
    closeSync(fd);
  }
  const [code, signal] = (await once(child, "exit")) as [
    number | null,
    NodeJS.Signals | null,
  ];
  const pid = child.pid as number;
  await groupGone(pid);
  return { pid, code, signal, stderr: readFileSync(log, "utf8") };
}

// Waits until no process is left in the group pgid.
async function groupGone(pgid: number): Promise<void> {
  const deadline = Date.now() + GROUP_GONE_MS;
  for (;;) {
    try {
      process.kill(-pgid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `process group ${pgid} outlived its leader by ${GROUP_GONE_MS / 1000} s`,
      );
    }
    await sleep(50);
  }
}

// Runs fn with XDG_DATA_HOME at dir, where withBuildLock keeps its lock, then puts back what
// was there. This file's tests run one at a time, so nothing else reads it meanwhile.
async function withDataHome<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dir;
  try {
    return await fn();
  } finally {
    if (saved === undefined)
      Reflect.deleteProperty(process.env, "XDG_DATA_HOME");
    else process.env.XDG_DATA_HOME = saved;
  }
}

it.for([
  ["engine:scip-typescript", "running scip-typescript"],
  ["write-store", "writing the store"],
  ["swap", "swapping the store"],
] as const)(
  "survives a kill at %s",
  { timeout: TIMEOUT },
  async ([stage, said], ctx) => {
    requireInCI(ctx, PYTHON);
    const repo = await sampleRepo();
    const head = git(repo, "rev-parse", "HEAD");
    const headMinus1 = git(repo, "rev-parse", "HEAD~1");
    const root = tmp();
    const store = join(root, "store", "store.sqlite");
    const dataHome = join(root, "data");
    const dataDir = hakutakuDirs({
      ...process.env,
      XDG_DATA_HOME: dataHome,
    }).data;

    const previous = await extractSnapshot({
      dir: await exportOf("HEAD~1"),
      out: store,
      enginesDir: ENGINES_DIR,
      sandbox: "none",
    });
    expect(previous.result).toBe("built");
    expect(storeOf(store)).toEqual({ commit: headMinus1, tiers: ALL_RAN });

    const headExport = await exportOf("HEAD");
    const child = await killedBuild(headExport, store, stage, dataHome);
    const { pid } = child;
    expect(child.signal, child.stderr).toBe("SIGKILL");

    expect(storeOf(store).commit).toBe(headMinus1);
    expect(readAttempt(store)).toMatchObject({
      commit: head,
      result: "failed",
      reason: expect.stringMatching(
        new RegExp(`^interrupted or still running \\(pid ${pid}\\): ${said}$`),
      ),
    });
    // the leftovers exist before recovery, so their removal below proves something
    expect(existsSync(join(dirname(store), `work.tmp-${pid}`))).toBe(true);
    expect(existsSync(join(dirname(store), `store.tmp-${pid}.sqlite`))).toBe(
      stage !== "engine:scip-typescript",
    );
    expect(
      JSON.parse(readFileSync(join(dataDir, "build.lock"), "utf8")).pid,
    ).toBe(pid);

    const r = await withDataHome(dataHome, () =>
      withBuildLock(() =>
        extractSnapshot({
          dir: headExport,
          out: store,
          enginesDir: ENGINES_DIR,
          sandbox: "none",
        }),
      ),
    );
    expect(r.result).toBe("built");
    expect(storeOf(store)).toEqual({ commit: head, tiers: ALL_RAN });
    expect(readAttempt(store)).toMatchObject({ commit: head, result: "built" });
    expect(
      readdirSync(dirname(store)).filter((f) => /^(store|work)\.tmp-/.test(f)),
    ).toEqual([]);
    expect(existsSync(join(dataDir, "build.lock"))).toBe(false);
  },
);
