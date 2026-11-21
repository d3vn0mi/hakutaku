// The ast-grep driver against the installed engine: run `node dist/cli/main.js engines install
// --yes` once before this file. A repo made with makeRepo, exported with exportRepo, then
// astGrepDriver.run over the export.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { defaultEnginesDir } from "../../../src/engines/index.js";
import {
  type ExportManifest,
  exportRepo,
  removeTree,
} from "../../../src/export/index.js";
import type { ExtractContext } from "../../../src/extract/context.js";
import {
  type AstGrepFacts,
  astGrepDriver,
} from "../../../src/extract/drivers/ast-grep.js";
import type { Pos } from "../../../src/extract/facts.js";
import { loadProfile } from "../../../src/profile/index.js";
import { makeRepo } from "../../helpers/git.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) removeTree(dir);
});

const lines = (...text: string[]): string => `${text.join("\n")}\n`;

const ORBIT = lines(
  'import type { Body } from "./body";',
  "export class Orbit {",
  "  position(t: number): number {",
  "    return t;",
  "  }",
  "  private drift(): void {",
  "    this.position(0);",
  "  }",
  "}",
  "export function solve(a: number): number;",
  "export function solve(a: string): string;",
  "export function solve(a: unknown): unknown {",
  "  return a;",
  "}",
  "export const G = 6.674e-11;",
  "const helper = () => 1;",
  "export { helper };",
  "export async function load(name: string, o: Orbit, b: Body) {",
  '  const m = await import("./sky");',
  `  const p = await import(\`./\${name}\`);`, // a computed import: the file holds ${name}
  "  o.position(1);",
  "  return [m, p, b];",
  "}",
);

// é and an astral emoji before a definition and a call on the same line: a version that
// counts columns in bytes, or in UTF-16 units, moves both.
const STARS_LINE =
  'const label = "é😀"; export function twinkle(): string { return label.at(0); }';

const SKY = lines(
  "from functools import cache",
  "",
  "MAX_STARS = 9",
  "",
  "class Sky:",
  "    def show(self):",
  "        self.draw()",
  "",
  "    def draw(self):",
  "        return MAX_STARS",
  "",
  "def outer():",
  "    def inner():",
  "        return 1",
  "    return inner()",
  "",
  "@cache",
  "def look():",
  "    return Sky().show()",
);

const SYNC = lines(
  "#!/usr/bin/env bash",
  "sync() {",
  '  echo "syncing"',
  "}",
  "source ./lib.sh",
  "sync",
);

const GENERATED = (name: string): string =>
  lines("// @generated", `export function ${name}() { return ${name}(); }`);

async function extractSample(): Promise<{
  facts: AstGrepFacts;
  manifest: ExportManifest;
  workDir: string;
}> {
  const repo = await makeRepo({
    commits: [
      {
        date: "2026-03-02T10:00:00Z",
        files: {
          "web/orbit.ts": ORBIT,
          "web/body.ts": "export interface Body { mass: number }\n",
          "web/sky.ts": "export const sky = 1;\n",
          "web/stars.ts": `${STARS_LINE}\n`,
          // an import whose names sit on the lines above its specifier
          "web/view.ts": lines(
            "import {",
            "  Orbit,",
            "  solve,",
            '} from "./orbit";',
          ),
          "sim/sky.py": SKY,
          "scripts/sync.sh": SYNC,
          "scripts/lib.sh": "log() { :; }\n",
          // an ignore file ast-grep must not honour, and a hidden directory it must enter
          ".ignore": "*.py\n*.sh\n",
          ".github/scripts/ci.sh": "ci() { :; }\n",
          // a shell file outside hakutaku's extensions, which the Bash rules must not read
          "scripts/prompt.zsh": "prompt() { :; }\n",
          // metadata-only files whose names an unescaped glob would misread, and the decoys
          // such a glob would also hit
          "web/gen[1].ts": GENERATED("genOne"),
          "web/{a,b}.ts": GENERATED("genAB"),
          "web/gen1.ts": "export function decoyOne() {}\n",
          "web/a.ts": "export function decoyA() {}\n",
        },
      },
    ],
  });
  const ctx = await exportOf(repo);
  expect(astGrepDriver.applies(ctx)).toBe(true);
  return {
    facts: await astGrepDriver.run(ctx),
    manifest: ctx.manifest,
    workDir: ctx.workDir,
  };
}

