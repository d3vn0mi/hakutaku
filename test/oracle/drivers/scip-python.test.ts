// The scip-python driver against the installed engine, which deep detail runs: run `node
// dist/cli/main.js engines install --yes --deep` once before this file, and `npm run build` for
// the sandboxed build. Each repo is made with makeRepo and exported with exportRepo, then read by
// scipPythonDriver.run over the export, or built at deep detail by extractSnapshot, with no
// sandbox unless a test says otherwise.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import {
  defaultEnginesDir,
  readLock,
  resolveBin,
} from "../../../src/engines/index.js";
import {
  type ExportManifest,
  exportRepo,
  removeTree,
} from "../../../src/export/index.js";
import type { ExtractContext } from "../../../src/extract/context.js";
import { scipPythonDriver } from "../../../src/extract/drivers/scip-python.js";
import { extractSnapshot } from "../../../src/extract/index.js";
import { decodeScipIndex } from "../../../src/extract/scip/decode.js";
import type { Detail } from "../../../src/model/index.js";
import { DEFAULT_PROFILE, type Profile } from "../../../src/profile/index.js";
import {
  openStore,
  readBuildFacts,
  type Store,
} from "../../../src/store/index.js";
import { makeRepo, type RepoSpec } from "../../helpers/git.js";
import { hostileFixtures, takeCanary } from "../../helpers/hostile.js";
import { commandProbe, requireInCI } from "../../helpers/live.js";
import { samplePythonProbe, scipPythonProbe } from "../../helpers/sample.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) removeTree(dir);
});

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-oracle-scip-python-"));
  made.push(dir);
  return dir;
};

const TIMEOUT = 300_000;
const ENGINES_DIR = defaultEnginesDir();
// The interpreter the engines were installed with, which Pyright inside scip-python asks for its
// search paths: a test that shows it runs requires it.
const PYTHON = samplePythonProbe();
// scip-python, which only an engine install with --deep holds: every test here runs it.
const SCIP_PYTHON = scipPythonProbe();
const pinnedPython = (): string =>
  JSON.parse(readFileSync(join(ENGINES_DIR, "installed.json"), "utf8")).python;

const BIN = resolveBin(
  ENGINES_DIR,
  readLock().lock.engines["scip-python"]?.bin ?? "",
);

const lines = (...text: string[]): string => `${text.join("\n")}\n`;

// The repo top as the one Python root, as in a repo of loose modules.
const PROFILE: Profile = {
  ...structuredClone(DEFAULT_PROFILE),
  python: { roots: ["."], singleFileModules: [] },
};

// Symbols as scip-python names them for the repo exported as observatory, with no version.
const PKG = "scip-python python observatory . ";

interface Exported {
  exportDir: string;
  manifest: ExportManifest;
}

const oneCommit = (files: RepoSpec["commits"][number]["files"]) =>
  makeRepo({ commits: [{ date: "2026-03-02T10:00:00Z", files }] });

// The repo's HEAD, exported as observatory into a fresh directory, with PROFILE, or with the
// profile export generates when the repo is given as is.
async function exportOf(
  repo: string,
  opts: { ref?: string; generated?: boolean; profile?: Profile } = {},
): Promise<Exported> {
  const root = tmp();
  const exportDir = join(root, "export");
  let profile: string | undefined;
  if (opts.generated !== true) {
    profile = join(root, "profile.json");
    writeFileSync(profile, JSON.stringify(opts.profile ?? PROFILE));
  }
  await exportRepo({
    repo,
    ref: opts.ref ?? "HEAD",
    out: exportDir,
    id: "observatory",
    ...(profile === undefined ? {} : { profile }),
  });
  return {
    exportDir,
    manifest: JSON.parse(readFileSync(join(exportDir, "export.json"), "utf8")),
  };
}

// A deep build's context over an export, with the pinned interpreter given.
function ctxOf(e: Exported, pythonPath: string | null): ExtractContext {
  const workDir = join(tmp(), "work");
  mkdirSync(workDir);
  return {
    exportDir: e.exportDir,
    snapshotDir: join(e.exportDir, "snapshot"),
    workDir,
    enginesDir: ENGINES_DIR,
    detail: "deep",
    noSource: false,
    profile: PROFILE,
    rules: null,
    manifest: e.manifest,
    pythonPath,
    memoryMax: "15G",
    log: () => {},
  };
}

