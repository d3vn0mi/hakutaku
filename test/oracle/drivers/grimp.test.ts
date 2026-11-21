// The grimp driver against the installed engine and the pinned Python: run `node
// dist/cli/main.js engines install --yes` once before this file. Each repo is made with
// makeRepo, exported with exportRepo (its profile generated), then grimpDriver.run over the
// export.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import {
  defaultEnginesDir,
  readInstalled,
} from "../../../src/engines/index.js";
import {
  type ExportManifest,
  exportRepo,
  removeTree,
} from "../../../src/export/index.js";
import type { ExtractContext } from "../../../src/extract/context.js";
import {
  type GrimpFacts,
  grimpDriver,
} from "../../../src/extract/drivers/grimp.js";
import { loadProfile, loadRules } from "../../../src/profile/index.js";
import { makeRepo } from "../../helpers/git.js";
import { requireInCI } from "../../helpers/live.js";
import { samplePythonProbe } from "../../helpers/sample.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) removeTree(dir);
});

const DRIVER = fileURLToPath(
  new URL("../../../python/hakutaku_grimp_driver.py", import.meta.url),
);

const lines = (...text: string[]): string => `${text.join("\n")}\n`;
const hop = (importer: string, imported: string, line: number) => ({
  importer,
  imported,
  line,
});

// The pinned Python that grimp was installed for.
function pinnedPython(): string {
  const python = readInstalled(defaultEnginesDir())?.python;
  if (python === null || python === undefined) {
    throw new Error("grimp is not installed: run hakutaku engines install");
  }
  return python;
}

// The context a build gives the driver, over a fresh export of a one-commit repo.
async function exportOf(
  files: Record<string, string | Uint8Array>,
  rules?: object,
): Promise<{ ctx: ExtractContext; logged: string[] }> {
  const repo = await makeRepo({
    commits: [{ date: "2026-03-02T10:00:00Z", files }],
  });
  const root = mkdtempSync(join(tmpdir(), "hakutaku-oracle-grimp-"));
  made.push(root);
  const exportDir = join(root, "export");
  let rulesFile: string | undefined;
  if (rules !== undefined) {
    rulesFile = join(root, "rules.json");
    writeFileSync(rulesFile, JSON.stringify(rules));
  }
  await exportRepo({
    repo,
    ref: "HEAD",
    out: exportDir,
    ...(rulesFile === undefined ? {} : { rules: rulesFile }),
  });
  const manifest = JSON.parse(
    readFileSync(join(exportDir, "export.json"), "utf8"),
  ) as ExportManifest;
  const workDir = join(root, "work");
  mkdirSync(workDir);
  const logged: string[] = [];
  return {
    ctx: {
      exportDir,
      snapshotDir: join(exportDir, "snapshot"),
      workDir,
      enginesDir: defaultEnginesDir(),
      detail: "quick",
      noSource: false,
      profile: loadProfile(join(exportDir, "profile.json")),
      rules:
        rulesFile === undefined
          ? null
          : loadRules(join(exportDir, "rules.json")),
      manifest,
      pythonPath: pinnedPython(),
      log: (line) => logged.push(line),
    },
    logged,
  };
}

const LAYERS = {
  schema: 1,
  layers: [
    {
      name: "sky-layers",
      severity: "error",
      containers: ["observatory"],
      layers: ["a", "b"],
    },
  ],
};

// A package whose b breaks the layers by importing a, and three files that each write a
// marker of their own into markers/ when imported: a json.py and a sitecustomize.py beside the
// package, and the package's own __init__.py.
function sky(markers: string): Record<string, string> {
  const plant = (who: string) =>
    `open(${JSON.stringify(join(markers, who))}, "w").write("imported")`;
  return {
    "sim/src/observatory/__init__.py": lines(
      plant("observatory"),
      "from . import a",
    ),
    "sim/src/observatory/a.py": lines(
      "import json",
      "import numpy.linalg",
      "from observatory import b",
      "from .b import orbit",
    ),
    "sim/src/observatory/b.py": lines(
      "DAYS = 365",
      "def orbit():",
      "    from observatory import a",
      "    return a",
    ),
    "sim/src/json.py": lines(plant("json")),
    "sim/src/sitecustomize.py": lines(plant("sitecustomize")),
  };
}

const markerDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-oracle-grimp-markers-"));
  made.push(dir);
  return dir;
};

it("reads the import graph with lines, and finds the broken layer", async () => {
  const { ctx, logged } = await exportOf(sky(markerDir()), LAYERS);
  expect(grimpDriver.applies(ctx)).toBe(true);
  const want: GrimpFacts = {
    version: "3.18",
    modules: new Set(["observatory", "observatory.a", "observatory.b"]),
    imports: [
      hop("observatory", "observatory.a", 2),
      hop("observatory.a", "json", 1),
      hop("observatory.a", "numpy", 2),
      hop("observatory.a", "observatory.b", 3),
      hop("observatory.a", "observatory.b", 4),
      hop("observatory.b", "observatory.a", 3),
    ],
    external: new Set(["json", "numpy"]),
    layerViolations: [
      {
        name: "sky-layers",
        severity: "error",
        importer: "observatory.b",
        imported: "observatory.a",
        chain: [hop("observatory.b", "observatory.a", 3)],
      },
    ],
  };
  const facts = await grimpDriver.run(ctx);
  expect(facts).toStrictEqual(want);
  expect([...facts.modules]).toStrictEqual([...want.modules]);
  expect(logged).toStrictEqual([]);
}, 300_000);

it("imports nothing from the snapshot", async () => {
  const markers = markerDir();
  const { ctx } = await exportOf(sky(markers), LAYERS);
  // Each planted file writes its marker when Python imports it from the snapshot.
  const root = join(ctx.snapshotDir, "sim", "src");
  for (const name of ["json", "sitecustomize", "observatory"]) {
    execFileSync(pinnedPython(), [
      "-I",
      "-S",
      "-B",
      "-c",
      `import sys; sys.path.insert(0, ${JSON.stringify(root)})\ntry:\n    import ${name}\nexcept Exception:\n    pass`,
    ]);
    expect(existsSync(join(markers, name))).toBe(true);
    for (const written of readdirSync(markers)) rmSync(join(markers, written));
  }
  const facts = await grimpDriver.run(ctx);
  expect(facts.modules.size).toBe(3);
  expect(readdirSync(markers)).toStrictEqual([]);
}, 300_000);

// The real grimp never imports what it reads, so only a stand-in that does shows the driver's
// own guard: once the roots are on sys.path, a module under them is not loaded, whether through
// importlib.import_module, which raises no import audit event, or through __import__.
it("refuses to load a module from the roots once they are on sys.path, however it is imported", (ctx) => {
  requireInCI(ctx, samplePythonProbe());
  const root = mkdtempSync(join(tmpdir(), "hakutaku-oracle-grimp-guard-"));
  made.push(root);
  const marker = join(root, "marker");
  // a grimp whose graph imports the module planted, as a library that imports lazily would
  const engines = join(root, "engines");
  mkdirSync(join(engines, "grimp"), { recursive: true });
  writeFileSync(
    join(engines, "grimp", "__init__.py"),
    lines(
      "import importlib",
      "import sys",
      '__version__ = "0.0.0"',
      "class ImportGraph:",
      "    modules = ()",
      "    def __init__(self):",
      "        for load in (importlib.import_module, __import__):",
      "            try:",
      '                load("planted")',
      "            except ImportError as error:",
      '                sys.stderr.write("refused: %s\\n" % error)',
    ),
  );
  writeFileSync(join(engines, "grimp", "exceptions.py"), "");
  const roots = join(root, "src");
  mkdirSync(roots);
  writeFileSync(
    join(roots, "planted.py"),
    lines(
      `with open(${JSON.stringify(marker)}, "a") as handle:`,
      '    handle.write("imported\\n")',
    ),
  );
  const input = join(root, "input.json");
  writeFileSync(
    input,
    JSON.stringify({
      enginesPython: engines,
      roots: [roots],
      packages: [],
      singleFileModules: [],
      layers: [],
    }),
  );
  const run = spawnSync(pinnedPython(), ["-I", "-S", "-B", DRIVER, input], {
    encoding: "utf8",
    timeout: 60_000,
  });
  const refused =
    "refused: the grimp driver imports nothing once the roots are on sys.path: planted\n";
  expect(run.stderr).toBe(refused + refused);
  expect(run.status).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject({ grimp: "0.0.0", modules: [] });
  expect(existsSync(marker)).toBe(false);
});

