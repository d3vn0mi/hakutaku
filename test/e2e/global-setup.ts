// The end-to-end tests' global setup. It makes the repos the specs open under a fresh temporary
// root, maps each with the built CLI and the installed engines, and serves each with
// `hakutaku view`; the specs read the links, the XDG directories and the root from HAKUTAKU_E2E_*
// variables (helpers.ts). The teardown it returns stops every server and removes the root.
//
// The 20,000-file scale repo is made only when CI is set or HAKUTAKU_E2E_WITH_SCALE=1; specs
// that need it skip without it.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MAIN = join(ROOT, "dist", "cli", "main.js");
// Node 22 warns on stderr, in every run, that node:sqlite is experimental.
const NODE_ARGS = ["--disable-warning=ExperimentalWarning"];
const STEP_TIMEOUT_MS = 20 * 60_000;
const LINK_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 10_000;

interface Repo {
  id: string;
  dir: string;
  detail: "quick" | "standard";
  variable: string;
}

// The installed engines: <XDG_DATA_HOME, or ~/.local/share>/hakutaku/engines/ and the first 16
// hex digits of the lock's SHA-256, read before the XDG variables point at the root.
function enginesDir(): string {
  const set = process.env.XDG_DATA_HOME;
  const data =
    set !== undefined && isAbsolute(set)
      ? set
      : join(homedir(), ".local", "share");
  const hash = createHash("sha256")
    .update(readFileSync(join(ROOT, "engines.lock.json")))
    .digest("hex");
  return join(data, "hakutaku", "engines", hash.slice(0, 16));
}

// Runs node with args in hakutaku's root; throws with the end of stderr unless it exits 0.
function run(args: string[], env: NodeJS.ProcessEnv): void {
  const r = spawnSync(process.execPath, [...NODE_ARGS, ...args], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    timeout: STEP_TIMEOUT_MS,
  });
  if (r.error !== undefined || r.status !== 0) {
    const how = r.error?.message ?? `exit ${r.status ?? r.signal}`;
    throw new Error(
      `node ${args.join(" ")} failed (${how}):\n${(r.stderr ?? "").slice(-4000)}`,
    );
  }
}

// Starts `hakutaku view <id>` and resolves to the link it prints first.
function serve(
  id: string,
  env: NodeJS.ProcessEnv,
  children: ChildProcess[],
): Promise<string> {
  const child = spawn(process.execPath, [...NODE_ARGS, MAIN, "view", id], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let err = "";
  child.stderr?.setEncoding("utf8").on("data", (s: string) => {
    err = `${err}${s}`.slice(-4000);
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`hakutaku view ${id} printed no link:\n${err}`)),
      LINK_TIMEOUT_MS,
    );
    let out = "";
    child.stdout?.setEncoding("utf8").on("data", (s: string) => {
      out += s;
      const end = out.indexOf("\n");
      if (end >= 0) {
        clearTimeout(timer);
        resolve(out.slice(0, end));
      }
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(
          `hakutaku view ${id} ended (${signal ?? `exit ${code}`}) before printing its link:\n${err}`,
        ),
      );
    });
  });
}

// SIGINT to each server still running, SIGKILL to one that has not exited 10 s later; resolves
// once every one has exited.
function stopAll(children: ChildProcess[]): Promise<void> {
  return Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          const timer = setTimeout(
            () => child.kill("SIGKILL"),
            STOP_TIMEOUT_MS,
          );
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          child.kill("SIGINT");
        }),
    ),
  ).then(() => undefined);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(MAIN)) {
    throw new Error("run npm run build first: dist/cli/main.js is missing");
  }
  // The package's own removal, imported once the build is known to exist: the export directory
  // that each map keeps is read-only, which a plain recursive removal cannot remove.
  const { removeTree } = await import("../../dist/export/index.js");
  const engines = enginesDir();
  const root = mkdtempSync(join(tmpdir(), "hakutaku-e2e-"));
  const xdg = {
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
  };
  const env = { ...process.env, ...xdg };
  const children: ChildProcess[] = [];
  // A last resort, should the runner end without its teardown: no server outlives it.
  process.once("exit", () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });
  const teardown = async (): Promise<void> => {
    await stopAll(children);
    removeTree(root);
  };
  try {
    const repos = join(root, "repos");
    const withScale =
      Boolean(process.env.CI) || process.env.HAKUTAKU_E2E_WITH_SCALE === "1";
    run([join(ROOT, "fixtures", "observatory", "make.mjs"), repos], env);
    cpSync(join(repos, "observatory"), join(repos, "observatory-quick"), {
      recursive: true,
      verbatimSymlinks: true,
    });
    run(
      [join(ROOT, "fixtures", "hostile", "make.mjs"), join(root, "hostile")],
      env,
    );
    run([join(ROOT, "test", "e2e", "fixtures", "bigfile.mjs"), repos], env);
    const list: Repo[] = [
      {
        id: "observatory",
        dir: join(repos, "observatory"),
        detail: "standard",
        variable: "HAKUTAKU_E2E_SAMPLE",
      },
      {
        id: "bigfile",
        dir: join(repos, "bigfile"),
        detail: "standard",
        variable: "HAKUTAKU_E2E_BIGFILE",
      },
      {
        id: "observatory-quick",
        dir: join(repos, "observatory-quick"),
        detail: "quick",
        variable: "HAKUTAKU_E2E_SAMPLE_QUICK",
      },
      {
        id: "markup-names",
        dir: join(root, "hostile", "markup-names"),
        detail: "quick",
        variable: "HAKUTAKU_E2E_MARKUP",
      },
    ];
    if (withScale) {
      const dir = join(repos, "scale");
      run(
        [
          join(ROOT, "fixtures", "scale", "generate.mjs"),
          "--files",
          "20000",
          "--out",
          dir,
        ],
        env,
      );
      list.push({
        id: "scale",
        dir,
        detail: "quick",
        variable: "HAKUTAKU_E2E_SCALE",
      });
    }
    for (const repo of list) {
      run(
        [
          MAIN,
          "map",
          repo.dir,
          "--id",
          repo.id,
          "--detail",
          repo.detail,
          "--sandbox",
          "none",
          "--engines-dir",
          engines,
          "--yes",
        ],
        env,
      );
    }
    delete process.env.HAKUTAKU_E2E_SCALE;
    for (const repo of list) {
      process.env[repo.variable] = await serve(repo.id, env, children);
    }
    process.env.HAKUTAKU_E2E_XDG = JSON.stringify(xdg);
    process.env.HAKUTAKU_E2E_ROOT = root;
  } catch (error) {
    await teardown();
    throw error;
  }
  return teardown;
}
