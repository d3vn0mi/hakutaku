// Call sites and their targets: one site per call fact of a code, test or test-support file,
// enclosed by the innermost definition holding it, else by the file's module row; a target
// SCIP binds, else every function, method or class of the callee's name in the files the
// site's file sees; and the counts coverage keeps of them. Two classes here define position.
import { expect, it } from "vitest";
import type { Pos } from "../../../src/extract/facts.js";
import { coverageOf, mergeFacts } from "../../../src/extract/merge/index.js";
import type { MergeInput } from "../../../src/extract/merge/types.js";
import type { CallSiteRow, CallTargetRow } from "../../../src/store/index.js";
import {
  astGrep,
  callFact,
  importFact,
  lines,
  mark,
  mergeInput,
  outlineDef,
  P,
  SIM,
  scip,
  spot,
  symbolOf,
} from "./merge-input.js";

const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const high = (n: number) =>
  Array.from({ length: n }, (_, i) => ALPHA[(i * 37 + 11) % ALPHA.length]).join(
    "",
  );
const join = (...parts: string[]) => parts.join("");

const KEPLER = "web/src/orbits/kepler.ts";
const KEPLER_TEXT = lines(
  "export class Orbit {",
  "  position(t: number): number {",
  "    return t;",
  "  }",
  "}",
);
const CAMERA = "web/src/sky/camera.ts";
const CAMERA_TEXT = lines(
  "export class Camera {",
  "  position(t: number): number {",
  "    return -t;",
  "  }",
  "}",
);
const TEST = "web/src/orbits/kepler.test.ts";

// The outline of a file holding one class with one method, position.
const classDefs = (file: string, name: string) => [
  outlineDef(
    file,
    name,
    "class",
    P(1, 8),
    P(5, 2),
    [P(1, 14)],
    `export class ${name} {`,
    true,
  ),
  outlineDef(
    file,
    `${name}.position`,
    "method",
    P(2, 3),
    P(4, 4),
    [P(2, 3)],
    "position(t: number): number {",
    true,
  ),
];

// SCIP's definitions of that class and its method, at their names.
const classSymbols = (file: string, name: string) => [
  { file, at: P(1, 14), symbol: symbolOf(file, `${name}#`) },
  { file, at: P(2, 3), symbol: symbolOf(file, `${name}#position().`) },
];

const use = (file: string, at: Pos, symbol: string) => ({
  file,
  at,
  symbol,
  roles: 0,
});

const site = (
  id: number,
  file_id: number,
  at: Pos,
  enclosing_def_id: number,
  callee_name: string,
  receiver_text: string | null = null,
): CallSiteRow => ({
  id,
  file_id,
  line: at.line,
  col: at.col,
  enclosing_def_id,
  callee_name,
  receiver_text,
  producer: "ast-grep",
});

const target = (
  site_id: number,
  def_id: number,
  label: CallTargetRow["label"],
  collision: 0 | 1 = 0,
): CallTargetRow => ({ site_id, def_id, label, collision });

// kepler.test.ts imports both classes, makes an Orbit and calls its position. With SCIP, both
// calls are compiler-bound; at quick detail no SCIP ran.
const TWO_TEXT = lines(
  'import { Orbit } from "./kepler";',
  'import { Camera } from "../sky/camera";',
  "const orbit = new Orbit();",
  "orbit.position(0);",
);