// The export built at a detail into a store of its own, with the installed engines.
async function buildAt(e: Exported, detail: Detail): Promise<string> {
  const out = join(tmp(), "store", "store.sqlite");
  const result = await extractSnapshot({
    dir: e.exportDir,
    out,
    enginesDir: ENGINES_DIR,
    detail,
    sandbox: "none",
  });
  expect(result.result).toBe("built");
  return out;
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

// Each call site of a callee in a file, with its targets.
const targetsOf = (s: Store, path: string, callee: string) =>
  s.db
    .prepare(
      `SELECT c.line, c.col, t.label, t.collision, d.qualname, df.path AS file
       FROM call_sites c JOIN files f ON f.id = c.file_id
       JOIN call_targets t ON t.site_id = c.id
       JOIN definitions d ON d.id = t.def_id JOIN files df ON df.id = d.file_id
       WHERE f.path = ? AND c.callee_name = ? ORDER BY c.id, t.def_id`,
    )
    .all(path, callee);

// Each definition of the files under a directory, with its SCIP symbol.
const symbolsUnder = (s: Store, dir: string) =>
  s.db
    .prepare(
      `SELECT f.path, d.qualname, d.scip_symbol FROM definitions d
       JOIN files f ON f.id = d.file_id WHERE f.path LIKE ? ORDER BY d.id`,
    )
    .all(`${dir}/%`) as Array<{
    path: string;
    qualname: string;
    scip_symbol: string | null;
  }>;

// Sky.render calls self.draw(): draw is at line 9, column 21. SCALE, a constant on line 1, has
// its name where scip-python defines the file's module.
const SKY = {
  "sim/sky.py": lines(
    "SCALE = 2",
    "",
    "",
    "class Sky:",
    "    def draw(self):",
    "        return SCALE",
    "",
    "    def render(self):",
    "        return self.draw()",
  ),
};

it(
  "binds self.draw() in sim/sky.py to Sky.draw",
  async (ctx) => {
    requireInCI(ctx, SCIP_PYTHON);
    const e = await exportOf(await oneCommit(SKY));
    const deep = await buildAt(e, "deep");
    inStore(deep, (s) => {
      expect(s.meta.coverage.tiers["scip-python"]).toBe("ran");
      expect(targetsOf(s, "sim/sky.py", "draw")).toEqual([
        {
          line: 9,
          col: 21,
          label: "bound",
          collision: 0,
          qualname: "Sky.draw",
          file: "sim/sky.py",
        },
      ]);
      // the module's symbol goes to its module row, never to the constant named at (1,1)
      expect(symbolsUnder(s, "sim")).toEqual([
        {
          path: "sim/sky.py",
          qualname: "<module>",
          scip_symbol: `${PKG}\`sim.sky\`/__init__:`,
        },
        {
          path: "sim/sky.py",
          qualname: "SCALE",
          scip_symbol: `${PKG}\`sim.sky\`/SCALE.`,
        },
        {
          path: "sim/sky.py",
          qualname: "Sky",
          scip_symbol: `${PKG}\`sim.sky\`/Sky#`,
        },
        {
          path: "sim/sky.py",
          qualname: "Sky.draw",
          scip_symbol: `${PKG}\`sim.sky\`/Sky#draw().`,
        },
        {
          path: "sim/sky.py",
          qualname: "Sky.render",
          scip_symbol: `${PKG}\`sim.sky\`/Sky#render().`,
        },
      ]);
      // the use of SCALE in draw is scip-python's reference
      expect(
        s.db
          .prepare(
            `SELECT r.line, r.col, r.role, r.producer, d.qualname FROM refs r
             JOIN definitions d ON d.id = r.def_id ORDER BY r.id`,
          )
          .all(),
      ).toEqual([
        {
          line: 6,
          col: 16,
          role: "read",
          producer: "scip-python",
          qualname: "SCALE",
        },
      ]);
    });
    const facts = readBuildFacts(deep)?.engines["scip-python"];
    expect(facts?.status).toBe("ran");
    if (process.platform === "linux") {
      expect(facts?.peakRssBytes).toBeGreaterThan(0);
    }
    // the control: below deep detail the same call is only matched by name
    inStore(await buildAt(e, "standard"), (s) => {
      expect(s.meta.coverage.tiers["scip-python"]).toBe("skipped");
      expect(targetsOf(s, "sim/sky.py", "draw")).toEqual([
        {
          line: 9,
          col: 21,
          label: "scoped",
          collision: 0,
          qualname: "Sky.draw",
          file: "sim/sky.py",
        },
      ]);
    });
  },
  TIMEOUT,
);

// Whether bubblewrap works here: a test that needs it is skipped where it does not, and fails in
// CI. A sandboxed build runs dist/cli/main.js, so `npm run build` comes first.
const BWRAP = commandProbe("bubblewrap", [
  "bwrap",
  "--unshare-all",
  "--die-with-parent",
  "--ro-bind",
  "/",
  "/",
  "true",
]);

it(
  "builds the same store at deep detail inside bubblewrap, scip-python included",
  async (ctx) => {
    requireInCI(ctx, BWRAP, SCIP_PYTHON);
    const e = await exportOf(await oneCommit(SKY));
    const plain = await buildAt(e, "deep");
    const out = join(tmp(), "store", "store.sqlite");
    const r = await extractSnapshot({
      dir: e.exportDir,
      out,
      enginesDir: ENGINES_DIR,
      detail: "deep",
      sandbox: "require",
    });
    expect(r.result).toBe("built");
    expect(r.contentHash).toBe(inStore(plain, (s) => s.run.contentHash));
    const facts = readBuildFacts(out);
    expect(facts?.sandbox).toBe("bubblewrap");
    expect(facts?.engines["scip-python"]?.status).toBe("ran");
    inStore(out, (s) => {
      expect(targetsOf(s, "sim/sky.py", "draw")).toEqual([
        {
          line: 9,
          col: 21,
          label: "bound",
          collision: 0,
          qualname: "Sky.draw",
          file: "sim/sky.py",
        },
      ]);
    });
  },
  TIMEOUT,
);

it(
  "runs the pinned interpreter, never one from the snapshot",
  async (ctx) => {
    requireInCI(ctx, PYTHON, SCIP_PYTHON);
    // the hostile pyright-interpreter case: two configs name evil-venv, whose python and
    // python3 write the canary when they run
    const fx = await hostileFixtures();
    const e = await exportOf(join(fx.dir, "pyright-interpreter"), {
      ref: "main",
      generated: true,
    });
    // the pinned interpreter, through a wrapper that notes each run, then runs it
    const root = tmp();
    const log = join(root, "pinned.log");
    const wrapper = join(root, "bin", "python3");
    mkdirSync(dirname(wrapper));
    writeFileSync(
      wrapper,
      `#!/bin/sh\nprintf '%s\\n' "$1" >> '${log}'\nexec '${pinnedPython()}' "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    const facts = await scipPythonDriver.run(ctxOf(e, wrapper));
    expect([...facts.documents]).toEqual(["app/__init__.py", "app/mod.py"]);
    // Pyright asked it for its version and its search paths, each with -c
    const runs = readFileSync(log, "utf8").split("\n").filter(Boolean);
    expect(runs.length).toBeGreaterThan(0);
    expect(new Set(runs)).toEqual(new Set(["-c"]));
    expect(takeCanary(fx)).toEqual({});
  },
  TIMEOUT,
);

// The documents stock scip-python indexes in a checkout, run there as a person runs it: with the
// checkout's own configs, and no pip.
function stockDocuments(checkout: string): string[] {
  const root = tmp();
  const env = join(root, "env.json");
  writeFileSync(env, "[]\n");
  const output = join(root, "index.scip");
  const r = spawnSync(
    process.execPath,
    [
      BIN,
      "index",
      "--cwd",
      checkout,
      "--project-name",
      "observatory",
      "--project-version",
      "0",
      "--output",
      output,
      "--environment",
      env,
      "--quiet",
    ],
    {
      cwd: checkout,
      env: { PATH: dirname(process.execPath), LANG: "C.UTF-8", HOME: root },
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  expect(r.status, r.stderr).toBe(0);
  return decodeScipIndex(readFileSync(output))
    .documents.map((d) => d.relativePath)
    .sort();
}

it(
  "never reads the repository's own Pyright configuration",
  async (ctx) => {
    requireInCI(ctx, SCIP_PYTHON);
    // each of the three configs scip-python takes leaves sim/ out, so a run that read one would
    // index tools/run.py alone (scip-python still indexes a file that an indexed one imports,
    // so nothing here imports sim/)
    const repo = await oneCommit({
      ...SKY,
      "tools/run.py": lines("def run():", "    return 1"),
      "scip-pyrightconfig.json": JSON.stringify({ exclude: ["sim"] }),
      "pyrightconfig.json": JSON.stringify({ exclude: ["sim"] }),
      "pyproject.toml": lines(
        "[project]",
        'name = "observatory"',
        'version = "0.1.0"',
        "",
        "[tool.pyright]",
        'exclude = ["sim"]',
      ),
    });
    // the control: stock scip-python in the checkout reads scip-pyrightconfig.json first, and
    // with neither JSON config there, pyproject.toml's [tool.pyright]
    expect(stockDocuments(repo)).toEqual(["tools/run.py"]);
    const copy = join(tmp(), "checkout");
    cpSync(repo, copy, { recursive: true });
    rmSync(join(copy, "scip-pyrightconfig.json"));
    rmSync(join(copy, "pyrightconfig.json"));
    expect(stockDocuments(copy)).toEqual(["tools/run.py"]);

    const e = await exportOf(repo);
    expect(e.manifest.engineConfigsRemoved).toEqual(["pyrightconfig.json"]);
    const facts = await scipPythonDriver.run(ctxOf(e, null));
    expect([...facts.documents]).toEqual(["sim/sky.py", "tools/run.py"]);
  },
  TIMEOUT,
);

const BOM = String.fromCharCode(0xfeff);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

it(
  "reads positions as Pyright counts them, so that each definition joins its outline and each call binds",
  async (ctx) => {
    requireInCI(ctx, SCIP_PYTHON);
    // Pyright counts a byte order mark as a character, ends a line at LF, CR and CRLF, and
    // reads U+2028 and U+2029 as characters of a line
    const e = await exportOf(
      await oneCommit({
        "sim/bom.py": `${BOM}${lines("def f():", "    return 1", "", "", "def g():", "    return f()")}`,
        "sim/crlf.py": lines(
          "def a():\r",
          "    return 1\r",
          "\r",
          "\r",
          "def b():\r",
          "    return a()\r",
        ),
        "sim/lone.py": "def c():\r    return 1\r\r\rdef d():\r    return c()\n",
        "sim/seps.py": lines(
          `# a${LINE_SEPARATOR}b${PARAGRAPH_SEPARATOR}c`,
          "def h():",
          "    return 2",
          "",
          "",
          "def i():",
          "    return h()",
        ),
      }),
    );
    inStore(await buildAt(e, "deep"), (s) => {
      expect(s.meta.coverage.tiers["scip-python"]).toBe("ran");
      const symbols = symbolsUnder(s, "sim");
      expect(symbols.map((d) => `${d.path}#${d.qualname}`)).toEqual([
        "sim/bom.py#<module>",
        "sim/bom.py#f",
        "sim/bom.py#g",
        "sim/crlf.py#<module>",
        "sim/crlf.py#a",
        "sim/crlf.py#b",
        "sim/lone.py#<module>",
        "sim/lone.py#c",
        "sim/lone.py#d",
        "sim/seps.py#<module>",
        "sim/seps.py#h",
        "sim/seps.py#i",
      ]);
      for (const d of symbols) {
        const name = d.path.slice("sim/".length, -".py".length);
        expect(d.scip_symbol, `${d.path}#${d.qualname}`).toBe(
          d.qualname === "<module>"
            ? `${PKG}\`sim.${name}\`/__init__:`
            : `${PKG}\`sim.${name}\`/${d.qualname}().`,
        );
      }
      for (const [file, callee, target] of [
        ["sim/bom.py", "f", "f"],
        ["sim/crlf.py", "a", "a"],
        ["sim/lone.py", "c", "c"],
        ["sim/seps.py", "h", "h"],
      ]) {
        expect(
          targetsOf(s, file as string, callee as string).map(
            (t) =>
              `${(t as { label: string }).label} ${(t as { qualname: string }).qualname}`,
          ),
          file,
        ).toEqual([`bound ${target}`]);
      }
    });
  },
  TIMEOUT,
);

