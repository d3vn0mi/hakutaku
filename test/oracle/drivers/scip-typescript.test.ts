// The scip-typescript driver against the installed engine: run `node dist/cli/main.js engines
// install --yes` once before this file. Each repo is made with makeRepo, exported with
// exportRepo, then read by scipTypescriptDriver.run over the export.
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
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
  type ScipFacts,
  scipTypescriptDriver,
} from "../../../src/extract/drivers/scip-typescript.js";
import { positionKey } from "../../../src/extract/scip/facts.js";
import { loadProfile } from "../../../src/profile/index.js";
import { makeRepo } from "../../helpers/git.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) removeTree(dir);
});

const TIMEOUT = 300_000;

const lines = (...text: string[]): string => `${text.join("\n")}\n`;

interface Run {
  facts: ScipFacts;
  ctx: ExtractContext;
  root: string;
}

// The facts of a repo holding the given files, read through a fresh export at standard detail.
async function factsOf(
  files: Record<string, string | Uint8Array>,
): Promise<Run> {
  const repo = await makeRepo({
    commits: [{ date: "2026-03-02T10:00:00Z", files }],
  });
  const root = mkdtempSync(join(tmpdir(), "hakutaku-oracle-scip-"));
  made.push(root);
  const exportDir = join(root, "export");
  await exportRepo({ repo, ref: "HEAD", out: exportDir });
  const manifest = JSON.parse(
    readFileSync(join(exportDir, "export.json"), "utf8"),
  ) as ExportManifest;
  const workDir = join(root, "work");
  mkdirSync(workDir);
  const ctx: ExtractContext = {
    exportDir,
    snapshotDir: join(exportDir, "snapshot"),
    workDir,
    enginesDir: defaultEnginesDir(),
    detail: "standard",
    noSource: false,
    profile: loadProfile(join(exportDir, "profile.json")),
    rules: null,
    manifest,
    pythonPath: null,
    log: () => {},
  };
  expect(scipTypescriptDriver.applies(ctx)).toBe(true);
  const facts = await scipTypescriptDriver.run(ctx);
  // the raw index is deleted after decoding
  expect(existsSync(join(workDir, "index.scip"))).toBe(false);
  return { facts, ctx, root };
}

const PKG = "scip-typescript npm observatory 0.1.0 ";
const ORBIT = `${PKG}src/\`orbit.ts\`/`;
const BODY = `${PKG}src/\`body.ts\`/`;

// orbit.test.ts calls orbit.position(0) on an Orbit; render.ts calls body.position(t) on a
// value typed by the interface Body, which Orbit implements.
const SAMPLE = {
  "package.json": JSON.stringify({ name: "observatory", version: "0.1.0" }),
  "src/body.ts": lines(
    "export interface Body {",
    "  position(t: number): number;",
    "}",
  ),
  "src/orbit.ts": lines(
    'import type { Body } from "./body";',
    "export class Orbit implements Body {",
    "  position(t: number): number {",
    "    return t * 2;",
    "  }",
    "}",
  ),
  "src/render.ts": lines(
    'import type { Body } from "./body";',
    "export function render(body: Body, t: number): number {",
    "  return body.position(t);",
    "}",
  ),
  "test/orbit.test.ts": lines(
    'import { Orbit } from "../src/orbit";',
    "const orbit = new Orbit();",
    "orbit.position(0);",
  ),
};

let sample: Promise<Run> | undefined;
const sampleRun = (): Promise<Run> => {
  sample ??= factsOf(SAMPLE);
  return sample;
};

const usesAt = (facts: ScipFacts, file: string, line: number, col: number) =>
  facts.uses.filter(
    (u) => u.file === file && u.at.line === line && u.at.col === col,
  );

