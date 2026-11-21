// The ast-grep driver's run through a stand-in runner: the view of the snapshot it builds in the
// work directory, the command line it gives ast-grep over that view, and the paths it reads back.
// What the real engine finds in a view is pinned by test/oracle/drivers/ast-grep.test.ts.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { type ExportManifest, removeTree } from "../../../src/export/index.js";
import type { ExtractContext } from "../../../src/extract/context.js";
import { astGrepDriver } from "../../../src/extract/drivers/ast-grep.js";
import type { EngineRun, EngineRunResult } from "../../../src/extract/run.js";
import { comparePaths, type GitMode } from "../../../src/model/index.js";
import { DEFAULT_PROFILE } from "../../../src/profile/index.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) removeTree(dir);
});

// A run that ended well: exit 0, nothing on stderr.
const ENDED: EngineRunResult = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  wallMs: 1,
  cpuMs: null,
  peakRssBytes: null,
  stdout: "",
  stderrTail: "",
  stderrCut: false,
  stderrMarked: false,
  heapOutOfMemory: false,
  oomKilled: null,
  startError: null,
};

interface Setup {
  files: Record<string, string>;
  modes?: Record<string, GitMode>;
  metadataOnly?: string[];
  // the stream the stand-in writes, given the directory it was asked to scan
  stream?: (scanned: string) => string;
}

interface Run {
  run: EngineRun;
  // each link under the scanned directory, as the run found them
  links: Record<string, string>;
}

// An export of the given files, a link or a submodule never made on disk, and a context over it
// whose runner records each run and writes the stream it is given, else an empty one.
function standIn(s: Setup): { ctx: ExtractContext; runs: Run[]; root: string } {
  const root = mkdtempSync(join(tmpdir(), "hakutaku-ast-grep-unit-"));
  made.push(root);
  const exportDir = join(root, "export");
  const snapshotDir = join(exportDir, "snapshot");
  mkdirSync(snapshotDir, { recursive: true });
  const paths = Object.keys(s.files).sort(comparePaths);
  for (const path of paths) {
    const mode = s.modes?.[path] ?? "100644";
    if (mode === "120000" || mode === "160000") continue;
    mkdirSync(dirname(join(snapshotDir, path)), { recursive: true });
    writeFileSync(join(snapshotDir, path), s.files[path] ?? "");
  }
  const workDir = join(root, "work");
  mkdirSync(workDir);
  const manifest: ExportManifest = {
    formatVersion: 1,
    id: "observatory",
    commit: "f".repeat(40),
    commitTime: 1767225600,
    ref: "main",
    hakutakuVersion: "0.0.0",
    files: paths.length,
    denied: 0,
    engineConfigsRemoved: [],
    symlinks: [],
    submodules: [],
    refused: [],
    metadataOnly: (s.metadataOnly ?? []).map((path) => ({
      path,
      reason: "generated" as const,
    })),
    tree: paths.map((path) => ({
      path,
      mode: s.modes?.[path] ?? "100644",
      blob: "0".repeat(40),
      bytes: Buffer.byteLength(s.files[path] ?? ""),
    })),
  };
  const runs: Run[] = [];
  const ctx: ExtractContext = {
    exportDir,
    snapshotDir,
    workDir,
    enginesDir: join(root, "engines"),
    detail: "quick",
    noSource: false,
    profile: structuredClone(DEFAULT_PROFILE),
    rules: null,
    manifest,
    pythonPath: null,
    log: () => {},
    runner: async (run) => {
      const scanned = run.argv.at(-1) as string;
      runs.push({ run, links: linksUnder(scanned) });
      writeFileSync(run.stdoutFile as string, s.stream?.(scanned) ?? "");
      return ENDED;
    },
  };
  return { ctx, runs, root };
}