function twoPositions(compiled: boolean): MergeInput {
  const made = spot(TWO_TEXT, 3, "Orbit()");
  const called = spot(TWO_TEXT, 4, "position");
  return mergeInput(
    { [CAMERA]: CAMERA_TEXT, [KEPLER]: KEPLER_TEXT, [TEST]: TWO_TEXT },
    {
      facts: {
        detail: compiled ? "standard" : "quick",
        astGrep: astGrep({
          defs: [...classDefs(KEPLER, "Orbit"), ...classDefs(CAMERA, "Camera")],
          calls: [
            callFact(TEST, made, "Orbit"),
            callFact(TEST, called, "position", "orbit"),
          ],
          imports: [
            importFact(
              TEST,
              spot(TWO_TEXT, 1, '"./kepler"'),
              "./kepler",
              "static",
              ["Orbit"],
            ),
            importFact(
              TEST,
              spot(TWO_TEXT, 2, '"../sky/camera"'),
              "../sky/camera",
              "static",
              ["Camera"],
            ),
          ],
        }),
        scip: compiled
          ? scip({
              documents: new Set([CAMERA, KEPLER, TEST]),
              definitions: [
                ...classSymbols(CAMERA, "Camera"),
                ...classSymbols(KEPLER, "Orbit"),
              ],
              uses: [
                use(TEST, made, symbolOf(KEPLER, "Orbit#")),
                use(TEST, called, symbolOf(KEPLER, "Orbit#position().")),
              ],
            })
          : null,
      },
    },
  );
}

// Files: 1 kepler.test.ts, 2 kepler.ts, 3 camera.ts. Definitions: 1 the test's <module>;
// 2 kepler.ts' <module>, 3 Orbit, 4 Orbit.position; 5 camera.ts' <module>, 6 Camera,
// 7 Camera.position.
const TWO_SITES = [
  site(1, 1, P(3, 19), 1, "Orbit"),
  site(2, 1, P(4, 7), 1, "position", "orbit"),
];

it("binds a call SCIP resolves and gives it no scoped row", () => {
  const { content, side } = mergeFacts(twoPositions(true));
  expect(content.call_sites).toEqual(TWO_SITES);
  // camera.ts is visible too, yet a bound site takes no scoped row
  expect(content.call_targets).toEqual([
    target(1, 3, "bound"),
    target(2, 4, "bound"),
  ]);
  expect(side.unmatchedBoundUses).toBe(0);
});

it("scopes a call whose position SCIP binds to two definitions", () => {
  const input = twoPositions(true);
  const called = spot(TWO_TEXT, 4, "position");
  const { content } = mergeFacts({
    ...input,
    scip: scip({
      ...input.scip,
      uses: [
        use(TEST, spot(TWO_TEXT, 3, "Orbit()"), symbolOf(KEPLER, "Orbit#")),
        use(TEST, called, symbolOf(CAMERA, "Camera#position().")),
        use(TEST, called, symbolOf(KEPLER, "Orbit#position().")),
      ],
    }),
  });
  expect(content.call_sites).toEqual(TWO_SITES);
  // no one definition is the call's: it is scoped, as if no compiler bound it
  expect(content.call_targets).toEqual([
    target(1, 3, "bound"),
    target(2, 4, "scoped", 1),
    target(2, 7, "scoped", 1),
  ]);
});

