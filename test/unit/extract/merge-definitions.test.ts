// The definitions table: the outline's definitions and a module row for every code, test and
// test-support file, ordinals for repeated qualnames, SCIP symbols joined by name position,
// parents by range, and redacted signatures.
import { expect, it } from "vitest";
import {
  mergeDefinitions,
  scipKey,
} from "../../../src/extract/merge/definitions.js";
import { fileRows } from "../../../src/extract/merge/files.js";
import { mergeImports } from "../../../src/extract/merge/imports.js";
import type { ScipFacts } from "../../../src/extract/scip/facts.js";
import type { DefinitionRow } from "../../../src/store/index.js";
import {
  astGrep,
  importFact,
  mergeInput,
  outlineDef,
  P,
  SIM,
} from "./merge-input.js";

const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const high = (n: number) =>
  Array.from({ length: n }, (_, i) => ALPHA[(i * 37 + 11) % ALPHA.length]).join(
    "",
  );
const join = (...parts: string[]) => parts.join("");

const scip = (facts: Partial<ScipFacts>): ScipFacts => ({
  documents: new Set(),
  definitions: [],
  uses: [],
  moduleAt: new Map(),
  duplicates: [],
  ...facts,
});

// The module row of a file with `lines` lines.
const moduleRow = (
  id: number,
  file_id: number,
  lines: number,
  scip_symbol: string | null = null,
): DefinitionRow => ({
  id,
  file_id,
  qualname: "<module>",
  ordinal: 1,
  name: "<module>",
  kind: "module",
  start_line: 1,
  start_col: 1,
  end_line: lines + 1,
  end_col: 1,
  exported: 0,
  parent_id: null,
  scip_symbol,
  signature: null,
  producer: "hakutaku",
});

it("gives every code file a module row spanning the whole file", () => {
  const input = mergeInput({
    "README.md": "# Sky\n",
    "sim/empty.py": "",
    "web/src/orbit.test.ts": "a\nb\nc",
    "web/src/orbit.ts": "x\ny\nz\n",
  });
  const defs = mergeDefinitions(input, fileRows(input));
  // a 3-line file runs from (1,1) to (4,1), its end exclusive; an empty one from (1,1) to (1,1)
  const rows = [moduleRow(1, 2, 0), moduleRow(2, 3, 3), moduleRow(3, 4, 3)];
  expect(defs).toEqual({
    definitions: rows,
    byFile: new Map([
      ["sim/empty.py", [rows[0]]],
      ["web/src/orbit.test.ts", [rows[1]]],
      ["web/src/orbit.ts", [rows[2]]],
    ]),
    unmatchedScipDefinitions: 0,
    scipToDef: new Map(),
    redactions: 0,
  });
});

