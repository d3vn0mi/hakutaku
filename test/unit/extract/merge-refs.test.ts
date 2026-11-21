// References: each SCIP use that is not at a call site and whose symbol joined an outline
// definition, with its role by the first rule that applies: import, write, type, read.
import { expect, it } from "vitest";
import { mergeFacts } from "../../../src/extract/merge/index.js";
import type { RefRow } from "../../../src/store/index.js";
import {
  astGrep,
  callFact,
  importFact,
  lines,
  mergeInput,
  outlineDef,
  P,
  SIM,
  scip,
  spot,
  symbolOf,
} from "./merge-input.js";

// SCIP's roles: WriteAccess is 0x4, ReadAccess 0x8.
const WRITE = 4;
const READ = 8;

it("gives references the roles import, write, type and read", () => {
  const KEPLER = "web/src/orbits/kepler.ts";
  const KEPLER_TEXT = lines(
    "export interface Body { mass: number }",
    "export class Orbit {",
    "  position(t: number): number { return t; }",
    "}",
    "export function solve(o: Orbit): number { return 0; }",
  );
  const RENDER = "web/src/sky/render.ts";
  // an import over five lines: its names sit above its specifier's line
  const RENDER_TEXT = lines(
    "import {",
    "  Orbit,",
    "  solve,",
    "  type Body,",
    '} from "../orbits/kepler";',
    "export function drawSky(b: Body, o: Orbit) {",
    "  const pick = solve;",
    "  solve(o);",
    "  o.position = o.position;",
    "  return pick;",
    "}",
  );
  // a NUL byte makes the file other: it is off the map, and its uses are dropped
  const BLOB = "web/src/sky/blob.ts";
  const ORBIT = symbolOf(KEPLER, "Orbit#");
  const SOLVE = symbolOf(KEPLER, "solve().");
  const BODY = symbolOf(KEPLER, "Body#");
  const POSITION = symbolOf(KEPLER, "Orbit#position().");
  const at = (line: number, needle: string) => spot(RENDER_TEXT, line, needle);
  const use = (
    where: ReturnType<typeof P>,
    symbol: string,
    roles = 0,
    file = RENDER,
  ) => ({ file, at: where, symbol, roles });
  const input = mergeInput(
    { [BLOB]: "Orbit\0\n", [KEPLER]: KEPLER_TEXT, [RENDER]: RENDER_TEXT },
    {
      facts: {
        astGrep: astGrep({
          defs: [
            outlineDef(
              KEPLER,
              "Body",
              "type",
              P(1, 8),
              P(1, 39),
              [P(1, 18)],
              "export interface Body { mass: number }",
              true,
            ),
            outlineDef(
              KEPLER,
              "Orbit",
              "class",
              P(2, 8),
              P(4, 2),
              [P(2, 14)],
              "export class Orbit {",
              true,
            ),
            outlineDef(
              KEPLER,
              "Orbit.position",
              "method",
              P(3, 3),
              P(3, 44),
              [P(3, 3)],
              "position(t: number): number { return t; }",
              true,
            ),
            outlineDef(
              KEPLER,
              "solve",
              "function",
              P(5, 8),
              P(5, 54),
              [P(5, 17)],
              "export function solve(o: Orbit): number { return 0; }",
              true,
            ),
            outlineDef(
              RENDER,
              "drawSky",
              "function",
              P(6, 8),
              P(11, 2),
              [P(6, 17)],
              "export function drawSky(b: Body, o: Orbit) {",
              true,
            ),
          ],
          calls: [callFact(RENDER, at(8, "solve"), "solve")],
          imports: [
            importFact(
              RENDER,
              at(5, '"../orbits/kepler"'),
              "../orbits/kepler",
              "static",
              ["Orbit", "solve", "Body"],
              [1, 5],
            ),
          ],
        }),
        scip: scip({
          documents: new Set([BLOB, KEPLER, RENDER]),
          definitions: [
            { file: KEPLER, at: P(1, 18), symbol: BODY },
            { file: KEPLER, at: P(2, 14), symbol: ORBIT },
            { file: KEPLER, at: P(3, 3), symbol: POSITION },
            { file: KEPLER, at: P(5, 17), symbol: SOLVE },
            {
              file: RENDER,
              at: P(6, 17),
              symbol: symbolOf(RENDER, "drawSky()."),
            },
            { file: RENDER, at: at(6, "o:"), symbol: "local 1" },
            { file: RENDER, at: at(7, "pick"), symbol: "local 2" },
          ],
          uses: [
            use(P(1, 1), ORBIT, 0, BLOB),
            use(at(2, "Orbit"), ORBIT),
            use(at(3, "solve"), SOLVE),
            use(at(4, "Body"), BODY),
            // the specifier names kepler.ts' module, which joins no definition
            use(at(5, '"../orbits/kepler"'), symbolOf(KEPLER, "")),
            use(at(6, "Body"), BODY),
            use(at(6, "Orbit"), ORBIT),
            // a use given twice is one reference
            use(at(7, "solve"), SOLVE),
            use(at(7, "solve"), SOLVE),
            // the call: a call site, never a reference
            use(at(8, "solve"), SOLVE),
            use(P(8, 9), "local 1"),
            use(at(9, "position"), POSITION, WRITE),
            use(spot(RENDER_TEXT, 9, "o.position;"), "local 1"),
            use(P(9, 18), POSITION, READ),
            use(at(10, "pick"), "local 2"),
          ],
        }),
      },
    },
  );
  const { content } = mergeFacts(input);
  // Files: 1 kepler.ts, 2 blob.ts (other), 3 render.ts. Definitions: 1 kepler.ts' <module>,
  // 2 Body, 3 Orbit, 4 Orbit.position, 5 solve; 6 render.ts' <module>, 7 drawSky.
  const ref = (
    id: number,
    line: number,
    col: number,
    enclosing_def_id: number,
    def_id: number,
    role: RefRow["role"],
  ): RefRow => ({
    id,
    file_id: 3,
    line,
    col,
    enclosing_def_id,
    def_id,
    role,
    producer: "scip-typescript",
  });
  expect(content.refs).toEqual([
    // inside the import's five lines, the type Body included
    ref(1, 2, 3, 6, 3, "import"),
    ref(2, 3, 3, 6, 5, "import"),
    ref(3, 4, 8, 6, 2, "import"),
    ref(4, 6, 28, 7, 2, "type"),
    ref(5, 6, 37, 7, 3, "read"),
    ref(6, 7, 16, 7, 5, "read"),
    ref(7, 9, 5, 7, 4, "write"),
    ref(8, 9, 18, 7, 4, "read"),
  ]);
});

