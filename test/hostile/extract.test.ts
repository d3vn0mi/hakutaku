// The hostile extract cases. Each test makes the fixtures afresh, then runs its control first:
// the stock engine or Python running the vector on a copy of the case, which must fire it, or,
// where nothing can run it, a check of the fixture's shape; the canary is emptied again before
// hakutaku runs. Then the case's checkout is exported with exportRepo and extracted with
// extractSnapshot and no sandbox, and every engine's own status is checked, never the build's
// result alone. Every export and store is made outside the fixtures, under a directory removed
// afterwards. Run `node dist/cli/main.js engines install --yes` once before this file.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, expect, it, vi } from "vitest";
import type { CliIO } from "../../src/cli/commands/index.js";
import { main } from "../../src/cli/main.js";
import {
  defaultEnginesDir,
  readLock,
  resolveBin,
} from "../../src/engines/index.js";
import {
  type ExportManifest,
  exportRepo,
  removeTree,
} from "../../src/export/index.js";
import {
  type ExtractResult,
  extractSnapshot,
} from "../../src/extract/index.js";
import type { Detail, EngineName } from "../../src/model/index.js";
import {
  createRefReader,
  createRegistryHost,
  profilePathFor,
  saveEntry,
  storePathFor,
} from "../../src/registry/index.js";
import {
  type BuildFacts,
  createStoreCache,
  openStore,
  readAttempt,
  readBuildFacts,
  type Store,
} from "../../src/store/index.js";
import { runTool } from "../../src/tools/index.js";
import { standInEnginesDir } from "../helpers/engines.js";
import {
  expectContained,
  type HostileCaseId,
  type HostileFixtures,
  hostileFixtures,
  scratchCopy,
  takeCanary,
} from "../helpers/hostile.js";
import { requireInCI } from "../helpers/live.js";
import { samplePythonProbe } from "../helpers/sample.js";

const TIMEOUT = 300_000;
const GIB = 1024 ** 3;

// The installed engines, read when this file loads, and the Python they were installed with:
// grimp runs under it, so a case that needs grimp to run requires it.
const ENGINES_DIR = defaultEnginesDir();
const PYTHON = samplePythonProbe();
const pinnedPython = (): string =>
  JSON.parse(readFileSync(join(ENGINES_DIR, "installed.json"), "utf8")).python;

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) removeTree(dir);
});

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-hostile-extract-"));
  made.push(dir);
  return dir;
};

// An installed engine's bin, run as it is shipped.
const bin = (engine: EngineName): string => {
  const entry = readLock().lock.engines[engine];
  if (entry === undefined) throw new Error(`the lock has no ${engine}`);
  return resolveBin(ENGINES_DIR, entry.bin);
};

// A command as a person runs it in a checkout: an empty environment but for PATH and a home
// that does not exist, plus what the control sets.
function stock(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(command, args, {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: "/nonexistent",
      LANG: "C.UTF-8",
      PYTHONDONTWRITEBYTECODE: "1",
      ...env,
    },
    encoding: "utf8",
    timeout: 120_000,
  });
  if (r.error !== undefined) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

interface Built {
  result: ExtractResult;
  exportDir: string;
  manifest: ExportManifest;
  store: string;
  facts: BuildFacts | null;
}

// The case's main branch exported into a fresh directory, then extracted at the detail given
// with the installed engines and no sandbox, into a store of its own.
async function exportAndExtract(
  fx: HostileFixtures,
  id: HostileCaseId,
  detail: Detail,
): Promise<Built> {
  const exportDir = join(tmp(), "export");
  await exportRepo({ repo: join(fx.dir, id), ref: "main", out: exportDir });
  const store = join(tmp(), "store", "store.sqlite");
  const result = await extractSnapshot({
    dir: exportDir,
    out: store,
    enginesDir: ENGINES_DIR,
    detail,
    sandbox: "none",
  });
  return {
    result,
    exportDir,
    manifest: JSON.parse(readFileSync(join(exportDir, "export.json"), "utf8")),
    store,
    facts: readBuildFacts(store),
  };
}