it("scopes a call through an interface to every visible definition of the name", () => {
  const BODY = "web/src/sky/body.ts";
  const BODY_TEXT = lines(
    "export interface Body {",
    "  position(t: number): number;",
    "}",
  );
  const RENDER = "web/src/sky/render.ts";
  const RENDER_TEXT = lines(
    'import type { Body } from "./body";',
    'import { Orbit } from "../orbits/kepler";',
    "export function drawSky(body: Body, t: number): number {",
    "  return body.position(t);",
    "}",
  );
  const called = spot(RENDER_TEXT, 4, "position");
  const input = mergeInput(
    {
      [BODY]: BODY_TEXT,
      [CAMERA]: CAMERA_TEXT,
      [KEPLER]: KEPLER_TEXT,
      [RENDER]: RENDER_TEXT,
    },
    {
      facts: {
        astGrep: astGrep({
          defs: [
            ...classDefs(KEPLER, "Orbit"),
            outlineDef(
              BODY,
              "Body",
              "type",
              P(1, 8),
              P(3, 2),
              [P(1, 18)],
              "export interface Body {",
              true,
            ),
            ...classDefs(CAMERA, "Camera"),
            outlineDef(
              RENDER,
              "drawSky",
              "function",
              P(3, 8),
              P(5, 2),
              [P(3, 17)],
              "export function drawSky(body: Body, t: number): number {",
              true,
            ),
          ],
          calls: [callFact(RENDER, called, "position", "body")],
          imports: [
            importFact(
              RENDER,
              spot(RENDER_TEXT, 1, '"./body"'),
              "./body",
              "type-only",
              ["Body"],
            ),
            importFact(
              RENDER,
              spot(RENDER_TEXT, 2, '"../orbits/kepler"'),
              "../orbits/kepler",
              "static",
              ["Orbit"],
            ),
          ],
        }),
        scip: scip({
          documents: new Set([BODY, CAMERA, KEPLER, RENDER]),
          definitions: [
            { file: BODY, at: P(1, 18), symbol: symbolOf(BODY, "Body#") },
            // an interface member, which no outline definition carries
            {
              file: BODY,
              at: P(2, 3),
              symbol: symbolOf(BODY, "Body#position()."),
            },
            ...classSymbols(CAMERA, "Camera"),
            ...classSymbols(KEPLER, "Orbit"),
            {
              file: RENDER,
              at: P(3, 17),
              symbol: symbolOf(RENDER, "drawSky()."),
            },
          ],
          // the compiler binds the call to Body's member, defined in the repo
          uses: [use(RENDER, called, symbolOf(BODY, "Body#position()."))],
        }),
      },
    },
  );
  const { content, side } = mergeFacts(input);
  // Files: 1 kepler.ts, 2 body.ts, 3 camera.ts, 4 render.ts. Definitions: 1 kepler.ts'
  // <module>, 2 Orbit, 3 Orbit.position; 4 body.ts' <module>, 5 Body; 6 camera.ts' <module>,
  // 7 Camera, 8 Camera.position; 9 render.ts' <module>, 10 drawSky.
  expect(content.call_sites).toEqual([
    site(1, 4, P(4, 15), 10, "position", "body"),
  ]);
  // render.ts imports kepler.ts and body.ts, not camera.ts: Orbit.position alone
  expect(content.call_targets).toEqual([target(1, 3, "scoped")]);
  // the use of Body#position, which joined no outline definition
  expect(side.unmatchedBoundUses).toBe(1);
});

it("scopes through a re-export and marks a collision", () => {
  const INDEX = "web/src/sky/index.ts";
  const CLOCK = "web/src/sky/clock.ts";
  const TEST_TEXT = lines(
    'import { Orbit } from "../sky/index";',
    "const o = new Orbit();",
    "o.position(1);",
  );
  const INDEX_TEXT = lines(
    'export { Orbit } from "../orbits/kepler";',
    'export * from "./camera";',
    'import "./clock";',
    "export const position = 1;",
  );
  const CLOCK_TEXT = lines(
    "export function position(): number {",
    "  return 0;",
    "}",
  );
  const input = mergeInput(
    {
      [CAMERA]: CAMERA_TEXT,
      [CLOCK]: CLOCK_TEXT,
      [INDEX]: INDEX_TEXT,
      [KEPLER]: KEPLER_TEXT,
      [TEST]: TEST_TEXT,
    },
    {
      facts: {
        astGrep: astGrep({
          defs: [
            ...classDefs(KEPLER, "Orbit"),
            ...classDefs(CAMERA, "Camera"),
            outlineDef(
              CLOCK,
              "position",
              "function",
              P(1, 8),
              P(3, 2),
              [P(1, 17)],
              "export function position(): number {",
              true,
            ),
            // a constant, which no call names
            outlineDef(
              INDEX,
              "position",
              "constant",
              P(4, 14),
              P(4, 26),
              [P(4, 14)],
              "export const position = 1;",
              true,
            ),
          ],
          calls: [
            callFact(TEST, spot(TEST_TEXT, 2, "Orbit"), "Orbit"),
            callFact(TEST, spot(TEST_TEXT, 3, "position"), "position", "o"),
          ],
          imports: [
            importFact(
              TEST,
              spot(TEST_TEXT, 1, '"../sky/index"'),
              "../sky/index",
              "static",
              ["Orbit"],
            ),
            importFact(
              INDEX,
              spot(INDEX_TEXT, 1, '"../orbits/kepler"'),
              "../orbits/kepler",
              "re-export",
              ["Orbit"],
            ),
            importFact(
              INDEX,
              spot(INDEX_TEXT, 2, '"./camera"'),
              "./camera",
              "re-export",
              ["*"],
            ),
            importFact(
              INDEX,
              spot(INDEX_TEXT, 3, '"./clock"'),
              "./clock",
              "side-effect",
            ),
          ],
        }),
      },
    },
  );
  const { content } = mergeFacts(input);
  // Files: 1 kepler.test.ts, 2 kepler.ts, 3 camera.ts, 4 clock.ts, 5 index.ts. Definitions:
  // 1 the test's <module>; 2 kepler.ts' <module>, 3 Orbit, 4 Orbit.position; 5 camera.ts'
  // <module>, 6 Camera, 7 Camera.position; 8 clock.ts' <module>, 9 position; 10 index.ts'
  // <module>, 11 the constant position.
  expect(content.call_sites).toEqual([
    site(1, 1, P(2, 15), 1, "Orbit"),
    site(2, 1, P(3, 3), 1, "position", "o"),
  ]);
  // index.ts re-exports kepler.ts and camera.ts, so the test sees both position methods; it
  // only imports clock.ts, whose position the test does not see; and its own position is a
  // constant
  expect(content.call_targets).toEqual([
    target(1, 3, "scoped"),
    target(2, 4, "scoped", 1),
    target(2, 7, "scoped", 1),
  ]);
});