it("numbers repeated qualnames and joins SCIP by name position", () => {
  const FILE = "web/src/sky.ts";
  const LINE = "  function f() { function g() {} }";
  const SIGNATURE = LINE.trim();
  const MOD = "scip-typescript npm observatory 0.1.0 web/src/`sky.ts`/";
  const F2 = "scip-typescript npm observatory 0.1.0 web/src/`sky.ts`/f(+1).";
  const input = mergeInput(
    { [FILE]: `if (day) {\n${LINE}\n} else {\n${LINE}\n}\n` },
    {
      facts: {
        astGrep: astGrep({
          defs: [
            outlineDef(
              FILE,
              "f",
              "function",
              P(2, 3),
              P(2, 35),
              [P(2, 12)],
              SIGNATURE,
            ),
            outlineDef(
              FILE,
              "f.g",
              "function",
              P(2, 18),
              P(2, 33),
              [P(2, 27)],
              SIGNATURE,
            ),
            outlineDef(
              FILE,
              "f",
              "function",
              P(4, 3),
              P(4, 35),
              [P(4, 12)],
              SIGNATURE,
            ),
            outlineDef(
              FILE,
              "f.g",
              "function",
              P(4, 18),
              P(4, 33),
              [P(4, 27)],
              SIGNATURE,
            ),
          ],
        }),
        scip: scip({
          documents: new Set([FILE]),
          definitions: [
            { file: FILE, at: P(1, 1), symbol: MOD },
            { file: FILE, at: P(4, 12), symbol: F2 },
          ],
        }),
      },
    },
  );
  const defs = mergeDefinitions(input, fileRows(input));
  const def = (
    id: number,
    qualname: string,
    ordinal: number,
    start: [number, number],
    end: [number, number],
    parent_id: number | null,
    scip_symbol: string | null,
  ): DefinitionRow => ({
    id,
    file_id: 1,
    qualname,
    ordinal,
    name: qualname.slice(qualname.lastIndexOf(".") + 1),
    kind: "function",
    start_line: start[0],
    start_col: start[1],
    end_line: end[0],
    end_col: end[1],
    exported: 0,
    parent_id,
    scip_symbol,
    signature: SIGNATURE,
    producer: "ast-grep",
  });
  // each g nests in the f whose range holds it; the module symbol goes to <module> and
  // into no join
  expect(defs.definitions).toEqual([
    moduleRow(1, 1, 5, MOD),
    def(2, "f", 1, [2, 3], [2, 35], null, null),
    def(3, "f.g", 1, [2, 18], [2, 33], 2, null),
    def(4, "f", 2, [4, 3], [4, 35], null, F2),
    def(5, "f.g", 2, [4, 18], [4, 33], 4, null),
  ]);
  expect(defs.scipToDef).toEqual(new Map([[F2, 4]]));
  expect(defs.unmatchedScipDefinitions).toBe(0);
});

it("counts a SCIP definition that joins nothing", () => {
  const BODY = "web/src/body.ts";
  const PREFIX = "scip-typescript npm observatory 0.1.0 web/src/";
  const input = mergeInput(
    {
      [BODY]: "export interface Body {\n  position(t: number): number;\n}\n",
      // a NUL byte makes the file other: its SCIP facts are dropped, not counted
      "web/src/w.ts": "export const w = 1;\0\n",
    },
    {
      facts: {
        astGrep: astGrep({
          defs: [
            outlineDef(
              BODY,
              "Body",
              "type",
              P(1, 1),
              P(3, 2),
              [P(1, 18)],
              "export interface Body {",
              true,
            ),
          ],
        }),
        scip: scip({
          documents: new Set([BODY, "web/src/w.ts"]),
          definitions: [
            { file: BODY, at: P(1, 1), symbol: `${PREFIX}\`body.ts\`/` },
            { file: BODY, at: P(1, 18), symbol: `${PREFIX}\`body.ts\`/Body#` },
            // an interface member and a parameter: no outline definition carries either
            {
              file: BODY,
              at: P(2, 3),
              symbol: `${PREFIX}\`body.ts\`/Body#position().`,
            },
            { file: BODY, at: P(2, 12), symbol: "local 0" },
            {
              file: "web/src/w.ts",
              at: P(1, 14),
              symbol: `${PREFIX}\`w.ts\`/w.`,
            },
          ],
        }),
      },
    },
  );
  const defs = mergeDefinitions(input, fileRows(input));
  expect(defs.unmatchedScipDefinitions).toBe(2);
  expect(defs.definitions).toEqual([
    moduleRow(1, 1, 3, `${PREFIX}\`body.ts\`/`),
    {
      id: 2,
      file_id: 1,
      qualname: "Body",
      ordinal: 1,
      name: "Body",
      kind: "type",
      start_line: 1,
      start_col: 1,
      end_line: 3,
      end_col: 2,
      exported: 1,
      parent_id: null,
      scip_symbol: `${PREFIX}\`body.ts\`/Body#`,
      signature: "export interface Body {",
      producer: "ast-grep",
    },
  ]);
  expect(defs.scipToDef).toEqual(new Map([[`${PREFIX}\`body.ts\`/Body#`, 2]]));
});