// The context a build gives the driver, over a fresh export of repo.
async function exportOf(repo: string): Promise<ExtractContext> {
  const root = mkdtempSync(join(tmpdir(), "hakutaku-oracle-ast-grep-"));
  made.push(root);
  const exportDir = join(root, "export");
  await exportRepo({ repo, ref: "HEAD", out: exportDir });
  const manifest = JSON.parse(
    readFileSync(join(exportDir, "export.json"), "utf8"),
  ) as ExportManifest;
  const workDir = join(root, "work");
  mkdirSync(workDir);
  return {
    exportDir,
    snapshotDir: join(exportDir, "snapshot"),
    workDir,
    enginesDir: defaultEnginesDir(),
    detail: "quick",
    noSource: false,
    profile: loadProfile(join(exportDir, "profile.json")),
    rules: null,
    manifest,
    pythonPath: null,
    log: () => {},
  };
}

const smallRepo = (): Promise<string> =>
  makeRepo({
    commits: [
      {
        date: "2026-03-02T10:00:00Z",
        files: {
          "web/orbit.ts": "export function orbit() {}\n",
          "sim/sky.py": "def look():\n    pass\n",
        },
      },
    ],
  });

const P = (line: number, col: number): Pos => ({ line, col });
// The 1-based code-point column of the first needle on a line.
const colOf = (line: string, needle: string): number =>
  [...line.slice(0, line.indexOf(needle))].length + 1;