it(
  "binds the direct call to Orbit#position and the seam to Body#position",
  async () => {
    const { facts } = await sampleRun();
    expect(facts.documents).toStrictEqual(
      new Set([
        "src/body.ts",
        "src/orbit.ts",
        "src/render.ts",
        "test/orbit.test.ts",
      ]),
    );
    // orbit.position(0): position at line 3, column 7
    expect(usesAt(facts, "test/orbit.test.ts", 3, 7)).toStrictEqual([
      {
        file: "test/orbit.test.ts",
        at: { line: 3, col: 7 },
        symbol: `${ORBIT}Orbit#position().`,
        roles: 0,
      },
    ]);
    // return body.position(t): position at line 3, column 15
    expect(usesAt(facts, "src/render.ts", 3, 15)).toStrictEqual([
      {
        file: "src/render.ts",
        at: { line: 3, col: 15 },
        symbol: `${BODY}Body#position().`,
        roles: 0,
      },
    ]);
    // each symbol is defined at its method's name
    expect(facts.definitions).toContainEqual({
      file: "src/orbit.ts",
      at: { line: 3, col: 3 },
      symbol: `${ORBIT}Orbit#position().`,
    });
    expect(facts.definitions).toContainEqual({
      file: "src/body.ts",
      at: { line: 2, col: 3 },
      symbol: `${BODY}Body#position().`,
    });
  },
  TIMEOUT,
);

it(
  "finds no duplicate symbol in a clean repo",
  async () => {
    const { facts } = await sampleRun();
    expect(facts.duplicates).toStrictEqual([]);
  },
  TIMEOUT,
);

it(
  "maps each import specifier to the document it names",
  async () => {
    const { facts } = await sampleRun();
    // keyed at each specifier's opening quote, as ast-grep places an import
    expect(facts.moduleAt).toStrictEqual(
      new Map([
        [positionKey("src/orbit.ts", { line: 1, col: 27 }), "src/body.ts"],
        [positionKey("src/render.ts", { line: 1, col: 27 }), "src/body.ts"],
        [
          positionKey("test/orbit.test.ts", { line: 1, col: 23 }),
          "src/orbit.ts",
        ],
      ]),
    );
  },
  TIMEOUT,
);

it(
  "names no absolute path in a symbol, with or without a package.json",
  async () => {
    const { facts, root } = await sampleRun();
    const symbols = (f: ScipFacts) => [
      ...f.definitions.map((d) => d.symbol),
      ...f.uses.map((u) => u.symbol),
    ];
    expect(facts.definitions).toContainEqual({
      file: "src/orbit.ts",
      at: { line: 1, col: 1 },
      symbol: ORBIT,
    });
    expect(symbols(facts).filter((s) => s.includes(root))).toStrictEqual([]);
    // without a package.json, a file's symbols are named from the export directory down
    const bare = await factsOf({
      "src/a.ts": lines("export const a = 1;"),
      "src/b.ts": lines('import { a } from "./a";', "export const b = a;"),
    });
    expect(bare.facts.definitions).toContainEqual({
      file: "src/a.ts",
      at: { line: 1, col: 14 },
      symbol: "scip-typescript npm . . snapshot/src/`a.ts`/a.",
    });
    expect(
      symbols(bare.facts).filter(
        (s) => s.includes(bare.root) || s.includes(tmpdir()),
      ),
    ).toStrictEqual([]);
    expect(bare.facts.moduleAt).toStrictEqual(
      new Map([[positionKey("src/b.ts", { line: 1, col: 19 }), "src/a.ts"]]),
    );
  },
  TIMEOUT,
);