it("leaves out a package another root's module, the standard library or grimp holds the name of, and reads the others", async () => {
  const { ctx, logged } = await exportOf({
    "tools/__init__.py": "",
    "tools/cli.py": lines("import observatory", "import email", "import grimp"),
    // at the repo top: the root "." holds the name observatory ahead of sim/src
    "observatory.py": "VERSION = 1\n",
    "sim/src/observatory/__init__.py": "",
    "sim/src/observatory/a.py": "import json\n",
    "sim/src/email/__init__.py": "import json\n",
    "sim/src/grimp/__init__.py": "import json\n",
    "sim/src/stars/__init__.py": "from . import catalog\n",
    "sim/src/stars/catalog.py": "import json\n",
  });
  expect(ctx.profile.python.roots).toStrictEqual([".", "sim/src"]);
  const facts = await grimpDriver.run(ctx);
  expect([...facts.modules]).toStrictEqual([
    "stars",
    "stars.catalog",
    "tools",
    "tools.cli",
  ]);
  expect(facts.imports).toStrictEqual([
    hop("stars", "stars.catalog", 1),
    hop("stars.catalog", "json", 1),
    hop("tools.cli", "email", 2),
    hop("tools.cli", "grimp", 3),
    hop("tools.cli", "observatory", 1),
  ]);
  expect([...facts.external]).toStrictEqual([
    "email",
    "grimp",
    "json",
    "observatory",
  ]);
  const left = (dir: string, why: string) =>
    `grimp: left out the package ${dir}: ${why}; hakutaku's resolver reads its imports`;
  expect(logged).toStrictEqual([
    left("sim/src/email", "the standard library holds the name email"),
    left("sim/src/grimp", "grimp itself holds the name grimp"),
    left(
      "sim/src/observatory",
      "observatory.py holds the name observatory under the profile's roots",
    ),
  ]);
}, 300_000);

it("keeps a metadata-only file's content out of grimp, while imports of it still name it", async () => {
  const { ctx } = await exportOf({
    "sim/src/observatory/__init__.py": "",
    "sim/src/observatory/a.py": lines(
      "from observatory import catalog",
      "from . import big",
    ),
    "sim/src/observatory/catalog.py": lines(
      "# Code generated by skygen. DO NOT EDIT.",
      "import skygen_runtime",
    ),
    // over the 1,048,576-byte source cap
    "sim/src/observatory/big.py": `import starfield\n${"x = 1\n".repeat(180_000)}`,
  });
  expect(ctx.manifest.metadataOnly).toStrictEqual([
    { path: "sim/src/observatory/big.py", reason: "size" },
    { path: "sim/src/observatory/catalog.py", reason: "generated" },
  ]);
  const facts = await grimpDriver.run(ctx);
  expect([...facts.modules]).toStrictEqual(["observatory", "observatory.a"]);
  expect(facts.imports).toStrictEqual([
    hop("observatory.a", "observatory.big", 2),
    hop("observatory.a", "observatory.catalog", 1),
  ]);
  expect([...facts.external]).toStrictEqual([]);
}, 300_000);

it("reads past the files grimp cannot parse or decode, and names them", async () => {
  const { ctx, logged } = await exportOf({
    "sim/src/observatory/__init__.py": "",
    "sim/src/observatory/a.py": "import json\n",
    "sim/src/observatory/broken.py": lines("import numpy", "def (:"),
    // Latin-1 without a coding line
    "sim/src/observatory/latin.py": Uint8Array.from([
      ...Buffer.from("import os\nname = '"),
      0xe9,
      ...Buffer.from("toile'\n"),
    ]),
    "sim/src/observatory/blob.py": Uint8Array.from([
      ...Buffer.from("import sys\n"),
      0x00,
      0x01,
      0x0a,
    ]),
    "sim/src/observatory/old.py": lines("import json", "print 'sky'"),
  });
  const facts = await grimpDriver.run(ctx);
  expect([...facts.modules]).toStrictEqual(["observatory", "observatory.a"]);
  expect(facts.imports).toStrictEqual([hop("observatory.a", "json", 1)]);
  expect([...facts.external]).toStrictEqual(["json"]);
  const said = (path: string, reason: string) =>
    `grimp: could not read sim/src/observatory/${path} (${reason}); hakutaku's resolver reads its imports`;
  expect(logged).toStrictEqual([
    said("blob.py", "a syntax error at line 2"),
    said("broken.py", "a syntax error at line 2"),
    said("latin.py", "bytes it cannot decode"),
    said("old.py", "a syntax error at line 2"),
  ]);
}, 300_000);