it("extracts definitions, calls and imports in TS, Python and Bash", async () => {
  const { facts, manifest, workDir } = await extractSample();
  const defsIn = (file: string) =>
    facts.defs
      .filter((d) => d.file === file)
      .map((d) => [d.qualname, d.kind, d.start.line, d.exportedSyntax]);

  expect(defsIn("web/orbit.ts")).toEqual([
    ["Orbit", "class", 2, true],
    ["Orbit.position", "method", 3, true],
    ["Orbit.drift", "method", 6, false],
    ["solve", "function", 10, true],
    ["G", "constant", 15, true],
    ["helper", "function", 16, true],
    ["load", "function", 18, true],
  ]);
  const solve = facts.defs.find((d) => d.qualname === "solve");
  expect(solve).toEqual({
    file: "web/orbit.ts",
    qualname: "solve",
    name: "solve",
    kind: "function",
    start: P(10, 8),
    end: P(14, 2),
    nameAt: [P(10, 17), P(11, 17), P(12, 17)],
    exportedSyntax: true,
    signature: "export function solve(a: number): number;",
  });
  expect(defsIn("sim/sky.py")).toEqual([
    ["MAX_STARS", "constant", 3, false],
    ["Sky", "class", 5, false],
    ["Sky.show", "method", 6, false],
    ["Sky.draw", "method", 9, false],
    ["outer", "function", 12, false],
    ["outer.inner", "function", 13, false],
    ["look", "function", 17, false],
  ]);
  const look = facts.defs.find((d) => d.qualname === "look");
  expect([look?.start, look?.nameAt, look?.signature]).toEqual([
    P(17, 1),
    [P(18, 5)],
    "def look():",
  ]);
  expect(defsIn("scripts/sync.sh")).toEqual([["sync", "function", 2, false]]);

  // calls: o.position with its receiver, self.draw, and the Bash call of sync
  const callsIn = (file: string) =>
    facts.calls
      .filter((c) => c.file === file)
      .map((c) => [c.callee, c.receiver, c.at.line, c.at.col]);
  expect(callsIn("web/orbit.ts")).toEqual([
    ["position", "this", 7, 10],
    ["position", "o", 21, 5],
  ]);
  expect(callsIn("sim/sky.py")).toContainEqual(["draw", "self", 7, 14]);
  expect(callsIn("scripts/sync.sh")).toEqual([
    ["echo", null, 3, 3],
    ["source", null, 5, 1],
    ["sync", null, 6, 1],
  ]);

  // imports: type-only and dynamic in TS, one computed import, a from-import, a source
  expect(facts.imports.filter((i) => i.file === "web/orbit.ts")).toEqual([
    {
      file: "web/orbit.ts",
      at: P(1, 27),
      startLine: 1,
      endLine: 1,
      specifier: "./body",
      kind: "type-only",
      names: ["Body"],
    },
    {
      file: "web/orbit.ts",
      at: P(19, 26),
      startLine: 19,
      endLine: 19,
      specifier: "./sky",
      kind: "dynamic",
      names: [],
    },
  ]);
  // the statement's lines start at its first line, above the specifier's
  expect(facts.imports.filter((i) => i.file === "web/view.ts")).toEqual([
    {
      file: "web/view.ts",
      at: P(4, 8),
      startLine: 1,
      endLine: 4,
      specifier: "./orbit",
      kind: "static",
      names: ["Orbit", "solve"],
    },
  ]);
  expect(facts.computed).toEqual([{ file: "web/orbit.ts", line: 20 }]);
  expect(facts.imports.filter((i) => i.file === "sim/sky.py")).toEqual([
    {
      file: "sim/sky.py",
      at: P(1, 6),
      startLine: 1,
      endLine: 1,
      specifier: "functools",
      kind: "static",
      names: ["cache"],
    },
  ]);
  expect(facts.imports.filter((i) => i.file === "scripts/sync.sh")).toEqual([
    {
      file: "scripts/sync.sh",
      at: P(5, 8),
      startLine: 5,
      endLine: 5,
      specifier: "./lib.sh",
      kind: "source",
      names: [],
    },
  ]);

  // columns count code points: twinkle and label.at sit after é and an astral emoji
  const twinkle = facts.defs.find((d) => d.qualname === "twinkle");
  expect([twinkle?.start, twinkle?.nameAt]).toEqual([
    P(1, colOf(STARS_LINE, "function twinkle")),
    [P(1, colOf(STARS_LINE, "twinkle"))],
  ]);
  expect(callsIn("web/stars.ts")).toEqual([
    ["at", "label", 1, colOf(STARS_LINE, "at(0)")],
  ]);

  // the repo's .ignore, which lists *.py and *.sh, is in the snapshot and not honoured; a
  // hidden directory is entered; a .zsh file is not read
  expect(manifest.tree.map((e) => e.path)).toContain(".ignore");
  expect(defsIn(".github/scripts/ci.sh")).toEqual([
    ["ci", "function", 1, false],
  ]);
  expect(facts.defs.some((d) => d.file === "scripts/prompt.zsh")).toBe(false);

  // metadata-only files give nothing; the decoys an unescaped glob would hit are scanned
  expect(manifest.metadataOnly).toEqual([
    { path: "web/gen[1].ts", reason: "generated" },
    { path: "web/{a,b}.ts", reason: "generated" },
  ]);
  const skipped = new Set(["web/gen[1].ts", "web/{a,b}.ts"]);
  for (const list of [facts.defs, facts.calls, facts.imports, facts.computed]) {
    expect(list.filter((f) => skipped.has(f.file))).toEqual([]);
  }
  expect(defsIn("web/gen1.ts")).toEqual([["decoyOne", "function", 1, true]]);
  expect(defsIn("web/a.ts")).toEqual([["decoyA", "function", 1, true]]);

  // the raw output is deleted after parsing
  expect(existsSync(join(workDir, "ast-grep.jsonl"))).toBe(false);
}, 300_000);

it("fails with ast-grep's own error when it exits non-zero", async () => {
  const ctx = await exportOf(await smallRepo());
  // a rule file ast-grep cannot load: it exits 8
  writeFileSync(
    join(ctx.exportDir, "ast-grep", "rules", "broken.yml"),
    "id: ts-def-broken\nlanguage: Nope\nrule: { kind: identifier }\n",
  );
  await expect(astGrepDriver.run(ctx)).rejects.toThrow(
    /^ast-grep failed: Error: Cannot parse rule .*broken\.yml/,
  );
  expect(existsSync(join(ctx.workDir, "ast-grep.jsonl"))).toBe(false);
}, 300_000);

// root reads any directory, so the refusal cannot be staged
it.skipIf(process.getuid?.() === 0)(
  "fails when ast-grep reports a path it cannot read, though it exits 0",
  async () => {
    const ctx = await exportOf(await smallRepo());
    const sim = join(ctx.snapshotDir, "sim");
    chmodSync(sim, 0o000);
    try {
      await expect(astGrepDriver.run(ctx)).rejects.toThrow(
        /^ast-grep failed: ERROR: .*\/snapshot\/sim: Permission denied/,
      );
    } finally {
      chmodSync(sim, 0o555);
    }
  },
  300_000,
);

