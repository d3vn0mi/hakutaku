// Deep detail: the memory cap a deep build takes, and the scip-python driver against a stand-in
// engine at the lock's bin path, which records how it was run, then plays the given part. The
// facts of a real index are pinned by test/oracle/drivers/scip-python.test.ts.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { readLock, resolveBin } from "../../../src/engines/index.js";
import {
  type ExportManifest,
  exportRepo,
  removeTree,
} from "../../../src/export/index.js";
import type { ExtractContext } from "../../../src/extract/context.js";
import { scipPythonDriver } from "../../../src/extract/drivers/scip-python.js";
import {
  defaultMemoryMax,
  extractSnapshot,
} from "../../../src/extract/index.js";
import { systemdRunArgv } from "../../../src/extract/sandbox.js";
import type { Detail } from "../../../src/model/index.js";
import {
  type BuildFacts,
  type Coverage,
  openStore,
  readBuildFacts,
} from "../../../src/store/index.js";
import { makeRepo } from "../../helpers/git.js";
import { fakeInstall, writeScript } from "../engines/fake.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) removeTree(dir);
});

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-deep-"));
  made.push(dir);
  return dir;
};

const { lock } = readLock();
const BIN = lock.engines["scip-python"]?.bin ?? "";

const lines = (...text: string[]): string => `${text.join("\n")}\n`;

// A stand-in scip-python: it records how it was run into the file `record`, then runs body,
// with fs and output, the path it was given as --output, in scope.
const standInScript = (record: string, body: string): string =>
  [
    'const fs = require("node:fs");',
    "const argv = process.argv.slice(1);",
    'const output = argv[argv.indexOf("--output") + 1];',
    `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ execArgv: process.execArgv, argv, cwd: process.cwd(), env: process.env }));`,
    body,
  ].join("\n");

// An empty index: no document.
const EMPTY_INDEX = "fs.writeFileSync(output, Buffer.alloc(0));";

const EMPTY_FACTS = {
  documents: new Set(),
  definitions: [],
  uses: [],
  moduleAt: new Map(),
  duplicates: [],
};

// A module of no package: Python for scip-python to read, and nothing a stand-in engine must
// answer for.
const SKY = {
  "sim/sky.py": lines("class Sky:", "    def draw(self):", "        return 1"),
};

// An export's manifest, as much of it as the driver reads: the repo's id and its tree, each
// file a regular one.
function manifestOf(
  files: Record<string, string>,
  metadataOnly: string[] = [],
): ExportManifest {
  return {
    id: "observatory",
    tree: Object.keys(files).map((path) => ({
      path,
      mode: "100644",
      blob: "0".repeat(40),
      bytes: 0,
    })),
    metadataOnly: metadataOnly.map((path) => ({ path, reason: "size" })),
  } as unknown as ExportManifest;
}

interface StandIn {
  ctx: ExtractContext;
  record: string;
}

// A deep build's context over a snapshot holding files, the export's Pyright config and empty
// environment beside it, and a stand-in scip-python that records its run and plays body.
function standIn(
  body: string,
  opts: {
    files?: Record<string, string>;
    metadataOnly?: string[];
    pythonPath?: string | null;
    timeoutMs?: number;
  } = {},
): StandIn {
  const root = tmp();
  const enginesDir = join(root, "engines");
  const bin = join(enginesDir, BIN);
  mkdirSync(dirname(bin), { recursive: true });
  const record = join(root, "record.json");
  writeFileSync(bin, standInScript(record, body));
  const exportDir = join(root, "export");
  const snapshotDir = join(exportDir, "snapshot");
  const files = opts.files ?? SKY;
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(snapshotDir, path)), { recursive: true });
    writeFileSync(join(snapshotDir, path), text);
  }
  writeFileSync(join(exportDir, "pyrightconfig.json"), "{}\n");
  writeFileSync(join(exportDir, "empty-env.json"), "[]\n");
  const workDir = join(root, "work");
  mkdirSync(workDir);
  return {
    record,
    ctx: {
      exportDir,
      snapshotDir,
      workDir,
      enginesDir,
      detail: "deep",
      noSource: false,
      profile: {} as ExtractContext["profile"],
      rules: null,
      manifest: manifestOf(files, opts.metadataOnly),
      pythonPath: opts.pythonPath ?? null,
      memoryMax: "15G",
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      log: () => {},
    },
  };
}

const recorded = (s: StandIn) => JSON.parse(readFileSync(s.record, "utf8"));

