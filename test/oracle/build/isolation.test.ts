// A build reads its inputs and writes only its own files: export reads the repository and
// writes the export directory, extract reads that directory and writes the store, and neither
// opens a network socket. Both run as the CLI under strace, which logs every socket and connect
// call of the process and of every process it starts; SHA-256 manifests of the repository, .git
// included, and of the export, taken before and after, show that nothing in either changed. The
// repository is a copy of the sample's, so the shared cache is never what a test might write
// to. The test needs an strace that can trace, and the Python the engines were installed with,
// so that every engine runs: where either fails, it is skipped, and in CI it fails. Run
// `npm run build` first, and `node dist/cli/main.js engines install --yes` once.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { defaultEnginesDir } from "../../../src/engines/index.js";
import { removeTree } from "../../../src/export/index.js";
import { openStore } from "../../../src/store/index.js";
import { git } from "../../helpers/git.js";
import { commandProbe, requireInCI } from "../../helpers/live.js";
import { samplePythonProbe, sampleRepo } from "../../helpers/sample.js";

const TIMEOUT = 300_000;
const MAIN = fileURLToPath(
  new URL("../../../dist/cli/main.js", import.meta.url),
);
const PROFILE = fileURLToPath(
  new URL("../../../fixtures/observatory/profile.json", import.meta.url),
);
const ENGINES_DIR = defaultEnginesDir();
const TRACE = ["-f", "-qq", "-e", "trace=socket,connect"];
const STRACE = commandProbe("strace", [
  "strace",
  ...TRACE,
  "-o",
  "/dev/null",
  "true",
]);
const PYTHON = samplePythonProbe();
// A process that opens an AF_INET socket to the loopback address, and ends once it is closed.
const CONNECT =
  'const s = require("node:net").connect(9, "127.0.0.1"); s.on("connect", () => s.destroy()); s.on("error", () => {});';

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) removeTree(dir);
});

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-oracle-isolation-"));
  made.push(dir);
  return dir;
};

// Runs argv under strace, which writes its log to log; a run that does not exit 0 throws, with
// its standard error.
function traced(log: string, argv: string[], env: NodeJS.ProcessEnv): string {
  const r = spawnSync("strace", [...TRACE, "-o", log, ...argv], {
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error !== undefined || r.status !== 0) {
    throw new Error(
      `${argv.join(" ")}: ${r.error?.message ?? `exit code ${r.status}, signal ${r.signal}`}\n${r.stderr}`,
    );
  }
  return r.stdout;
}

// Every entry under root, by its path from root: a file as the SHA-256 of its bytes, a link as
// its target, a directory as "dir", so that a new empty directory or a new link shows as well.
function manifest(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const name = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) {
        entries[name] = `link ${readlinkSync(path)}`;
      } else if (entry.isDirectory()) {
        entries[name] = "dir";
        walk(path, `${name}/`);
      } else if (entry.isFile()) {
        entries[name] =
          `sha256 ${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
      } else {
        entries[name] = "other";
      }
    }
  };
  walk(root, "");
  return entries;
}

it(
  "makes no AF_INET connection and writes nothing to the source or the snapshot",
  async (ctx) => {
    requireInCI(ctx, STRACE, PYTHON);
    const root = tmp();
    const repo = join(root, "observatory");
    cpSync(await sampleRepo(), repo, {
      recursive: true,
      verbatimSymlinks: true,
    });
    const exported = join(root, "export");
    const store = join(root, "store", "store.sqlite");
    const logs = {
      control: join(root, "control.strace"),
      export: join(root, "export.strace"),
      extract: join(root, "extract.strace"),
    };
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_DATA_HOME: join(root, "data"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_CACHE_HOME: join(root, "cache"),
    };

    // the trace logs an AF_INET socket where a process opens one
    traced(logs.control, [process.execPath, "-e", CONNECT], env);
    expect(readFileSync(logs.control, "utf8")).toMatch(/AF_INET/);

    const before: Record<string, Record<string, string>> = {
      repo: manifest(repo),
    };
    traced(
      logs.export,
      [
        process.execPath,
        MAIN,
        "export",
        repo,
        "--ref",
        "main",
        "--out",
        exported,
        "--id",
        "observatory",
        "--profile",
        PROFILE,
      ],
      env,
    );
    before.export = manifest(exported);
    const result = JSON.parse(
      traced(
        logs.extract,
        [
          process.execPath,
          MAIN,
          "extract",
          exported,
          "--out",
          store,
          "--engines-dir",
          ENGINES_DIR,
          "--sandbox",
          "none",
        ],
        env,
      ),
    );
    const after = { repo: manifest(repo), export: manifest(exported) };

    expect(readFileSync(logs.export, "utf8")).not.toMatch(/AF_INET/);
    expect(readFileSync(logs.extract, "utf8")).not.toMatch(/AF_INET/);
    expect(after.repo).toEqual(before.repo);
    expect(after.export).toEqual(before.export);

    // the build that was traced ran every engine and built the store
    expect(result.result).toBe("built");
    const s = openStore(store);
    if ("code" in s) throw new Error(`${store}: ${s.reason}`);
    try {
      expect(s.meta.commit).toBe(git(repo, "rev-parse", "HEAD"));
      expect(s.meta.coverage.tiers).toEqual({
        "ast-grep": "ran",
        "dependency-cruiser": "ran",
        grimp: "ran",
        "scip-typescript": "ran",
        "scip-python": "skipped",
      });
    } finally {
      s.close();
    }
  },
  TIMEOUT,
);