it("fails when the snapshot directory is missing, which ast-grep would answer with nothing", async () => {
  const ctx = await exportOf(await smallRepo());
  await expect(
    astGrepDriver.run({ ...ctx, snapshotDir: join(ctx.exportDir, "nowhere") }),
  ).rejects.toThrow(
    `ast-grep failed: no snapshot directory at ${join(ctx.exportDir, "nowhere")}`,
  );
}, 300_000);

// Each rule's syntax once, beyond the sample above: TS, TSX, JS, Python and shell.
const FORMS_TS = lines(
  'import D, * as E from "./de";',
  'import { a, b as c, type T } from "./abc";',
  'import { type A1, type B1 as C1 } from "./ab";',
  'import "./side";',
  'import x = require("./req");',
  'export * from "./stars";',
  'export * as ns from "./ns";',
  'export { d, e as f } from "./def";',
  "export { helper };",
  "declare function look(): void;",
  "export declare function peek(): void;",
  "function* gen() {}",
  "export abstract class Shape {",
  "  abstract area(): number;",
  "  protected pull(): void;",
  "  get x() { return 1; }",
  "  static f = () => 1;",
  "  g = 2;",
  "}",
  "const Sky = class { show() {} };",
  "const helper = () => 1, G = 6.674e-11;",
  "let notConst = () => 2;",
  "interface Body2 { m(): void; p: number }",
  "type Pair = { m(): void };",
  "enum Color { Red }",
  "module.exports.run = function () {};",
  "exports.go = () => 1;",
  "const obj = { m() {}, n: () => 1 };",
  "a.b.c.d();",
  "x().y();",
  "new ns.Sky();",
  'const r = require("./r");',
  "const q = require(name);",
);

const FORMS_TSX = lines(
  'import { Sky } from "./sky";',
  "export function View({ a }: { a: number }) {",
  "  return <Sky.Map a={a}><Sky /><div /><Étoile /><ui.Button /></Sky.Map>;",
  "}",
  "export default class extends Base { render() { return <Orbit.Path.Line />; } }",
);

const FORMS_JS = lines(
  'const path = require("path");',
  "export default function () { return path; }",
  "export class Star { #draw() {} static f = () => 1; g = 2; render() { return <Glow />; } }",
  "exports.stop = () => 0;",
  "const lazy = import(`./lazy.js`);",
);

const FORMS_PY = lines(
  "from __future__ import annotations",
  "import os.path, sys as system",
  "from ..pkg import (alpha,",
  "    beta as b2)",
  "from . import *",
  "MAX_STARS = 9",
  "_HIDDEN_K: int = 3",
  "lower_case = 1",
  "SQUARE = lambda x: x * x",
  "if True:",
  "    NOT_MODULE = 1",
  "class Sky:",
  "    LIMIT = 4",
  "    @property",
  "    def area(self):",
  "        return math.pi.real()",
  "def load(name):",
  '    a = importlib.import_module("observatory.sky")',
  "    b = __import__(name)",
  "    return super().go()",
);

const FORMS_SH = lines(
  '. "./lib two.sh"',
  'source "$DIR/lib.sh"',
  "function flush { :; }",
  'bash -x ./run.sh "$a"',
  "sh -c 'echo hi'",
  "FOO=1 ./tools/x.sh arg",
  "../up.sh",
  'bash "$x" y.sh',
);