it("reads a single-file module's imports with ast, and joins the package's imports of it", async () => {
  const { ctx } = await exportOf({
    "sim/src/observatory/__init__.py": "",
    "sim/src/observatory/a.py": lines(
      "import skyctl",
      "import skyctl.extra",
      // climbs past the top package: grimp names the empty module, which no import keeps
      "from .. import up",
    ),
    "tools/pyproject.toml": '[tool.setuptools]\npy-modules = ["skyctl"]\n',
    "tools/skyctl.py": lines(
      "from __future__ import annotations",
      "import json",
      "import observatory.a",
      "from observatory import a, missing",
      "from .sky import nothing",
      "import astropy.units as u",
      "def load():",
      "    import skyfield",
    ),
  });
  expect(ctx.profile.python.singleFileModules).toStrictEqual([
    "tools/skyctl.py",
  ]);
  const facts = await grimpDriver.run(ctx);
  expect([...facts.modules]).toStrictEqual([
    "observatory",
    "observatory.a",
    "skyctl",
  ]);
  expect(facts.imports).toStrictEqual([
    hop("observatory.a", "skyctl", 1),
    hop("observatory.a", "skyctl", 2),
    hop("skyctl", "__future__", 1),
    hop("skyctl", "astropy", 6),
    hop("skyctl", "json", 2),
    hop("skyctl", "observatory", 4),
    hop("skyctl", "observatory.a", 3),
    hop("skyctl", "observatory.a", 4),
    // an import inside a function counts too
    hop("skyctl", "skyfield", 8),
  ]);
  expect([...facts.external]).toStrictEqual([
    "__future__",
    "astropy",
    "json",
    "skyfield",
  ]);
}, 300_000);

it("finds each chain through a module outside the layers, and skips a contract it cannot check, saying why", async () => {
  const { ctx, logged } = await exportOf(
    {
      "sim/src/observatory/__init__.py": "",
      "sim/src/observatory/high.py": "LEVEL = 2\n",
      "sim/src/observatory/mid.py": lines(
        "import json",
        "from observatory import high",
        "import observatory.high",
      ),
      "sim/src/observatory/low/__init__.py": "",
      "sim/src/observatory/low/near.py": "from observatory import mid\n",
      "sim/src/observatory/low/far.py": lines(
        "DAYS = 1",
        "from observatory import mid",
      ),
    },
    {
      schema: 1,
      layers: [
        {
          name: "no-container",
          severity: "warn",
          containers: ["observatory.nope"],
          layers: ["high", "low"],
        },
        {
          name: "twice",
          severity: "warn",
          containers: ["observatory"],
          layers: ["high", "high"],
        },
        {
          name: "sky-layers",
          severity: "error",
          containers: ["observatory"],
          layers: ["high", "low"],
        },
      ],
    },
  );
  const facts = await grimpDriver.run(ctx);
  // one chain for each module of the lower layer, each import at its first line
  expect(facts.layerViolations).toStrictEqual([
    {
      name: "sky-layers",
      severity: "error",
      importer: "observatory.low.far",
      imported: "observatory.high",
      chain: [
        hop("observatory.low.far", "observatory.mid", 2),
        hop("observatory.mid", "observatory.high", 2),
      ],
    },
    {
      name: "sky-layers",
      severity: "error",
      importer: "observatory.low.near",
      imported: "observatory.high",
      chain: [
        hop("observatory.low.near", "observatory.mid", 1),
        hop("observatory.mid", "observatory.high", 2),
      ],
    },
  ]);
  expect(logged).toStrictEqual([
    "grimp: did not check the layers contract no-container: its container observatory.nope is not a module grimp read",
    "grimp: did not check the layers contract twice: Modules can only belong to one layer, but the following appear in more than one: 'high'.",
  ]);
}, 300_000);