it("caps a deep build at 15G of memory, the cap its sandbox applies with no swap and its engines' heaps are cut from", async () => {
  expect(defaultMemoryMax("deep")).toBe("15G");
  expect(defaultMemoryMax("standard")).toBe("3G");
  expect(defaultMemoryMax("quick")).toBe("3G");
  // the sandbox caps the build there, and with no swap a build at the cap fails at once
  const argv = systemdRunArgv(
    {
      exportDir: "/srv/observatory/export",
      enginesDir: "/srv/observatory/engines",
      workDir: "/srv/observatory/store/work.tmp-4242",
      packageRoot: "/srv/hakutaku",
      nodePrefix: "/srv/node",
      pythonPrefix: null,
      memoryMax: defaultMemoryMax("deep"),
    },
    ["true"],
  );
  const at = argv.indexOf("MemoryMax=15G");
  expect(argv.slice(at - 1, at + 3)).toEqual([
    "-p",
    "MemoryMax=15G",
    "-p",
    "MemorySwapMax=0",
  ]);

  // A deep build given no cap: scip-python gets 80% of 15G as Node's heap. The engines are
  // stand-ins: an ast-grep that matches nothing, and the recording scip-python.
  const root = tmp();
  const engines = fakeInstall({ python: false, deep: true });
  writeScript(resolveBin(engines, lock.engines["ast-grep"].bin), "exit 0");
  const record = join(root, "scip-python.json");
  writeFileSync(resolveBin(engines, BIN), standInScript(record, EMPTY_INDEX));
  const repo = await makeRepo({
    commits: [{ date: "2026-03-02T10:00:00Z", files: SKY }],
  });
  const dir = join(root, "export");
  await exportRepo({ repo, ref: "HEAD", out: dir, id: "observatory" });
  const build = async (
    detail: Detail,
  ): Promise<{ tiers: Coverage["tiers"]; facts: BuildFacts | null }> => {
    const out = join(root, detail, "store.sqlite");
    const result = await extractSnapshot({
      dir,
      out,
      enginesDir: engines,
      detail,
      sandbox: "none",
    });
    expect(result.result).toBe("built");
    const store = openStore(out);
    if ("code" in store) throw new Error(`${out}: ${store.reason}`);
    try {
      return { tiers: store.meta.coverage.tiers, facts: readBuildFacts(out) };
    } finally {
      store.close();
    }
  };
  const deep = await build("deep");
  expect(JSON.parse(readFileSync(record, "utf8")).execArgv).toStrictEqual([
    "--max-old-space-size=12288",
  ]);
  expect(deep.tiers["scip-python"]).toBe("ran");
  expect(deep.facts?.engines["scip-python"]?.status).toBe("ran");
  // standard detail runs no scip-python, and says it was skipped
  rmSync(record);
  const standard = await build("standard");
  expect(existsSync(record)).toBe(false);
  expect(standard.tiers["scip-python"]).toBe("skipped");
  expect(standard.facts?.engines["scip-python"]?.status).toBe("skipped");
});

it("fails a deep build whose engines lack scip-python, naming the deep install", async () => {
  const root = tmp();
  const repo = await makeRepo({
    commits: [{ date: "2026-03-02T10:00:00Z", files: SKY }],
  });
  const dir = join(root, "export");
  await exportRepo({ repo, ref: "HEAD", out: dir, id: "observatory" });
  // installed without --deep: every engine but scip-python; the message names the engines
  // directory by its token, as every message of a build does
  const engines = fakeInstall({ python: false });
  await expect(
    extractSnapshot({
      dir,
      out: join(root, "store", "store.sqlite"),
      enginesDir: engines,
      detail: "deep",
      sandbox: "none",
    }),
  ).rejects.toThrow(
    `the engines are not ready (scip-python missing at <engines>/${BIN}); run hakutaku engines install --deep`,
  );
});