it("names scip-python as the producer of a Python file's references", () => {
  const CLI = "sim/src/observatory/cli.py";
  const ORBITS = "sim/src/observatory/kepler.py";
  const SOLVE =
    "scip-python python observatory 0.1.0 `observatory.kepler`/solve().";
  const input = mergeInput(
    {
      [CLI]: lines("from observatory.kepler import solve", "handler = solve"),
      [ORBITS]: lines("def solve():", "    return 0"),
    },
    {
      profile: SIM,
      facts: {
        astGrep: astGrep({
          defs: [
            outlineDef(
              ORBITS,
              "solve",
              "function",
              P(1, 1),
              P(2, 13),
              [P(1, 5)],
              "def solve():",
            ),
          ],
          imports: [
            importFact(CLI, P(1, 6), "observatory.kepler", "static", ["solve"]),
          ],
        }),
        scip: scip({
          documents: new Set([CLI, ORBITS]),
          definitions: [{ file: ORBITS, at: P(1, 5), symbol: SOLVE }],
          uses: [
            { file: CLI, at: P(1, 32), symbol: SOLVE, roles: 0 },
            { file: CLI, at: P(2, 11), symbol: SOLVE, roles: 0 },
          ],
        }),
      },
    },
  );
  const { content } = mergeFacts(input);
  // Files: 1 cli.py, 2 kepler.py. Definitions: 1 cli.py's <module>; 2 kepler.py's
  // <module>, 3 solve
  const ref = (
    id: number,
    line: number,
    col: number,
    role: RefRow["role"],
  ) => ({
    id,
    file_id: 1,
    line,
    col,
    enclosing_def_id: 1,
    def_id: 3,
    role,
    producer: "scip-python",
  });
  expect(content.refs).toEqual([
    ref(1, 1, 32, "import"),
    ref(2, 2, 11, "read"),
  ]);
});
