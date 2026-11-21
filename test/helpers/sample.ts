// The observatory sample for tests: its repository, its store, and XDG directories that serve
// it. The repository and each store are cached under <OS temp>/hakutaku-test-cache/, in a
// directory named by a SHA-256 of what they are built from, so a change to any of those builds
// a fresh one. Each is built in a temporary directory there and renamed into place only once it
// is complete, so test workers running in parallel never see half of one, and a worker that
// loses the race to rename uses the winner's. Neither must be changed by a test.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";
import {
  defaultEnginesDir,
  readLock,
  resolveBin,
} from "../../src/engines/index.js";
import { exportRepo, removeTree } from "../../src/export/index.js";
import { extractSnapshot } from "../../src/extract/index.js";
import type { Detail } from "../../src/model/index.js";
import {
  type HakutakuDirs,
  hakutakuDirs,
  saveEntry,
  storePathFor,
} from "../../src/registry/index.js";
import { openStore } from "../../src/store/index.js";
import { commandProbe, type LiveProbe } from "./live.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SAMPLE = join(ROOT, "fixtures", "observatory");
const PROFILE = join(SAMPLE, "profile.json");
const CACHE = join(tmpdir(), "hakutaku-test-cache");

// What make.mjs reads, and what a store depends on besides the sample.
const REPO_INPUTS = [
  "fixtures/observatory/make.mjs",
  "fixtures/observatory/history.mjs",
  "fixtures/observatory/tree",
];
const STORE_INPUTS = [
  "src",
  "ast-grep",
  "python",
  "engines.lock.json",
  "fixtures/observatory",
];

// The installed engines, read when this module loads: a test may later point the XDG
// variables at a scratch root, where no engine is installed.
const ENGINES_DIR = defaultEnginesDir();

const isDirectory = (path: string): boolean =>
  statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

// A live probe for requireInCI (test/helpers/live.ts): whether the installed engines have a
// Python that starts. Without one grimp cannot run, so the sample builds with hakutaku's
// resolver in grimp's place, and sampleStore refuses that build. It reads the engines that
// sampleStore builds with; a missing install throws, as every engine-backed test fails then.
export function samplePythonProbe(): LiveProbe {
  const name = "a Python for grimp";
  const installed = JSON.parse(
    readFileSync(join(ENGINES_DIR, "installed.json"), "utf8"),
  );
  if (typeof installed.python !== "string") {
    return {
      name,
      ok: false,
      evidence: "the engines were installed without a Python",
    };
  }
  return commandProbe(name, [installed.python, "-I", "-c", "pass"]);
}

// A live probe for requireInCI: whether the installed engines hold scip-python, which only an
// install with --deep does, and its bin starts. A test that runs it is skipped where it does not,
// and fails in CI, whose engines are installed with --deep.
export function scipPythonProbe(): LiveProbe {
  const name = "scip-python, from an engine install with --deep";
  const entry = readLock().lock.engines["scip-python"];
  if (entry === undefined) {
    return {
      name,
      ok: false,
      evidence: "the engine lock holds no scip-python",
    };
  }
  return commandProbe(name, [
    process.execPath,
    resolveBin(ENGINES_DIR, entry.bin),
    "--version",
  ]);
}

// The files under a path relative to hakutaku's root, itself when it is a file.
function filesUnder(path: string): string[] {
  if (!isDirectory(join(ROOT, path))) return [path];
  return readdirSync(join(ROOT, path), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? filesUnder(`${path}/${e.name}`)
      : e.isFile()
        ? [`${path}/${e.name}`]
        : [],
  );
}