it(
  "places positions as the store counts them: a byte order mark, CRLF, a lone CR, U+2028, U+2029 and astral characters",
  async () => {
    const bom = String.fromCodePoint(0xfeff);
    const ls = String.fromCodePoint(0x2028);
    const ps = String.fromCodePoint(0x2029);
    const grin = String.fromCodePoint(0x1f600);
    const { facts } = await factsOf({
      "package.json": JSON.stringify({ name: "observatory", version: "0.1.0" }),
      "src/orbit.ts": lines(
        "export class Orbit {",
        "  position(t: number): number {",
        "    return t;",
        "  }",
        "}",
      ),
      "src/bom.ts": lines(
        `${bom}export const bom = 1;`,
        "export const two = bom;",
      ),
      "src/crlf.ts":
        "export const d = 1;\r\nexport function crlf(): number { return d; }\r\n",
      "src/cr.ts": lines(
        "export const c = 1;\r// lone cr\rexport function lone(): number { return c; }",
      ),
      "src/ls.ts": lines(
        `export const a = "x${ls}y${ps}z";`,
        "export function after(): number { return 1; }",
      ),
      "src/sky.ts": lines(
        'import { Orbit } from "./orbit";',
        "const orbit = new Orbit();",
        `export const sky = "${grin}${grin}"; orbit.position(0);`,
      ),
    });
    const m = (file: string, name: string) =>
      `${PKG}src/\`${file.slice(4)}\`/${name}`;
    const def = (file: string, line: number, col: number, name: string) => ({
      file,
      at: { line, col },
      symbol: m(file, name),
    });
    for (const d of [
      // the mark is the first column of line 1
      def("src/bom.ts", 1, 15, "bom."),
      def("src/bom.ts", 2, 14, "two."),
      def("src/crlf.ts", 1, 14, "d."),
      def("src/crlf.ts", 2, 17, "crlf()."),
      // TypeScript ends a line at each lone CR, U+2028 and U+2029; the store does not
      def("src/cr.ts", 1, 14, "c."),
      def("src/cr.ts", 1, 48, "lone()."),
      def("src/ls.ts", 1, 14, "a."),
      def("src/ls.ts", 2, 17, "after()."),
      def("src/sky.ts", 3, 14, "sky."),
    ]) {
      expect(facts.definitions).toContainEqual(d);
    }
    expect(usesAt(facts, "src/bom.ts", 2, 20)).toHaveLength(1);
    expect(usesAt(facts, "src/crlf.ts", 2, 41)).toHaveLength(1);
    expect(usesAt(facts, "src/cr.ts", 1, 72)).toHaveLength(1);
    // two emoji, two code points: orbit.position(0) has position at column 32
    expect(usesAt(facts, "src/sky.ts", 3, 32)).toStrictEqual([
      {
        file: "src/sky.ts",
        at: { line: 3, col: 32 },
        symbol: `${ORBIT}Orbit#position().`,
        roles: 0,
      },
    ]);
  },
  TIMEOUT,
);

it(
  "keeps an imported 50 MB minified file out of its program, and finishes under the memory cap",
  async () => {
    // the hostile suite's minified case: one line of 52,428,800 bytes, imported by app.js
    const pattern = "var a=function(n){return n*2+10},b=[1,2,3].map(a);";
    const big = pattern.repeat(52_428_800 / pattern.length);
    expect(big.length).toBe(52_428_800);
    const { facts, ctx } = await factsOf({
      "src/big.min.js": big,
      "src/app.js": lines(
        'import "./big.min.js";',
        "",
        "export const app = 1;",
      ),
    });
    expect(ctx.manifest.metadataOnly.map((m) => m.path)).toStrictEqual([
      "src/big.min.js",
    ]);
    expect(facts.documents).toStrictEqual(new Set(["src/app.js"]));
  },
  TIMEOUT,
);

it(
  "counts the modules of two packages named alike as duplicates",
  async () => {
    // A package.json without a name makes an anonymous package, ". .", so the two index.ts
    // files below are one module to SCIP. (Two packages with one name never reach the engine:
    // the generated profile refuses them.)
    const pkg = JSON.stringify({ private: true });
    const draw = lines("export function draw(): number {", "  return 1;", "}");
    const { facts } = await factsOf({
      "package.json": JSON.stringify({ name: "observatory", version: "0.1.0" }),
      "web/a/package.json": pkg,
      "web/a/src/index.ts": draw,
      "web/b/package.json": pkg,
      "web/b/src/index.ts": draw,
    });
    const index = "scip-typescript npm . . src/`index.ts`/";
    expect(facts.duplicates).toStrictEqual([index, `${index}draw().`]);
  },
  TIMEOUT,
);