it("runs scip-python from the export directory over the snapshot, with the export's Pyright config, an empty environment and the pinned Python alone on its PATH, and deletes index.scip", async () => {
  const s = standIn(EMPTY_INDEX, { pythonPath: "/srv/python/bin/python3.12" });
  expect(await scipPythonDriver.run(s.ctx)).toStrictEqual(EMPTY_FACTS);
  const run = recorded(s);
  // 80% of the 15G cap as Node's heap
  expect(run.execArgv).toStrictEqual(["--max-old-space-size=12288"]);
  expect(run.argv).toStrictEqual([
    join(s.ctx.enginesDir, BIN),
    "index",
    "--cwd",
    s.ctx.exportDir,
    // documents are named below the snapshot, as repo paths
    "--target-only",
    s.ctx.snapshotDir,
    // a name and a version given, so that it reads no pyproject.toml and asks no git
    "--project-name",
    "observatory",
    "--project-version",
    ".",
    "--output",
    join(s.ctx.workDir, "index.scip"),
    // so that it runs no pip to list installed packages
    "--environment",
    join(s.ctx.exportDir, "empty-env.json"),
  ]);
  expect(run.cwd).toBe(realpathSync(s.ctx.exportDir));
  expect(run.env).toStrictEqual({
    PATH: join(s.ctx.workDir, "bin"),
    HOME: join(s.ctx.workDir, "home"),
    LANG: "C.UTF-8",
    TMPDIR: join(s.ctx.workDir, "tmp"),
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  });
  // Pyright asks python3, then python, on PATH for its search paths: each is the pinned one
  for (const name of ["python3", "python"]) {
    expect(readlinkSync(join(s.ctx.workDir, "bin", name))).toBe(
      "/srv/python/bin/python3.12",
    );
  }
  expect(existsSync(join(s.ctx.workDir, "index.scip"))).toBe(false);
});

it("applies at deep detail alone, to a snapshot holding a Python file that Pyright reads", () => {
  const applies = (
    detail: Detail,
    files: Record<string, string>,
    metadataOnly: string[] = [],
  ): boolean =>
    scipPythonDriver.applies({
      ...standIn(EMPTY_INDEX).ctx,
      detail,
      manifest: manifestOf(files, metadataOnly),
    });
  expect(scipPythonDriver.minDetail).toBe("deep");
  expect(applies("quick", SKY)).toBe(false);
  expect(applies("standard", SKY)).toBe(false);
  expect(applies("deep", SKY)).toBe(true);
  expect(applies("deep", { "sim/sky.pyi": "class Sky: ...\n" })).toBe(true);
  expect(applies("deep", { "README.md": "# Sky\n" })).toBe(false);
  expect(applies("deep", { "sim/big.py": "X = 1\n" }, ["sim/big.py"])).toBe(
    false,
  );
  // what Pyright leaves out by default: a dot directory or file, node_modules and __pycache__;
  // and its extensions in lower case only
  for (const path of [
    ".github/tool.py",
    "sim/.hidden.py",
    "web/node_modules/pkg/mod.py",
    "sim/__pycache__/sky.py",
    "sim/SKY.PY",
  ]) {
    expect(applies("deep", { [path]: "X = 1\n" }), path).toBe(false);
  }
});

it.each<[string, string, RegExp, boolean]>([
  [
    "its fatal error on stderr",
    'console.warn("\\n\\nExperienced Fatal Error While Indexing:\\nPlease create an issue at github.com/sourcegraph/scip-python:", "a parse failure"); process.exit(1);',
    /^scip-python failed: exit code 1\nExperienced Fatal Error While Indexing:\nPlease create an issue at github\.com\/sourcegraph\/scip-python: a parse failure$/,
    false,
  ],
  [
    "a signal",
    'process.kill(process.pid, "SIGTERM");',
    /^scip-python failed: stopped by SIGTERM$/,
    false,
  ],
  [
    // Node aborts once it says so; the stand-in exits as an abort through a shell would, so
    // that no core is dumped
    "its heap running out, which a larger memory cap repairs",
    'process.stderr.write("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\\n"); process.exit(134);',
    /^scip-python failed: ran out of JavaScript heap; rebuild with a larger --memory-max\nFATAL ERROR: Reached heap limit/,
    true,
  ],
])("fails as the other engines do on %s", async (_, body, message, memory) => {
  const { ctx } = standIn(body);
  const failed = scipPythonDriver.run(ctx);
  await expect(failed).rejects.toThrow(message);
  await expect(failed).rejects.toMatchObject({ end: { memory } });
});

it("fails after its timeout", async () => {
  const { ctx } = standIn("setTimeout(() => {}, 60_000);", { timeoutMs: 300 });
  await expect(scipPythonDriver.run(ctx)).rejects.toThrow(
    /^scip-python failed: timed out after 0\.3 s$/,
  );
});