it("gives no row to a call SCIP resolves outside the repo", () => {
  const STARS = "web/src/sky/stars.ts";
  const STARS_TEXT = lines(
    "export function map(n: number): number {",
    "  return n;",
    "}",
    "export const doubled = [1, 2].map((n) => n * 2);",
  );
  const called = spot(STARS_TEXT, 4, "map(");
  const input = mergeInput(
    { [STARS]: STARS_TEXT },
    {
      facts: {
        astGrep: astGrep({
          defs: [
            outlineDef(
              STARS,
              "map",
              "function",
              P(1, 8),
              P(3, 2),
              [P(1, 17)],
              "export function map(n: number): number {",
              true,
            ),
          ],
          calls: [callFact(STARS, called, "map")],
        }),
        scip: scip({
          documents: new Set([STARS]),
          definitions: [
            { file: STARS, at: P(1, 17), symbol: symbolOf(STARS, "map().") },
          ],
          // the TypeScript library's Array#map, which no repo document defines
          uses: [
            use(
              STARS,
              called,
              "scip-typescript npm typescript 6.0.3 lib/`lib.es5.d.ts`/Array#map().",
            ),
          ],
        }),
      },
    },
  );
  const { content, side } = mergeFacts(input);
  // Definitions: 1 <module>, 2 map
  expect(content.call_sites).toEqual([site(1, 1, P(4, 31), 1, "map")]);
  // the repo's own map is visible in the same file, and still takes no row
  expect(content.call_targets).toEqual([]);
  expect(side.unmatchedBoundUses).toBe(0);
});

it("scopes every call at quick detail, when SCIP did not run", () => {
  const { content, side } = mergeFacts(twoPositions(false));
  expect(content.call_sites).toEqual(TWO_SITES);
  expect(content.call_targets).toEqual([
    target(1, 3, "scoped"),
    target(2, 4, "scoped", 1),
    target(2, 7, "scoped", 1),
  ]);
  expect(side.unmatchedBoundUses).toBe(0);
});