// Each link under dir, by its path relative to dir, with its target. A directory is walked, and
// anything else fails.
function linksUnder(dir: string): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(dir, rel))) {
      const path = rel === "" ? name : `${rel}/${name}`;
      const stat = lstatSync(join(dir, path));
      if (stat.isDirectory()) walk(path);
      else if (stat.isSymbolicLink()) {
        found[path] = readlinkSync(join(dir, path));
      } else throw new Error(`not a link or a directory: ${path}`);
    }
  };
  walk("");
  return found;
}

const NO_FACTS = { defs: [], calls: [], imports: [], computed: [] };

it("scans a view of the snapshot that links each file the rules scan, and nothing else", async () => {
  const { ctx, runs } = standIn({
    files: {
      ".github/ci.sh": "ci() { :; }\n",
      "README.md": "# Sky\n",
      "scripts/prompt.zsh": "prompt() { :; }\n",
      "scripts/run.sh": "run() { :; }\n",
      "sim/sky.py": "def look():\n    pass\n",
      "sim/sky.pyi": "def look() -> None: ...\n",
      "web/gen.ts": "// @generated\nexport const gen = 1;\n",
      "web/gen[1].ts": "export const one = 1;\n",
      "web/link.ts": "",
      "web/orbit.ts": "export function orbit() {}\n",
      "web/vendor": "",
    },
    modes: {
      "scripts/run.sh": "100755",
      "web/link.ts": "120000",
      "web/vendor": "160000",
    },
    metadataOnly: ["web/gen.ts"],
  });
  expect(await astGrepDriver.run(ctx)).toEqual(NO_FACTS);
  const view = join(ctx.workDir, "ast-grep");
  const at = (path: string): string => join(ctx.snapshotDir, path);
  expect(runs).toHaveLength(1);
  // no metadata-only file, link, submodule or file of another extension is in the view
  expect(runs[0]?.links).toEqual({
    ".github/ci.sh": at(".github/ci.sh"),
    "scripts/run.sh": at("scripts/run.sh"),
    "sim/sky.py": at("sim/sky.py"),
    "sim/sky.pyi": at("sim/sky.pyi"),
    "web/gen[1].ts": at("web/gen[1].ts"),
    "web/orbit.ts": at("web/orbit.ts"),
  });
  const run = runs[0]?.run as EngineRun;
  expect(run).toMatchObject({
    engine: "ast-grep",
    cwd: ctx.workDir,
    stdoutFile: join(ctx.workDir, "ast-grep.jsonl"),
  });
  expect(run.argv[0]?.startsWith(`${ctx.enginesDir}/`)).toBe(true);
  // ast-grep follows the view's links, and honours no ignore file
  expect(run.argv.slice(1)).toEqual([
    "scan",
    "--config",
    join(ctx.exportDir, "sgconfig.yml"),
    "--json=stream",
    "--follow",
    "--no-ignore",
    "hidden",
    "--no-ignore",
    "dot",
    "--no-ignore",
    "exclude",
    "--no-ignore",
    "global",
    "--no-ignore",
    "parent",
    "--no-ignore",
    "vcs",
    view,
  ]);
  // the view and the stream are removed once read
  expect(existsSync(view)).toBe(false);
  expect(existsSync(join(ctx.workDir, "ast-grep.jsonl"))).toBe(false);
});

it("gives ast-grep the same command line however many metadata-only files the snapshot holds", async () => {
  const argvOf = async (count: number): Promise<string[]> => {
    const files: Record<string, string> = {
      "web/orbit.ts": "export function orbit() {}\n",
    };
    const metadataOnly: string[] = [];
    for (let i = 0; i < count; i++) {
      files[`web/gen/client${i}.ts`] = "// @generated\n";
      metadataOnly.push(`web/gen/client${i}.ts`);
    }
    const { ctx, runs, root } = standIn({ files, metadataOnly });
    await astGrepDriver.run(ctx);
    expect(Object.keys(runs[0]?.links ?? {})).toEqual(["web/orbit.ts"]);
    return (runs[0]?.run.argv ?? []).map((a) => a.replaceAll(root, "<root>"));
  };
  expect(await argvOf(1000)).toEqual(await argvOf(0));
});