// A SHA-256 over each file under the paths, as its path, its size and its bytes, in path
// order, then over `extra`.
function hashOf(paths: readonly string[], extra = ""): string {
  const hash = createHash("sha256");
  for (const file of paths.flatMap(filesUnder).sort()) {
    const bytes = readFileSync(join(ROOT, file));
    hash.update(`${file}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  hash.update(extra);
  return hash.digest("hex");
}

// The cache directory `name`, built by `build` into a fresh temporary directory first when it
// is missing.
async function cached(
  name: string,
  build: (dir: string) => Promise<void>,
): Promise<string> {
  const target = join(CACHE, name);
  if (isDirectory(target)) return target;
  mkdirSync(CACHE, { recursive: true });
  const tmp = mkdtempSync(join(CACHE, `tmp-${name.slice(0, 24)}-`));
  try {
    await build(tmp);
    try {
      renameSync(tmp, target);
    } catch (error) {
      // another worker renamed its build into place first
      if (!isDirectory(target)) throw error;
    }
  } finally {
    removeTree(tmp);
  }
  return target;
}

let repo: Promise<string> | undefined;

// The sample's git repository, made by fixtures/observatory/make.mjs.
export function sampleRepo(): Promise<string> {
  repo ??= cached(`repo-${hashOf(REPO_INPUTS)}`, async (dir) => {
    execFileSync(process.execPath, [join(SAMPLE, "make.mjs"), dir], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  }).then((dir) => join(dir, "observatory"));
  return repo;
}

const stores = new Map<Detail, Promise<string>>();

// The sample's store.sqlite at this detail: its main branch exported with the sample's profile
// and rules, then extracted with the installed engines and no sandbox. A build that did not
// pass its gates, or in which an engine failed or fell back, throws rather than being cached.
export function sampleStore(detail: Detail = "standard"): Promise<string> {
  let store = stores.get(detail);
  if (store === undefined) {
    store = buildStore(detail);
    stores.set(detail, store);
  }
  return store;
}

async function buildStore(detail: Detail): Promise<string> {
  const source = await sampleRepo();
  const name = `store-${detail}-${hashOf(STORE_INPUTS, detail)}`;
  const dir = await cached(name, async (tmp) => {
    const exported = join(tmp, "export");
    const out = join(tmp, "store", "store.sqlite");
    try {
      await exportRepo({
        repo: source,
        ref: "main",
        out: exported,
        id: "observatory",
        profile: PROFILE,
      });
      const result = await extractSnapshot({
        dir: exported,
        out,
        enginesDir: ENGINES_DIR,
        detail,
        sandbox: "none",
      });
      if (result.result !== "built") {
        throw new Error(
          `the sample did not build at ${detail} detail: ${result.result}${
            result.reason === undefined ? "" : `: ${result.reason}`
          }`,
        );
      }
    } finally {
      removeTree(exported);
    }
    checkEngines(out, detail);
  });
  return join(dir, "store", "store.sqlite");
}

// Each engine's own tier, never only the build's result: a failed engine or a fallback still
// builds a store, whose facts differ from the sample's.
function checkEngines(path: string, detail: Detail): void {
  const store = openStore(path);
  if ("code" in store) throw new Error(`the sample store: ${store.reason}`);
  try {
    const bad = Object.entries(store.meta.coverage.tiers).filter(
      ([, tier]) => tier !== "ran" && tier !== "skipped",
    );
    if (bad.length > 0) {
      throw new Error(
        `the sample built at ${detail} detail with ${bad
          .map(([engine, tier]) => `${engine} ${tier}`)
          .join(", ")}`,
      );
    }
  } finally {
    store.close();
  }
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

// XDG directories under a fresh temporary root, removed after the last test of the file that
// made it, in which the sample is registered as "observatory" at standard detail, with its
// standard store in place. env is this process's environment pointed at them.
export async function sampleEnv(): Promise<{
  env: NodeJS.ProcessEnv;
  dirs: HakutakuDirs;
}> {
  const source = await sampleRepo();
  const store = await sampleStore("standard");
  const root = mkdtempSync(join(tmpdir(), "hakutaku-sample-env-"));
  roots.push(root);
  const xdg = {
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
  };
  withEnv(xdg, () => {
    saveEntry({
      id: "observatory",
      source,
      ref: "main",
      detail: "standard",
      noSource: false,
      snippets: true,
      profile: PROFILE,
    });
    const path = storePathFor("observatory");
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(store, path);
  });
  const env: NodeJS.ProcessEnv = { ...process.env, ...xdg };
  return { env, dirs: hakutakuDirs(env) };
}

// Runs fn with these variables set in this process's environment, then puts back what was
// there. fn is synchronous, so no other test code runs while they are set.
function withEnv(vars: Record<string, string>, fn: () => void): void {
  const saved = Object.keys(vars).map(
    (key) => [key, process.env[key]] as const,
  );
  Object.assign(process.env, vars);
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
}