it("counts a site with no target as unresolved", () => {
  const TEST_TEXT = lines(
    'import { Orbit } from "./kepler";',
    "const orbit = new Orbit();",
    "expect(orbit.position(0)).toBe(0);",
  );
  const called = spot(TEST_TEXT, 3, "position");
  const expected = spot(TEST_TEXT, 3, "expect");
  const input = mergeInput(
    { [KEPLER]: KEPLER_TEXT, [TEST]: TEST_TEXT },
    {
      facts: {
        astGrep: astGrep({
          defs: classDefs(KEPLER, "Orbit"),
          calls: [
            callFact(TEST, spot(TEST_TEXT, 2, "Orbit"), "Orbit"),
            callFact(TEST, expected, "expect"),
            callFact(TEST, called, "position", "orbit"),
            callFact(TEST, spot(TEST_TEXT, 3, "toBe"), "toBe"),
          ],
          imports: [
            importFact(
              TEST,
              spot(TEST_TEXT, 1, '"./kepler"'),
              "./kepler",
              "static",
              ["Orbit"],
            ),
          ],
        }),
        scip: scip({
          documents: new Set([KEPLER, TEST]),
          definitions: classSymbols(KEPLER, "Orbit"),
          uses: [
            use(
              TEST,
              expected,
              "scip-typescript npm vitest 4.0.0 dist/`index.d.ts`/expect().",
            ),
            use(TEST, called, symbolOf(KEPLER, "Orbit#position().")),
          ],
        }),
      },
    },
  );
  const merged = mergeFacts(input);
  // Definitions: 1 the test's <module>; 2 kepler.ts' <module>, 3 Orbit, 4 Orbit.position.
  // new Orbit() has no SCIP use and is scoped; expect resolves outside the repo; position is
  // bound; toBe has no SCIP use and no definition of its name in sight
  expect(merged.content.call_sites).toEqual([
    site(1, 1, P(2, 19), 1, "Orbit"),
    site(2, 1, P(3, 1), 1, "expect"),
    site(3, 1, P(3, 14), 1, "position", "orbit"),
    site(4, 1, P(3, 27), 1, "toBe"),
  ]);
  expect(merged.content.call_targets).toEqual([
    target(1, 3, "scoped"),
    target(3, 4, "bound"),
  ]);
  const coverage = coverageOf({
    input,
    ...merged,
    tiers: { "ast-grep": "ran", "scip-typescript": "ran" },
    cycleDifferences: 0,
  });
  expect(coverage.callSites).toEqual({ bound: 1, scoped: 1, unresolved: 2 });
});

it("attributes calls in anonymous callbacks to the nearest named definition, else the module", () => {
  const TEXT = lines(
    'describe("orbit", () => {',
    '  it("moves", () => {',
    "    expect(new Orbit().position(0)).toBe(0);",
    "  });",
    "});",
    "function check(list: number[]) {",
    "  function step(t: number) { return tick(t); }",
    "  return list.map((t) => step(t));",
    "}",
    "function draw() {}render();",
  );
  const input = mergeInput(
    { [TEST]: TEXT },
    {
      facts: {
        astGrep: astGrep({
          defs: [
            outlineDef(
              TEST,
              "check",
              "function",
              P(6, 1),
              P(9, 2),
              [P(6, 10)],
              "function check(list: number[]) {",
            ),
            outlineDef(
              TEST,
              "check.step",
              "function",
              P(7, 3),
              P(7, 47),
              [P(7, 12)],
              "function step(t: number) { return tick(t); }",
            ),
            outlineDef(
              TEST,
              "draw",
              "function",
              P(10, 1),
              P(10, 19),
              [P(10, 10)],
              "function draw() {}render();",
            ),
          ],
          calls: [
            // a fact given twice is one site
            callFact(TEST, spot(TEXT, 1, "describe"), "describe"),
            callFact(TEST, spot(TEXT, 1, "describe"), "describe"),
            callFact(TEST, spot(TEXT, 2, "it"), "it"),
            callFact(TEST, spot(TEXT, 3, "position"), "position"),
            callFact(TEST, spot(TEXT, 7, "tick"), "tick"),
            callFact(TEST, spot(TEXT, 8, "map"), "map", "list"),
            callFact(TEST, spot(TEXT, 8, "step"), "step"),
            callFact(TEST, spot(TEXT, 10, "render"), "render"),
          ],
        }),
      },
    },
  );
  const { content } = mergeFacts(input);
  // Definitions: 1 <module>, 2 check, 3 check.step, 4 draw. The it() blocks name nothing, so
  // their calls are the module's; the callback inside check is check's; step holds tick; a
  // call that starts where draw ends, just past its closing brace, is the module's
  expect(content.call_sites).toEqual([
    site(1, 1, P(1, 1), 1, "describe"),
    site(2, 1, P(2, 3), 1, "it"),
    site(3, 1, P(3, 24), 1, "position"),
    site(4, 1, P(7, 37), 3, "tick"),
    site(5, 1, P(8, 15), 2, "map", "list"),
    site(6, 1, P(8, 26), 2, "step"),
    site(7, 1, P(10, 19), 1, "render"),
  ]);
  expect(content.call_targets).toEqual([target(6, 3, "scoped")]);
});