it(
  "keeps metadata-only Python files, and those Pyright leaves out by default, out of scip-python's facts",
  async (ctx) => {
    requireInCI(ctx, SCIP_PYTHON);
    const e = await exportOf(
      await oneCommit({
        "sim/sky.py": lines(
          "from sim import table_pb2",
          "",
          "",
          "def draw():",
          "    return table_pb2.ROWS",
        ),
        // generated, so metadata-only: Pyright reads it all the same, since sky.py imports it,
        // and scip-python indexes it
        "sim/table_pb2.py": lines(
          "# Code generated by a compiler. DO NOT EDIT.",
          "ROWS = 2",
        ),
        // over the source cap, so metadata-only, and imported by nothing
        "sim/big.py": "X = 1\n".repeat(200_000),
        ".github/tool.py": lines("def tool():", "    return 1"),
        "web/node_modules/pkg/mod.py": lines("def mod():", "    return 1"),
      }),
    );
    expect(e.manifest.metadataOnly).toEqual([
      { path: "sim/big.py", reason: "size" },
      { path: "sim/table_pb2.py", reason: "generated" },
    ]);
    const facts = await scipPythonDriver.run(ctxOf(e, null));
    expect([...facts.documents]).toEqual(["sim/sky.py"]);
    expect(
      [...facts.definitions, ...facts.uses].filter(
        (f) => f.file !== "sim/sky.py",
      ),
    ).toEqual([]);
  },
  TIMEOUT,
);