function inStore<T>(path: string, read: (s: Store) => T): T {
  const store = openStore(path);
  if ("code" in store) throw new Error(`${path}: ${store.reason}`);
  try {
    return read(store);
  } finally {
    store.close();
  }
}

// Each engine's status in build.json.
const statuses = (facts: BuildFacts | null) =>
  Object.fromEntries(
    Object.entries(facts?.engines ?? {}).map(([name, e]) => [name, e.status]),
  );

// The imports a file makes, as the store holds them.
const importsOf = (s: Store, path: string) =>
  s.db
    .prepare(
      `SELECT i.specifier, i.line, d.path AS file, e.name AS external, i.resolved, i.producer
       FROM imports i JOIN files f ON f.id = i.src_file_id
       LEFT JOIN files d ON d.id = i.dst_file_id
       LEFT JOIN externals e ON e.id = i.dst_external_id
       WHERE f.path = ? ORDER BY i.id`,
    )
    .all(path);

it(
  "sgconfig: removes the repo's sgconfig.yml and never applies its rules",
  async () => {
    const fx = await hostileFixtures();
    const copy = scratchCopy(fx, "sgconfig");
    // stock ast-grep in the checkout loads its sgconfig.yml and applies the repository's rule
    const control = stock(bin("ast-grep"), ["scan", "--json=stream"], copy);
    expect(control.stdout).toContain('"ruleId":"hakutaku-hostile-sgconfig"');
    expect(takeCanary(fx)).toEqual({});

    const { result, exportDir, manifest, store, facts } =
      await exportAndExtract(fx, "sgconfig", "quick");
    expect(manifest.engineConfigsRemoved).toEqual(["sgconfig.yml"]);
    expect(existsSync(join(exportDir, "snapshot", "sgconfig.yml"))).toBe(false);
    // a match of a rule that is not hakutaku's fails ast-grep, and with it the build
    expect(result.result).toBe("built");
    expect(statuses(facts)["ast-grep"]).toBe("ran");
    inStore(store, (s) => {
      expect(s.meta.coverage.tiers["ast-grep"]).toBe("ran");
      // ast-grep read the JavaScript with hakutaku's rules
      expect(
        s.db
          .prepare(
            "SELECT d.qualname FROM definitions d JOIN files f ON f.id = d.file_id WHERE f.path = 'src/a.js' ORDER BY d.id",
          )
          .all(),
      ).toContainEqual({ qualname: "a" });
      expect(
        s.db
          .prepare("SELECT rule FROM rule_findings WHERE rule LIKE '%hostile%'")
          .all(),
      ).toEqual([]);
    });
    // ast-grep loaded no custom language: it warns when a config names one
    expect(facts?.warnings.join("\n")).not.toMatch(/hostile|custom language/i);
    expectContained(fx, { exportDir, store });
  },
  TIMEOUT,
);

it(
  "depcruise-config: removes .dependency-cruiser.js and runs nothing from it",
  async () => {
    const fx = await hostileFixtures();
    const copy = scratchCopy(fx, "depcruise-config");
    // stock dependency-cruiser given the repository's config loads it
    stock(
      process.execPath,
      [
        bin("dependency-cruiser"),
        "--config",
        ".dependency-cruiser.js",
        "--output-type",
        "json",
        "src",
      ],
      copy,
    );
    expect(takeCanary(fx)).toEqual({
      "depcruise-config": [
        "depcruise-config: .dependency-cruiser.js was loaded",
      ],
    });

    const { result, exportDir, manifest, store, facts } =
      await exportAndExtract(fx, "depcruise-config", "quick");
    expect(manifest.engineConfigsRemoved).toEqual([".dependency-cruiser.js"]);
    expect(result.result).toBe("built");
    expect(statuses(facts)["dependency-cruiser"]).toBe("ran");
    inStore(store, (s) => {
      expect(s.meta.coverage.tiers["dependency-cruiser"]).toBe("ran");
      // dependency-cruiser read the JavaScript, with hakutaku's config
      expect(importsOf(s, "src/a.js")).toEqual([
        {
          specifier: "./b.js",
          line: 1,
          file: "src/b.js",
          external: null,
          resolved: 1,
          producer: "dependency-cruiser",
        },
      ]);
    });
    expectContained(fx, { exportDir, store });
  },
  TIMEOUT,
);