it("exports a Python name only when another file imports its module", () => {
  const LONELY = "sim/src/observatory/lonely.py";
  const ORBIT = "sim/src/observatory/orbit.py";
  const TEST = "sim/tests/test_orbit.py";
  const input = mergeInput(
    {
      "sim/src/observatory/__init__.py": "",
      [LONELY]: "from .lonely import twin\n\n\ndef shine():\n    pass\n",
      [ORBIT]:
        "def solve():\n    pass\n\n\ndef _helper():\n    pass\n\n\nclass Orbit:\n    def position(self):\n        pass\n\n    def _step(self):\n        pass\n",
      [TEST]: "from observatory.orbit import solve\n",
    },
    {
      profile: SIM,
      facts: {
        astGrep: astGrep({
          defs: [
            outlineDef(
              LONELY,
              "shine",
              "function",
              P(4, 1),
              P(5, 9),
              [P(4, 5)],
              "def shine():",
            ),
            outlineDef(
              ORBIT,
              "solve",
              "function",
              P(1, 1),
              P(2, 9),
              [P(1, 5)],
              "def solve():",
            ),
            outlineDef(
              ORBIT,
              "_helper",
              "function",
              P(5, 1),
              P(6, 9),
              [P(5, 5)],
              "def _helper():",
            ),
            outlineDef(
              ORBIT,
              "Orbit",
              "class",
              P(9, 1),
              P(14, 13),
              [P(9, 7)],
              "class Orbit:",
            ),
            outlineDef(
              ORBIT,
              "Orbit.position",
              "method",
              P(10, 5),
              P(11, 13),
              [P(10, 9)],
              "def position(self):",
            ),
            outlineDef(
              ORBIT,
              "Orbit._step",
              "method",
              P(13, 5),
              P(14, 13),
              [P(13, 9)],
              "def _step(self):",
            ),
          ],
          imports: [
            // lonely.py imports only itself
            importFact(LONELY, P(1, 6), ".lonely", "static", ["twin"]),
            importFact(TEST, P(1, 6), "observatory.orbit", "static", ["solve"]),
          ],
        }),
      },
    },
  );
  const files = fileRows(input);
  const defs = mergeDefinitions(input, files);
  // no Python name is exported until the imports are known
  expect(defs.definitions.map((d) => d.exported)).toEqual([
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  mergeImports(input, files, defs);
  const def = (
    id: number,
    file_id: number,
    qualname: string,
    kind: DefinitionRow["kind"],
    start: [number, number],
    end: [number, number],
    exported: 0 | 1,
    parent_id: number | null,
    signature: string,
  ): DefinitionRow => ({
    id,
    file_id,
    qualname,
    ordinal: 1,
    name: qualname.slice(qualname.lastIndexOf(".") + 1),
    kind,
    start_line: start[0],
    start_col: start[1],
    end_line: end[0],
    end_col: end[1],
    exported,
    parent_id,
    scip_symbol: null,
    signature,
    producer: "ast-grep",
  });
  expect(defs.definitions).toEqual([
    moduleRow(1, 1, 0),
    moduleRow(2, 2, 5),
    def(3, 2, "shine", "function", [4, 1], [5, 9], 0, null, "def shine():"),
    moduleRow(4, 3, 14),
    def(5, 3, "solve", "function", [1, 1], [2, 9], 1, null, "def solve():"),
    def(6, 3, "_helper", "function", [5, 1], [6, 9], 0, null, "def _helper():"),
    def(7, 3, "Orbit", "class", [9, 1], [14, 13], 1, null, "class Orbit:"),
    def(
      8,
      3,
      "Orbit.position",
      "method",
      [10, 5],
      [11, 13],
      1,
      7,
      "def position(self):",
    ),
    def(
      9,
      3,
      "Orbit._step",
      "method",
      [13, 5],
      [14, 13],
      0,
      7,
      "def _step(self):",
    ),
    moduleRow(10, 4, 1),
  ]);
});

it("redacts a signature before cutting it to 240 characters", () => {
  const FILE = "web/src/link.ts";
  const github = join("gh", "p_", high(36));
  const LINE = `export function connect(${"x".repeat(190)} = "${github}") {}`;
  const input = mergeInput(
    { [FILE]: `${LINE}\n` },
    {
      facts: {
        astGrep: astGrep({
          defs: [
            // the outline cuts the line at 240 characters, inside the token
            outlineDef(
              FILE,
              "connect",
              "function",
              P(1, 1),
              P(1, LINE.length + 1),
              [P(1, 17)],
              LINE.slice(0, 240),
              true,
            ),
          ],
        }),
      },
    },
  );
  const defs = mergeDefinitions(input, fileRows(input));
  expect(defs.definitions).toEqual([
    moduleRow(1, 1, 1),
    {
      id: 2,
      file_id: 1,
      qualname: "connect",
      ordinal: 1,
      name: "connect",
      kind: "function",
      start_line: 1,
      start_col: 1,
      end_line: 1,
      end_col: LINE.length + 1,
      exported: 1,
      parent_id: null,
      scip_symbol: null,
      signature: `export function connect(${"x".repeat(190)} = "«redacted:github-token`,
      producer: "ast-grep",
    },
  ]);
  expect(defs.redactions).toBe(1);
});

it("keys a local SCIP symbol by its file, and leaves a symbol two definitions joined out of scipToDef", () => {
  const A = "web/src/a.ts";
  const B = "web/src/b.ts";
  const TEXT = "function outer() {\n  function inner() {}\n}\n";
  // both nameless packages name outer alike: one symbol, defined in two documents
  const DUP = "scip-typescript npm . . `outer`().";
  const defsOf = (file: string) => [
    outlineDef(
      file,
      "outer",
      "function",
      P(1, 1),
      P(3, 2),
      [P(1, 10)],
      "function outer() {",
    ),
    outlineDef(
      file,
      "outer.inner",
      "function",
      P(2, 3),
      P(2, 22),
      [P(2, 12)],
      "function inner() {}",
    ),
  ];
  const input = mergeInput(
    { [A]: TEXT, [B]: TEXT },
    {
      facts: {
        astGrep: astGrep({ defs: [...defsOf(A), ...defsOf(B)] }),
        scip: scip({
          documents: new Set([A, B]),
          definitions: [
            // a position that carries a local and a global symbol stores the global one
            { file: A, at: P(1, 10), symbol: DUP },
            { file: A, at: P(1, 10), symbol: "local 9" },
            { file: A, at: P(2, 12), symbol: "local 1" },
            { file: B, at: P(1, 10), symbol: DUP },
            { file: B, at: P(2, 12), symbol: "local 1" },
          ],
        }),
      },
    },
  );
  const defs = mergeDefinitions(input, fileRows(input));
  const NUL = String.fromCharCode(0);
  expect(scipKey(A, "local 1")).toBe(`${A}${NUL}local 1`);
  expect(scipKey(A, DUP)).toBe(DUP);
  expect(
    defs.definitions.map((d) => [d.id, d.qualname, d.parent_id, d.scip_symbol]),
  ).toEqual([
    [1, "<module>", null, null],
    [2, "outer", null, DUP],
    [3, "outer.inner", 2, "local 1"],
    [4, "<module>", null, null],
    [5, "outer", null, DUP],
    [6, "outer.inner", 5, "local 1"],
  ]);
  expect(defs.scipToDef).toEqual(
    new Map([
      [scipKey(A, "local 1"), 3],
      [scipKey(A, "local 9"), 2],
      [scipKey(B, "local 1"), 6],
    ]),
  );
  expect(defs.unmatchedScipDefinitions).toBe(0);
});