it(
  "leaves scip-python's duplicate symbols out of the scip-duplicates gate, which checks scip-typescript's",
  async (ctx) => {
    requireInCI(ctx, SCIP_PYTHON);
    // two roots that each hold a loose module x: scip-python names both x, so each symbol of x
    // is defined twice, and a call through one binds neither; and a TypeScript file, so that
    // scip-typescript runs and the gate reads its symbols
    const e = await exportOf(
      await oneCommit({
        "web/orbit.ts": lines("export const period = 1;"),
        "a/x.py": lines("def f():", "    return 1"),
        "b/x.py": lines("def f():", "    return 2"),
        "a/run.py": lines(
          "from x import f",
          "",
          "",
          "def run():",
          "    return f()",
        ),
      }),
      {
        profile: {
          ...PROFILE,
          python: { roots: ["a", "b"], singleFileModules: [] },
        },
      },
    );
    inStore(await buildAt(e, "deep"), (s) => {
      expect(s.meta.coverage.tiers["scip-typescript"]).toBe("ran");
      expect(s.meta.coverage.tiers["scip-python"]).toBe("ran");
      expect(s.meta.gates.find((g) => g.gate === "scip-duplicates")).toEqual({
        gate: "scip-duplicates",
        ok: true,
        detail: "0 duplicate symbols",
      });
      expect(
        symbolsUnder(s, "a")
          .concat(symbolsUnder(s, "b"))
          .filter((d) => d.qualname === "f"),
      ).toEqual([
        { path: "a/x.py", qualname: "f", scip_symbol: `${PKG}x/f().` },
        { path: "b/x.py", qualname: "f", scip_symbol: `${PKG}x/f().` },
      ]);
      // the call falls to the name match through its import, which the first root wins
      expect(targetsOf(s, "a/run.py", "f")).toEqual([
        {
          line: 5,
          col: 12,
          label: "scoped",
          collision: 0,
          qualname: "f",
          file: "a/x.py",
        },
      ]);
      expect(s.meta.coverage.unmatchedBoundUses).toBe(1);
    });
  },
  TIMEOUT,
);