it("makes a shell command a call site only when a shell file defines a function by its name, and scopes it through source alone", () => {
  const BASE = "scripts/base.sh";
  const CORE = "scripts/core.sh";
  const LIB = "scripts/lib.sh";
  const OTHER = "scripts/other.sh";
  const SYNC = "scripts/sync.sh";
  const input = mergeInput(
    {
      [BASE]: lines("source ./core.sh", "stamp() { date; }"),
      [CORE]: lines("now() { :; }"),
      [LIB]: lines("source ./base.sh", 'log() { echo "$1"; }'),
      [OTHER]: lines("helper() { :; }"),
      [SYNC]: lines(
        "source ./lib.sh",
        "log start",
        "echo done",
        "./other.sh",
        "helper",
        "stamp",
        "now",
      ),
    },
    {
      facts: {
        astGrep: astGrep({
          defs: [
            outlineDef(
              BASE,
              "stamp",
              "function",
              P(2, 1),
              P(2, 18),
              [P(2, 1)],
              "stamp() { date; }",
            ),
            outlineDef(
              CORE,
              "now",
              "function",
              P(1, 1),
              P(1, 13),
              [P(1, 1)],
              "now() { :; }",
            ),
            outlineDef(
              LIB,
              "log",
              "function",
              P(2, 1),
              P(2, 21),
              [P(2, 1)],
              'log() { echo "$1"; }',
            ),
            outlineDef(
              OTHER,
              "helper",
              "function",
              P(1, 1),
              P(1, 16),
              [P(1, 1)],
              "helper() { :; }",
            ),
          ],
          // every command is a call fact
          calls: [
            callFact(BASE, P(1, 1), "source"),
            callFact(BASE, P(2, 11), "date"),
            callFact(CORE, P(1, 9), ":"),
            callFact(LIB, P(1, 1), "source"),
            callFact(LIB, P(2, 9), "echo"),
            callFact(OTHER, P(1, 12), ":"),
            callFact(SYNC, P(1, 1), "source"),
            callFact(SYNC, P(2, 1), "log"),
            callFact(SYNC, P(3, 1), "echo"),
            callFact(SYNC, P(4, 1), "./other.sh"),
            callFact(SYNC, P(5, 1), "helper"),
            callFact(SYNC, P(6, 1), "stamp"),
            callFact(SYNC, P(7, 1), "now"),
          ],
          imports: [
            importFact(BASE, P(1, 8), "./core.sh", "source"),
            importFact(LIB, P(1, 8), "./base.sh", "source"),
            importFact(SYNC, P(1, 8), "./lib.sh", "source"),
            importFact(SYNC, P(4, 1), "./other.sh", "exec"),
          ],
        }),
      },
    },
  );
  const { content } = mergeFacts(input);
  // Files: 1 base.sh, 2 core.sh, 3 lib.sh, 4 other.sh, 5 sync.sh. Definitions: 1 base.sh's
  // <module>, 2 stamp; 3 core.sh's <module>, 4 now; 5 lib.sh's <module>, 6 log; 7 other.sh's
  // <module>, 8 helper; 9 sync.sh's <module>. date, echo, source, : and ./other.sh name no
  // shell function
  expect(content.call_sites).toEqual([
    site(1, 5, P(2, 1), 9, "log"),
    site(2, 5, P(5, 1), 9, "helper"),
    site(3, 5, P(6, 1), 9, "stamp"),
    site(4, 5, P(7, 1), 9, "now"),
  ]);
  // sync.sh sources lib.sh, which sources base.sh, which sources core.sh: it sees log, stamp
  // and now. It runs other.sh by path, which shares no function with it
  expect(content.call_targets).toEqual([
    target(1, 6, "scoped"),
    target(3, 2, "scoped"),
    target(4, 4, "scoped"),
  ]);
});