it(
  "python-shadow: imports none of json.py, sitecustomize.py or a side-effecting __init__.py",
  async (ctx) => {
    requireInCI(ctx, PYTHON);
    const fx = await hostileFixtures();
    const copy = scratchCopy(fx, "python-shadow");
    // stock Python imports each plant: from the working directory, which -c puts first on its
    // path, and sitecustomize from PYTHONPATH
    const python = pinnedPython();
    for (const name of ["json", "grimp", "pkg"]) {
      stock(python, ["-c", `import ${name}`], copy);
    }
    stock(python, ["-c", "pass"], copy, { PYTHONPATH: copy });
    expect(takeCanary(fx)).toEqual({
      "python-shadow": [
        "python-shadow: json.py was imported",
        "python-shadow: grimp.py was imported",
        "python-shadow: pkg/__init__.py was imported",
        "python-shadow: sitecustomize.py was imported",
      ],
    });

    const { result, exportDir, store, facts } = await exportAndExtract(
      fx,
      "python-shadow",
      "quick",
    );
    expect(result.result).toBe("built");
    expect(statuses(facts).grimp).toBe("ran");
    inStore(store, (s) => {
      expect(s.meta.coverage.tiers.grimp).toBe("ran");
      expect(s.meta.coverage.pythonResolver).toBe("grimp");
      // grimp read the package: pkg/mod.py's import of json is its fact, read and never run
      expect(importsOf(s, "pkg/mod.py")).toMatchObject([
        { specifier: "json", line: 1, producer: "grimp" },
      ]);
    });
    expectContained(fx, { exportDir, store });
  },
  TIMEOUT,
);

it(
  "minified-50mb: keeps metadata only and stays within the limits",
  async () => {
    const fx = await hostileFixtures();
    // no tool runs this vector here, so the fixture's shape is checked: one line of exactly
    // 52,428,800 bytes, tracked at that size, which app.js imports
    const repo = join(fx.dir, "minified-50mb");
    const big = readFileSync(join(repo, "src", "big.min.js"));
    expect(big.length).toBe(52_428_800);
    expect(big.includes(0x0a)).toBe(false);
    expect(
      stock("git", ["cat-file", "-s", "HEAD:src/big.min.js"], repo, {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      }).stdout,
    ).toBe("52428800\n");
    expect(readFileSync(join(repo, "src", "app.js"), "utf8")).toContain(
      'import "./big.min.js";',
    );

    const { result, exportDir, manifest, store, facts } =
      await exportAndExtract(fx, "minified-50mb", "standard");
    expect(manifest.metadataOnly).toEqual([
      { path: "src/big.min.js", reason: "size" },
    ]);
    expect(result.result).toBe("built");
    inStore(store, (s) => {
      expect(
        s.db
          .prepare("SELECT path, bytes, has_source FROM files ORDER BY id")
          .all(),
      ).toEqual([
        { path: "src/app.js", bytes: 46, has_source: 1 },
        { path: "src/big.min.js", bytes: 52_428_800, has_source: 0 },
      ]);
      expect(s.meta.coverage.noSourceFiles).toBe(1);
      // every engine with input ran to its end: none ran out of memory or time
      expect(s.meta.coverage.tiers).toEqual({
        "ast-grep": "ran",
        "dependency-cruiser": "ran",
        grimp: "skipped",
        "scip-typescript": "ran",
      });
      expect(s.meta.coverage.outOfMemory).toBeUndefined();
    });
    expect(statuses(facts)).toEqual({
      "ast-grep": "ran",
      "dependency-cruiser": "ran",
      grimp: "skipped",
      "scip-typescript": "ran",
    });
    // under the 3 GiB cap wherever the peak is known: each engine's, sampled on Linux, and the
    // build's, which only a sandbox measures
    const ran = Object.values(facts?.engines ?? {}).filter(
      (e) => e.status === "ran",
    );
    expect(ran).toHaveLength(3);
    for (const engine of ran) {
      if (process.platform === "linux") {
        expect(engine.peakRssBytes).toBeTypeOf("number");
      }
      expect(engine.peakRssBytes ?? 0).toBeLessThan(3 * GIB);
    }
    expect(facts?.peakRssBytes ?? 0).toBeLessThan(3 * GIB);
    expectContained(fx, { exportDir, store });
  },
  TIMEOUT,
);