it("matches each rule's syntax in TS, TSX, JS, Python and shell", async () => {
  const repo = await makeRepo({
    commits: [
      {
        date: "2026-03-02T10:00:00Z",
        files: {
          "web/forms.ts": FORMS_TS,
          "web/view.tsx": FORMS_TSX,
          "web/legacy.js": FORMS_JS,
          "sim/forms.py": FORMS_PY,
          "scripts/forms.sh": FORMS_SH,
        },
      },
    ],
  });
  const facts = await astGrepDriver.run(await exportOf(repo));
  const of = (file: string) => ({
    defs: facts.defs
      .filter((d) => d.file === file)
      .map((d) => [d.qualname, d.kind, d.start.line, d.exportedSyntax]),
    calls: facts.calls
      .filter((c) => c.file === file)
      .map((c) => [c.callee, c.receiver, c.at.line]),
    imports: facts.imports
      .filter((i) => i.file === file)
      .map((i) => [i.kind, i.specifier, i.names, i.at.line]),
    computed: facts.computed.filter((c) => c.file === file).map((c) => c.line),
  });

  expect(of("web/forms.ts")).toEqual({
    defs: [
      ["look", "function", 10, false],
      ["peek", "function", 11, true],
      ["gen", "function", 12, false],
      ["Shape", "class", 13, true],
      ["Shape.area", "method", 14, true],
      ["Shape.pull", "method", 15, false],
      ["Shape.x", "method", 16, true],
      ["Shape.f", "method", 17, true],
      ["Sky", "class", 20, false],
      ["Sky.show", "method", 20, false],
      ["helper", "function", 21, true],
      ["G", "constant", 21, false],
      ["Body2", "type", 23, false],
      ["Pair", "type", 24, false],
      ["Color", "type", 25, false],
      ["run", "function", 26, true],
      ["go", "function", 27, true],
      ["obj", "constant", 28, false],
      ["r", "constant", 32, false],
      ["q", "constant", 33, false],
    ],
    calls: [
      ["d", "a.b.c", 29],
      ["x", null, 30],
      ["y", null, 30],
      ["Sky", "ns", 31],
      ["require", null, 32],
      ["require", null, 33],
    ],
    imports: [
      ["static", "./de", ["default", "*"], 1],
      ["static", "./abc", ["a", "b", "T"], 2],
      ["type-only", "./ab", ["A1", "B1"], 3],
      ["side-effect", "./side", [], 4],
      ["require", "./req", [], 5],
      ["re-export", "./stars", ["*"], 6],
      ["re-export", "./ns", ["*"], 7],
      ["re-export", "./def", ["d", "e"], 8],
      ["require", "./r", [], 32],
    ],
    computed: [33],
  });
  expect(of("web/view.tsx")).toEqual({
    defs: [
      ["View", "function", 2, true],
      ["default", "class", 5, true],
      ["default.render", "method", 5, true],
    ],
    calls: [
      ["Map", "Sky", 3],
      ["Sky", null, 3],
      ["Étoile", null, 3],
      ["Line", "Orbit.Path", 5],
    ],
    imports: [["static", "./sky", ["Sky"], 1]],
    computed: [],
  });
  expect(of("web/legacy.js")).toEqual({
    defs: [
      ["path", "constant", 1, false],
      ["default", "function", 2, true],
      ["Star", "class", 3, true],
      ["Star.#draw", "method", 3, false],
      ["Star.f", "method", 3, true],
      ["Star.render", "method", 3, true],
      ["stop", "function", 4, true],
      ["lazy", "constant", 5, false],
    ],
    calls: [
      ["require", null, 1],
      ["Glow", null, 3],
    ],
    imports: [
      ["require", "path", [], 1],
      ["dynamic", "./lazy.js", [], 5],
    ],
    computed: [],
  });
  expect(of("sim/forms.py")).toEqual({
    defs: [
      ["MAX_STARS", "constant", 6, false],
      ["_HIDDEN_K", "constant", 7, false],
      ["SQUARE", "function", 9, false],
      ["Sky", "class", 12, false],
      ["Sky.area", "method", 14, false],
      ["load", "function", 17, false],
    ],
    calls: [
      ["real", "math.pi", 16],
      ["import_module", "importlib", 18],
      ["__import__", null, 19],
      ["super", null, 20],
      ["go", null, 20],
    ],
    imports: [
      ["static", "os.path", [], 2],
      ["static", "sys", [], 2],
      ["static", "..pkg", ["alpha", "beta"], 3],
      ["static", ".", ["*"], 5],
      ["dynamic", "observatory.sky", [], 18],
    ],
    computed: [19],
  });
  expect(of("scripts/forms.sh")).toEqual({
    defs: [["flush", "function", 3, false]],
    calls: [
      [".", null, 1],
      ["source", null, 2],
      [":", null, 3],
      ["bash", null, 4],
      ["sh", null, 5],
      ["./tools/x.sh", null, 6],
      ["../up.sh", null, 7],
      ["bash", null, 8],
    ],
    imports: [
      ["source", "./lib two.sh", [], 1],
      ["exec", "./run.sh", [], 4],
      ["exec", "./tools/x.sh", [], 6],
      ["exec", "../up.sh", [], 7],
    ],
    computed: [],
  });
}, 300_000);