it("builds the view afresh, so a link left in the work directory is never followed", async () => {
  const { ctx, runs, root } = standIn({
    files: { "web/orbit.ts": "export function orbit() {}\n" },
  });
  const outside = join(root, "outside.ts");
  writeFileSync(outside, "export function outside() {}\n");
  const stale = join(ctx.workDir, "ast-grep", "web");
  mkdirSync(stale, { recursive: true });
  symlinkSync(outside, join(stale, "outside.ts"));
  expect(await astGrepDriver.run(ctx)).toEqual(NO_FACTS);
  expect(runs[0]?.links).toEqual({
    "web/orbit.ts": join(ctx.snapshotDir, "web/orbit.ts"),
  });
});

it("refuses a snapshot entry that is not what the tree says, rather than follow it, and runs nothing", async () => {
  const files = {
    "web/orbit.ts": "export function orbit() {}\n",
    "web/sky/map.ts": "export const map = 1;\n",
  };
  const elsewhere = (root: string): string => {
    const dir = join(root, "elsewhere");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "map.ts"), "export const map = 2;\n");
    return dir;
  };
  // a directory on the path, replaced by a link to a directory that holds the same file
  const a = standIn({ files });
  rmSync(join(a.ctx.snapshotDir, "web", "sky"), { recursive: true });
  symlinkSync(elsewhere(a.root), join(a.ctx.snapshotDir, "web", "sky"));
  await expect(astGrepDriver.run(a.ctx)).rejects.toThrow(
    /^the snapshot's web\/sky is not a directory$/,
  );
  expect(a.runs).toEqual([]);
  // the file itself, replaced by a link
  const b = standIn({ files });
  rmSync(join(b.ctx.snapshotDir, "web", "sky", "map.ts"));
  symlinkSync(
    join(elsewhere(b.root), "map.ts"),
    join(b.ctx.snapshotDir, "web", "sky", "map.ts"),
  );
  await expect(astGrepDriver.run(b.ctx)).rejects.toThrow(
    /^the snapshot's web\/sky\/map\.ts is not a regular file$/,
  );
  expect(b.runs).toEqual([]);
  // a file of the tree that the snapshot lacks
  const c = standIn({ files });
  rmSync(join(c.ctx.snapshotDir, "web", "orbit.ts"));
  await expect(astGrepDriver.run(c.ctx)).rejects.toThrow(
    /^cannot read the snapshot's web\/orbit\.ts \(ENOENT\)$/,
  );
  expect(c.runs).toEqual([]);
});

// One stream line: a call of orbit at the start of a file under the scanned directory.
const callLine = (scanned: string, file: string): string => {
  const range = (column: number) => ({
    byteOffset: { start: 0, end: column },
    start: { line: 0, column: 0 },
    end: { line: 0, column },
  });
  return JSON.stringify({
    text: "orbit",
    range: range(5),
    file: `${scanned}/${file}`,
    metaVariables: {
      single: { NAME: { text: "orbit", range: range(5) } },
      multi: {},
      transformed: {},
    },
    ruleId: "ts-call-call",
  });
};

it("reads each match's path below the view, and refuses a match in a metadata-only file", async () => {
  const files = {
    "web/gen.ts": "// @generated\norbit();\n",
    "web/orbit.ts": "orbit();\n",
  };
  const ok = standIn({
    files,
    metadataOnly: ["web/gen.ts"],
    stream: (scanned) => callLine(scanned, "web/orbit.ts"),
  });
  expect((await astGrepDriver.run(ok.ctx)).calls).toEqual([
    {
      file: "web/orbit.ts",
      at: { line: 1, col: 1 },
      callee: "orbit",
      receiver: null,
    },
  ]);
  const bad = standIn({
    files,
    metadataOnly: ["web/gen.ts"],
    stream: (scanned) => callLine(scanned, "web/gen.ts"),
  });
  await expect(astGrepDriver.run(bad.ctx)).rejects.toThrow(
    /^ast-grep failed: it scanned web\/gen\.ts, which is metadata-only$/,
  );
});
