// The scip-typescript driver against a stand-in engine at the lock's bin path: it records how
// it was run in its working directory, then plays the given part. The facts of a real index
// are pinned by test/oracle/drivers/scip-typescript.test.ts.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { readLock } from "../../../src/engines/index.js";
import { removeTree } from "../../../src/export/index.js";
import type { ExtractContext } from "../../../src/extract/context.js";
import {
  heapMiB,
  scipTypescriptDriver,
} from "../../../src/extract/drivers/scip-typescript.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) removeTree(dir);
});

const BIN = readLock().lock.engines["scip-typescript"].bin;

function standIn(body: string, memoryMax?: string): ExtractContext {
  const root = mkdtempSync(join(tmpdir(), "hakutaku-scip-unit-"));
  made.push(root);
  const enginesDir = join(root, "engines");
  const bin = join(enginesDir, BIN);
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(
    bin,
    [
      'const fs = require("node:fs");',
      "const argv = process.argv.slice(1);",
      "const output = argv[argv.indexOf('--output') + 1];",
      'fs.writeFileSync("record.json", JSON.stringify({ execArgv: process.execArgv, argv, cwd: process.cwd(), env: process.env }));',
      body,
    ].join("\n"),
  );
  const exportDir = join(root, "export");
  mkdirSync(join(exportDir, "snapshot"), { recursive: true });
  const workDir = join(root, "work");
  mkdirSync(workDir);
  return {
    exportDir,
    snapshotDir: join(exportDir, "snapshot"),
    workDir,
    enginesDir,
    detail: "standard",
    noSource: false,
    profile: {} as ExtractContext["profile"],
    rules: null,
    manifest: {} as ExtractContext["manifest"],
    pythonPath: null,
    ...(memoryMax === undefined ? {} : { memoryMax }),
    log: () => {},
  };
}

const record = (ctx: ExtractContext) =>
  JSON.parse(readFileSync(join(ctx.workDir, "record.json"), "utf8"));

const EMPTY_FACTS = {
  documents: new Set(),
  definitions: [],
  uses: [],
  moduleAt: new Map(),
  duplicates: [],
};

it("runs scip-typescript with 80% of the memory cap as Node's heap, the snapshot as --cwd and the export directory as its project, and deletes index.scip", async () => {
  // an empty index: no document
  const ctx = standIn("fs.writeFileSync(output, Buffer.alloc(0));");
  expect(await scipTypescriptDriver.run(ctx)).toStrictEqual(EMPTY_FACTS);
  const run = record(ctx);
  // 3G when the build names no cap: 3,072 MiB, 80% of it
  expect(run.execArgv).toStrictEqual(["--max-old-space-size=2457"]);
  expect(run.argv).toStrictEqual([
    join(ctx.enginesDir, BIN),
    "index",
    "--cwd",
    ctx.snapshotDir,
    "--output",
    join(ctx.workDir, "index.scip"),
    "--no-global-caches",
    "--no-progress-bar",
    // three times hakutaku's source cap, so that no file under the cap is skipped, even one
    // whose invalid bytes TypeScript reads as three-byte U+FFFD
    "--max-file-byte-size",
    "3145728",
    ctx.exportDir,
  ]);
  expect(run.cwd).toBe(realpathSync(ctx.workDir));
  expect(run.env).toStrictEqual({
    PATH: join(ctx.workDir, "bin"),
    HOME: join(ctx.workDir, "home"),
    LANG: "C.UTF-8",
    TMPDIR: join(ctx.workDir, "tmp"),
  });
  expect(existsSync(join(ctx.workDir, "index.scip"))).toBe(false);
  // deep detail's cap
  const deep = standIn("fs.writeFileSync(output, Buffer.alloc(0));", "15G");
  await scipTypescriptDriver.run(deep);
  expect(record(deep).execArgv).toStrictEqual(["--max-old-space-size=12288"]);
});