it(
  "pyright-interpreter: removes pyrightconfig.json, and runs only the pinned interpreter",
  async (ctx) => {
    requireInCI(ctx, PYTHON);
    const fx = await hostileFixtures();
    const copy = scratchCopy(fx, "pyright-interpreter");
    // both configs name evil-venv, whose python writes the canary when it runs
    expect(
      JSON.parse(readFileSync(join(copy, "pyrightconfig.json"), "utf8")),
    ).toEqual({ venvPath: ".", venv: "evil-venv" });
    expect(readFileSync(join(copy, "pyproject.toml"), "utf8")).toContain(
      '[tool.pyright]\nvenvPath = "."\nvenv = "evil-venv"\n',
    );
    stock(join(copy, "evil-venv", "bin", "python"), ["--version"], copy);
    expect(takeCanary(fx)).toEqual({
      "pyright-interpreter": ["pyright-interpreter: evil-venv/bin/python ran"],
    });

    // standard detail: grimp is the engine here that runs a Python, the pinned one
    const { result, exportDir, manifest, store, facts } =
      await exportAndExtract(fx, "pyright-interpreter", "standard");
    expect(manifest.engineConfigsRemoved).toEqual(["pyrightconfig.json"]);
    expect(existsSync(join(exportDir, "snapshot", "pyrightconfig.json"))).toBe(
      false,
    );
    expect(result.result).toBe("built");
    expect(statuses(facts).grimp).toBe("ran");
    inStore(store, (s) => {
      expect(s.meta.coverage.tiers.grimp).toBe("ran");
      expect(s.meta.coverage.pythonResolver).toBe("grimp");
    });
    expectContained(fx, { exportDir, store });
  },
  TIMEOUT,
);

// A stand-in for ast-grep that fails as a parser does on a line it cannot read: it names the
// file by its real path, the line, the directory it was scanning, and the line itself. The
// engine's PATH holds only Node and Python, so the script runs Node.
const FAILING_AST_GREP = [
  "#!/bin/sh",
  "exec node -e '",
  'const { readdirSync, readFileSync, realpathSync } = require("node:fs");',
  'const { join } = require("node:path");',
  "const view = process.argv.at(-1);",
  "const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>",
  "  e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);",
  "for (const file of walk(view)) {",
  '  const lines = readFileSync(file, "utf8").split("\\n");',
  '  const at = lines.findIndex((line) => line.includes("token = "));',
  "  if (at >= 0) {",
  '    const where = realpathSync(file) + ", line " + (at + 1) + ", in " + view;',
  '    process.stderr.write("error: cannot parse " + where + ": " + lines[at] + "\\n");',
  "    break;",
  "  }",
  "}",
  "process.exit(2);",
  '\' -- "$@"',
  "",
].join("\n");

// What one hakutaku command prints on stdout; it must exit 0 and print nothing on stderr.
async function cli(argv: string[]): Promise<string> {
  const c = { out: "", err: "" };
  const io: CliIO = {
    stdout: (s) => {
      c.out += s;
    },
    stderr: (s) => {
      c.err += s;
    },
    stdin: new PassThrough(),
    env: process.env,
    isTTY: false,
  };
  expect(await main(argv, io)).toBe(0);
  expect(c.err).toBe("");
  return c.out;
}

// No directory of this machine: not the temporary directory the fixtures, the export and the
// store are made in, not the home directory, and not Node's.
function expectNoHostPath(text: string): void {
  for (const dir of [
    tmpdir(),
    realpathSync(tmpdir()),
    homedir(),
    dirname(process.execPath),
  ]) {
    expect(text).not.toContain(dir);
  }
}