it("fails when its analysis failed part-way, which it reports among its progress lines before it exits 0", async () => {
  const { ctx } = standIn(
    [
      'console.log("(10:00:00) Parse and search for dependencies");',
      'console.log("(10:00:01)   Analysis partially failed with (0/100): RangeError: Maximum call stack size exceeded");',
      EMPTY_INDEX,
    ].join("\n"),
  );
  await expect(scipPythonDriver.run(ctx)).rejects.toThrow(
    /^scip-python failed: its analysis failed part-way\nAnalysis partially failed with \(0\/100\): RangeError: Maximum call stack size exceeded$/,
  );
  // the index it wrote anyway is deleted
  expect(existsSync(join(ctx.workDir, "index.scip"))).toBe(false);
});

// A small protobuf encoder for an index of documents, its fields numbered as the schema numbers
// them: Index's documents 2; Document's relative_path 1 and occurrences 2; Occurrence's range 1,
// symbol 2 and symbol_roles 3.
const utf8 = new TextEncoder();
function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}
const len = (field: number, payload: number[]): number[] => [
  ...varint(field * 8 + 2),
  ...varint(payload.length),
  ...payload,
];
const str = (field: number, s: string): number[] =>
  len(field, [...utf8.encode(s)]);
const occurrence = (range: number[], symbol: string, roles: number) => [
  ...len(1, range.flatMap(varint)),
  ...str(2, symbol),
  ...varint(3 * 8),
  ...varint(roles),
];
const scipDocument = (path: string, occurrences: number[][]): number[] =>
  len(2, [...str(1, path), ...occurrences.flatMap((o) => len(2, o))]);

it("reads its index as Pyright counts positions, and drops the facts of a metadata-only file that an indexed file imports", async () => {
  const py = "scip-python python observatory . ";
  const files = {
    // Pyright counts the byte order mark: sim starts at character 6
    "sim/sky.py": `${String.fromCodePoint(0xfeff)}from sim import table_pb2\n`,
    // generated, so metadata-only; Pyright reads it once sky.py imports it
    "sim/table_pb2.py": lines(
      "# Code generated by a compiler. DO NOT EDIT.",
      "ROWS = 2",
    ),
  };
  const index = [
    ...scipDocument("sim/sky.py", [
      occurrence([0, 0, 0], `${py}\`sim.sky\`/__init__:`, 1),
      occurrence([0, 6, 9], `${py}sim/__init__:`, 8),
    ]),
    ...scipDocument("sim/table_pb2.py", [
      occurrence([0, 0, 0], `${py}\`sim.table_pb2\`/__init__:`, 1),
      occurrence([1, 0, 4], `${py}\`sim.table_pb2\`/ROWS.`, 1),
    ]),
  ];
  const s = standIn(
    `fs.writeFileSync(output, Buffer.from(${JSON.stringify(index)}));`,
    { files, metadataOnly: ["sim/table_pb2.py"] },
  );
  expect(await scipPythonDriver.run(s.ctx)).toStrictEqual({
    documents: new Set(["sim/sky.py"]),
    definitions: [
      {
        file: "sim/sky.py",
        at: { line: 1, col: 1 },
        symbol: `${py}\`sim.sky\`/__init__:`,
      },
    ],
    uses: [
      {
        file: "sim/sky.py",
        at: { line: 1, col: 7 },
        symbol: `${py}sim/__init__:`,
        roles: 8,
      },
    ],
    moduleAt: new Map(),
    duplicates: [],
  });
});

it("fails when it leaves no index", async () => {
  const { ctx } = standIn("");
  await expect(scipPythonDriver.run(ctx)).rejects.toThrow(
    /^scip-python failed: cannot read its index \(ENOENT/,
  );
});

it("runs nothing over an export without its generated Pyright config and empty environment", async () => {
  for (const name of ["pyrightconfig.json", "empty-env.json"]) {
    for (const link of [false, true]) {
      const s = standIn(EMPTY_INDEX);
      const path = join(s.ctx.exportDir, name);
      rmSync(path);
      if (link) {
        // a link, even to a file of the right content, is not the file export writes
        const target = join(dirname(s.ctx.exportDir), "elsewhere.json");
        writeFileSync(target, name === "empty-env.json" ? "[]\n" : "{}\n");
        symlinkSync(target, path);
      }
      await expect(scipPythonDriver.run(s.ctx), name).rejects.toThrow(
        `scip-python failed: the export has no ${name} of its own; export the repository again`,
      );
      expect(existsSync(s.record), name).toBe(false);
    }
  }
});