it.each<[string, string, RegExp]>([
  [
    "its error on stderr",
    'process.stderr.write("\\nError: Cannot find module typescript\\n"); process.exit(1);',
    /^scip-typescript failed: Error: Cannot find module typescript$/,
  ],
  [
    "the error line it prints on stdout",
    'console.log("+ project (3ms)"); console.log("error: no files got indexed. To fix this problem, add files."); process.exit(1);',
    /^scip-typescript failed: error: no files got indexed\. To fix this problem, add files\.$/,
  ],
  [
    "a bare exit code",
    "process.exit(3);",
    /^scip-typescript failed: exit code 3$/,
  ],
  [
    "a signal",
    'process.kill(process.pid, "SIGTERM");',
    /^scip-typescript failed: stopped by SIGTERM$/,
  ],
  [
    // scip-typescript catches an error in one file, prints it, and goes on with exit 0,
    // leaving that file's document partial or missing
    "a file it could not index, with exit 0",
    "fs.writeFileSync(output, Buffer.alloc(0)); console.error(\"unexpected error indexing project root '/x'\", new Error('boom'));",
    /^scip-typescript failed: unexpected error indexing project root '\/x' Error: boom/,
  ],
])("fails with %s, and deletes index.scip", async (_, body, error) => {
  const ctx = standIn(`fs.writeFileSync(output, "partial");\n${body}`);
  await expect(scipTypescriptDriver.run(ctx)).rejects.toThrow(error);
  expect(existsSync(join(ctx.workDir, "index.scip"))).toBe(false);
});

it("fails when scip-typescript leaves no index, or one that does not decode", async () => {
  const none = standIn("");
  await expect(scipTypescriptDriver.run(none)).rejects.toThrow(
    /^scip-typescript failed: cannot read its index \(.*ENOENT.*\)$/,
  );
  const broken = standIn("fs.writeFileSync(output, Buffer.from([0x80]));");
  await expect(scipTypescriptDriver.run(broken)).rejects.toThrow(
    /^index\.scip is not a SCIP index: /,
  );
  expect(existsSync(join(broken.workDir, "index.scip"))).toBe(false);
});

const treeCtx = (
  detail: ExtractContext["detail"],
  tree: Array<[string, string]>,
  metadataOnly: string[] = [],
): ExtractContext =>
  ({
    detail,
    manifest: {
      tree: tree.map(([path, mode]) => ({
        path,
        mode,
        blob: "0".repeat(40),
        bytes: 1,
      })),
      metadataOnly: metadataOnly.map((path) => ({ path, reason: "generated" })),
    },
  }) as unknown as ExtractContext;

it("applies at standard and deep detail when the generated tsconfig lists a TS or JS file", () => {
  const applies = (
    detail: ExtractContext["detail"],
    tree: Array<[string, string]>,
    metadataOnly?: string[],
  ) => scipTypescriptDriver.applies(treeCtx(detail, tree, metadataOnly));
  const ts: Array<[string, string]> = [["src/orbit.ts", "100644"]];
  expect(scipTypescriptDriver.minDetail).toBe("standard");
  expect(applies("quick", ts)).toBe(false);
  expect(applies("standard", ts)).toBe(true);
  expect(applies("deep", ts)).toBe(true);
  expect(applies("standard", [["tools/run.mjs", "100755"]])).toBe(true);
  // no TS or JS, or none the include lists: scip-typescript would exit 1, having indexed nothing
  expect(applies("standard", [])).toBe(false);
  expect(applies("standard", [["sim/sky.py", "100644"]])).toBe(false);
  expect(applies("standard", [[".github/notify.js", "100644"]])).toBe(false);
  expect(applies("standard", [["node_modules/sky/index.js", "100644"]])).toBe(
    false,
  );
  expect(applies("standard", [["web/sky.min.js", "100644"]])).toBe(false);
  expect(applies("standard", [["web/SKY.TS", "100644"]])).toBe(false);
  expect(
    applies("standard", [
      ["web/a.ts", "120000"],
      ["web/b", "160000"],
    ]),
  ).toBe(false);
  expect(applies("standard", [["web/gen.ts", "100644"]], ["web/gen.ts"])).toBe(
    false,
  );
});

it.each<[string, number]>([
  ["3G", 2457],
  ["15G", 12288],
  ["512M", 409],
  ["1.5G", 1228],
  ["2T", 1677721],
  ["3221225472", 2457],
  ["4194304K", 3276],
])("turns the memory cap %s into a heap of %i MiB", (cap, mib) => {
  expect(heapMiB(cap)).toBe(mib);
});

it.each(["", "3 G", "3g", "3GB", "50%", "infinity", "-1G", "G"])(
  "refuses the memory cap %j",
  (cap) => {
    expect(() => heapMiB(cap)).toThrow(
      `scip-typescript: cannot read the memory cap ${JSON.stringify(cap)}`,
    );
  },
);

it("refuses a memory cap that leaves Node no heap", () => {
  expect(() => heapMiB("1K")).toThrow(
    'scip-typescript: the memory cap "1K" leaves Node no heap',
  );
});