it(
  "engine-failure-text: keeps the token and this machine's paths out of the attempt and the answers",
  async () => {
    const fx = await hostileFixtures();
    const id: HostileCaseId = "engine-failure-text";
    const token =
      /gh[p]_[A-Za-z0-9]{36,}/.exec(
        readFileSync(join(fx.dir, id, "src", "keys.js"), "utf8"),
      )?.[0] ?? "";
    expect(token).not.toBe("");
    // the stand-in, run on a copy of the checkout, prints the token and the file's real path
    const copy = scratchCopy(fx, id);
    const script = join(tmp(), "failing-ast-grep");
    writeFileSync(script, FAILING_AST_GREP, { mode: 0o755 });
    const control = stock(
      "/bin/sh",
      [script, "scan", join(copy, "src")],
      copy,
      {
        PATH: dirname(process.execPath),
      },
    );
    expect(control.status).toBe(2);
    expect(control.stderr).toContain(token);
    expect(control.stderr).toContain(
      join(realpathSync(copy), "src", "keys.js"),
    );

    // made before the XDG variables move, from the installed engines
    const enginesDir = standInEnginesDir("ast-grep", { sh: FAILING_AST_GREP });
    const root = tmp();
    vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
    vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
    vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
    try {
      saveEntry({
        id,
        source: join(fx.dir, id),
        ref: "main",
        detail: "quick",
        noSource: false,
        snippets: true,
        profile: profilePathFor(id),
      });
      const exportDir = join(root, "export");
      await exportRepo({
        repo: join(fx.dir, id),
        ref: "main",
        out: exportDir,
        id,
      });
      const out = storePathFor(id);
      const thrown = await extractSnapshot({
        dir: exportDir,
        out,
        enginesDir,
        detail: "quick",
        sandbox: "none",
      }).then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : null),
      );
      const reason = readAttempt(out)?.reason;
      expect(thrown).toBe(reason);
      // the paths are named by token, and the token is redacted
      expect(reason).toBe(
        [
          "ast-grep failed: exit code 2",
          'error: cannot parse <snapshot>/src/keys.js, line 2, in <work>/ast-grep: export const token = "«redacted:github-token»";',
        ].join("\n"),
      );
      expect(readdirSync(dirname(out))).toEqual(["attempt.json"]);

      // the answers an agent gets about the repo: code_repos, and code_refresh's last attempt
      const host = createRegistryHost(
        { repos: [id], allowRefresh: true },
        {
          now: Date.now,
          refs: createRefReader(),
          stores: createStoreCache(),
          spawnMap: () => ({ done: Promise.resolve() }),
        },
      );
      const repos = runTool(host, null, "code_repos", {});
      expect(repos).toMatchObject({
        ok: true,
        answer: {
          repos: [
            {
              id,
              stale: true,
              staleReason: `the last build failed: ${reason}`,
            },
          ],
        },
      });
      const refresh = runTool(host, null, "code_refresh", { repo: id });
      expect(refresh).toMatchObject({
        ok: true,
        answer: { lastAttempt: { result: "failed", reason } },
      });
      // and what a person gets from hakutaku list: its row, and its JSON
      const listed = await cli(["list"]);
      const listedJson = await cli(["list", "--json"]);
      expect(JSON.parse(listedJson)).toEqual([
        {
          id,
          ref: "main",
          builtCommit: null,
          headCommit: expect.stringMatching(/^[0-9a-f]{12}$/),
          stale: true,
          staleReason: `the last build failed: ${reason}`,
          detail: "quick",
          builtAt: null,
        },
      ]);
      expect(listed).toContain(
        `yes: the last build failed: ${reason?.replaceAll("\n", "; ")}`,
      );
      for (const text of [
        readFileSync(join(dirname(out), "attempt.json"), "utf8"),
        JSON.stringify(repos),
        JSON.stringify(refresh),
        listed,
        listedJson,
      ]) {
        expect(text).not.toContain(token);
        expectNoHostPath(text);
      }
      expectContained(fx, { exportDir, store: null });
    } finally {
      vi.unstubAllEnvs();
    }
  },
  TIMEOUT,
);