it("scopes a Python call through the imports a package's __init__.py makes", () => {
  const INIT = "sim/src/observatory/__init__.py";
  const CLOCK = "sim/src/observatory/clock.py";
  const ORBITS = "sim/src/observatory/kepler.py";
  const CHECK = "sim/tests/test_kepler.py";
  const input = mergeInput(
    {
      [INIT]: lines("from .kepler import Orbit"),
      [CLOCK]: lines("def position():", "    return 0"),
      [ORBITS]: lines(
        "from . import clock",
        "class Orbit:",
        "    def position(self, t):",
        "        return t",
      ),
      [CHECK]: lines("from observatory import Orbit", "Orbit().position(0)"),
    },
    {
      profile: SIM,
      facts: {
        astGrep: astGrep({
          defs: [
            outlineDef(
              CLOCK,
              "position",
              "function",
              P(1, 1),
              P(2, 13),
              [P(1, 5)],
              "def position():",
            ),
            outlineDef(
              ORBITS,
              "Orbit",
              "class",
              P(2, 1),
              P(4, 17),
              [P(2, 7)],
              "class Orbit:",
            ),
            outlineDef(
              ORBITS,
              "Orbit.position",
              "method",
              P(3, 5),
              P(4, 17),
              [P(3, 9)],
              "def position(self, t):",
            ),
          ],
          calls: [
            callFact(CHECK, P(2, 1), "Orbit"),
            callFact(CHECK, P(2, 9), "position"),
          ],
          imports: [
            importFact(INIT, P(1, 6), ".kepler", "static", ["Orbit"]),
            importFact(ORBITS, P(1, 6), ".", "static", ["clock"]),
            importFact(CHECK, P(1, 6), "observatory", "static", ["Orbit"]),
          ],
        }),
      },
    },
  );
  const { content } = mergeFacts(input);
  // Files: 1 __init__.py, 2 clock.py, 3 kepler.py, 4 test_kepler.py. Definitions:
  // 1 __init__.py's <module>; 2 clock.py's <module>, 3 position; 4 kepler.py's <module>,
  // 5 Orbit, 6 Orbit.position; 7 the test's <module>
  expect(content.call_sites).toEqual([
    site(1, 4, P(2, 1), 7, "Orbit"),
    site(2, 4, P(2, 9), 7, "position"),
  ]);
  // the test imports the package, whose __init__.py imports kepler.py: the test sees
  // kepler.py, but not clock.py, which only kepler.py imports
  expect(content.call_targets).toEqual([
    target(1, 5, "scoped"),
    target(2, 6, "scoped"),
  ]);
});

it("redacts a receiver before cutting it to 240 characters", () => {
  const FILE = "web/src/sky/link.ts";
  const github = join("gh", "p_", high(36));
  const RECEIVER = `${"x".repeat(220)}.${github}`;
  const TEXT = lines(`${RECEIVER}.connect();`);
  const input = mergeInput(
    { [FILE]: TEXT },
    {
      noSource: true,
      facts: {
        astGrep: astGrep({
          calls: [
            callFact(FILE, spot(TEXT, 1, "connect"), "connect", RECEIVER),
          ],
        }),
      },
    },
  );
  const { content, side } = mergeFacts(input);
  // the token straddles character 240: it is redacted first, then the mark is cut
  expect(content.call_sites).toEqual([
    site(
      1,
      1,
      P(1, RECEIVER.length + 2),
      1,
      "connect",
      `${"x".repeat(220)}.${mark("github-token").slice(0, 19)}`,
    ),
  ]);
  expect(side.redactions).toBe(1);
});