// The driver's own last check, run directly: hakutaku never hands it a package whose name the
// standard library holds by its lists, but a module newer than those lists could still find one.
it("leaves out a package Python finds elsewhere first, and builds an empty graph when none is left", () => {
  const root = mkdtempSync(join(tmpdir(), "hakutaku-oracle-grimp-direct-"));
  made.push(root);
  const view = join(root, "view");
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(view, path)), { recursive: true });
    writeFileSync(join(view, path), text);
  };
  write("json/__init__.py", "import os\n");
  write("stars/__init__.py", "");
  write("stars/catalog.py", "import json\n");
  const run = (packages: string[]) => {
    const input = join(root, `input-${packages.length}.json`);
    writeFileSync(
      input,
      JSON.stringify({
        enginesPython: join(resolve(defaultEnginesDir()), "python"),
        roots: [view],
        packages,
        singleFileModules: [],
        layers: [
          {
            name: "sky-layers",
            severity: "warn",
            containers: ["json"],
            layers: ["a", "b"],
          },
        ],
      }),
    );
    return JSON.parse(
      execFileSync(pinnedPython(), ["-I", "-S", "-B", DRIVER, input], {
        cwd: root,
        encoding: "utf8",
      }),
    );
  };
  const leftOut = expect.stringMatching(
    /^left out the package json: Python imports that name from \/.+\/json\/__init__\.py$/,
  );
  const unchecked =
    "did not check the layers contract sky-layers: its container json is not a module grimp read";
  expect(run(["json", "stars"])).toStrictEqual({
    grimp: "3.18",
    modules: ["stars", "stars.catalog"],
    imports: [{ importer: "stars.catalog", imported: "json", line: 1 }],
    external: ["json"],
    layerViolations: [],
    unreadable: [],
    warnings: [leftOut, unchecked],
  });
  expect(run(["json"])).toStrictEqual({
    grimp: "3.18",
    modules: [],
    imports: [],
    external: [],
    layerViolations: [],
    unreadable: [],
    warnings: [leftOut, unchecked],
  });
});

// Python's path holds the roots only after the driver and grimp have imported all they need, and
// behind the standard library, so a package in a root named like a module grimp imports never
// stands in for it.
it("puts its roots on Python's path only after grimp is imported, behind the standard library", () => {
  const root = mkdtempSync(join(tmpdir(), "hakutaku-oracle-grimp-order-"));
  made.push(root);
  const markers = markerDir();
  const view = join(root, "view");
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(view, path)), { recursive: true });
    writeFileSync(join(view, path), text);
  };
  // dataclasses: a module grimp imports, which Python has not loaded at start
  write(
    "dataclasses/__init__.py",
    `open(${JSON.stringify(join(markers, "dataclasses"))}, "w").write("imported")\n`,
  );
  write("stars/__init__.py", "import dataclasses\n");
  // csv: a standard-library module that neither the driver nor grimp has imported, which Python
  // therefore looks for along its path
  write("csv/__init__.py", "");
  // the plant writes its marker when Python finds it ahead of the standard library
  execFileSync(pinnedPython(), [
    "-I",
    "-S",
    "-B",
    "-c",
    `import sys; sys.path.insert(0, ${JSON.stringify(view)})\nimport dataclasses`,
  ]);
  expect(readdirSync(markers)).toStrictEqual(["dataclasses"]);
  rmSync(join(markers, "dataclasses"));
  const input = join(root, "input.json");
  writeFileSync(
    input,
    JSON.stringify({
      enginesPython: join(resolve(defaultEnginesDir()), "python"),
      roots: [view],
      packages: ["csv", "stars"],
      singleFileModules: [],
      layers: [],
    }),
  );
  const out = JSON.parse(
    execFileSync(pinnedPython(), ["-I", "-S", "-B", DRIVER, input], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  expect(out.modules).toStrictEqual(["stars"]);
  expect(out.external).toStrictEqual(["dataclasses"]);
  expect(out.warnings).toStrictEqual([
    expect.stringMatching(
      /^left out the package csv: Python imports that name from \/.+\/csv\.py$/,
    ),
  ]);
  expect(out.warnings[0]).not.toContain(view);
  expect(readdirSync(markers)).toStrictEqual([]);
});
