// buildOutline over matches written by hand, in the shapes hakutaku's ast-grep rules give: a
// definition's match is its node (from the first decorator for Python), $NAME its name, $ACCESS
// a class member's accessibility keyword, and each <lang>-def-export match one exported name.
import { expect, it } from "vitest";
import type { RawMatch } from "../../../src/extract/drivers/ast-grep.js";
import type { OutlineDef, Pos } from "../../../src/extract/facts.js";
import { buildOutline } from "../../../src/extract/outline.js";

const P = (line: number, col: number): Pos => ({ line, col });

// A definition-rule match: its range, its $NAME (or none), the line at the name, and any
// other single captures.
function d(
  ruleId: string,
  file: string,
  start: Pos,
  end: Pos,
  name: [string, Pos] | null,
  nameLine: string,
  more: Record<string, [string, Pos]> = {},
): RawMatch {
  const vars: RawMatch["vars"] = {};
  const all = name === null ? more : { NAME: name, ...more };
  for (const [key, [text, at]] of Object.entries(all)) {
    vars[key] = { text, start: at, end: P(at.line, at.col + [...text].length) };
  }
  return { ruleId, file, start, end, vars, nameLine };
}

// An export marker: one exported name, its match the name itself.
const ex = (lang: string, file: string, name: string, at: Pos): RawMatch =>
  d(
    `${lang}-def-export`,
    file,
    at,
    P(at.line, at.col + name.length),
    [name, at],
    "",
  );

function def(
  file: string,
  qualname: string,
  kind: OutlineDef["kind"],
  start: Pos,
  end: Pos,
  nameAt: Pos[],
  signature: string,
  exportedSyntax = false,
): OutlineDef {
  const name = qualname.slice(qualname.lastIndexOf(".") + 1);
  return {
    file,
    qualname,
    name,
    kind,
    start,
    end,
    nameAt,
    exportedSyntax,
    signature,
  };
}

// web/orbit.ts                         sim/sky.py
//  1 class Orbit {                      1 class Sky:
//  2   position(t: number) {            2     def show(self):
//  3     return t;                      3         def helper():
//  4   }                                4             pass
//  5 }                                  5 def outer():
//  6 function outer() {                 6     def inner():
//  7   function inner() {}              7         pass
//  8 }
const NESTED: RawMatch[] = [
  d(
    "ts-def-class",
    "web/orbit.ts",
    P(1, 1),
    P(5, 2),
    ["Orbit", P(1, 7)],
    "class Orbit {",
  ),
  d(
    "ts-def-method",
    "web/orbit.ts",
    P(2, 3),
    P(4, 4),
    ["position", P(2, 3)],
    "  position(t: number) {",
  ),
  d(
    "ts-def-function",
    "web/orbit.ts",
    P(6, 1),
    P(8, 2),
    ["outer", P(6, 10)],
    "function outer() {",
  ),
  d(
    "ts-def-function",
    "web/orbit.ts",
    P(7, 3),
    P(7, 22),
    ["inner", P(7, 12)],
    "  function inner() {}",
  ),
  d(
    "py-def-class",
    "sim/sky.py",
    P(1, 1),
    P(4, 17),
    ["Sky", P(1, 7)],
    "class Sky:",
  ),
  d(
    "py-def-function",
    "sim/sky.py",
    P(2, 5),
    P(4, 17),
    ["show", P(2, 9)],
    "    def show(self):",
  ),
  d(
    "py-def-function",
    "sim/sky.py",
    P(3, 9),
    P(4, 17),
    ["helper", P(3, 13)],
    "        def helper():",
  ),
  d(
    "py-def-function",
    "sim/sky.py",
    P(5, 1),
    P(7, 13),
    ["outer", P(5, 5)],
    "def outer():",
  ),
  d(
    "py-def-function",
    "sim/sky.py",
    P(6, 5),
    P(7, 13),
    ["inner", P(6, 9)],
    "    def inner():",
  ),
];

const NESTED_OUTLINE: OutlineDef[] = [
  def("sim/sky.py", "Sky", "class", P(1, 1), P(4, 17), [P(1, 7)], "class Sky:"),
  def(
    "sim/sky.py",
    "Sky.show",
    "method",
    P(2, 5),
    P(4, 17),
    [P(2, 9)],
    "def show(self):",
  ),
  def(
    "sim/sky.py",
    "Sky.show.helper",
    "function",
    P(3, 9),
    P(4, 17),
    [P(3, 13)],
    "def helper():",
  ),
  def(
    "sim/sky.py",
    "outer",
    "function",
    P(5, 1),
    P(7, 13),
    [P(5, 5)],
    "def outer():",
  ),
  def(
    "sim/sky.py",
    "outer.inner",
    "function",
    P(6, 5),
    P(7, 13),
    [P(6, 9)],
    "def inner():",
  ),
  def(
    "web/orbit.ts",
    "Orbit",
    "class",
    P(1, 1),
    P(5, 2),
    [P(1, 7)],
    "class Orbit {",
  ),
  def(
    "web/orbit.ts",
    "Orbit.position",
    "method",
    P(2, 3),
    P(4, 4),
    [P(2, 3)],
    "position(t: number) {",
  ),
  def(
    "web/orbit.ts",
    "outer",
    "function",
    P(6, 1),
    P(8, 2),
    [P(6, 10)],
    "function outer() {",
  ),
  def(
    "web/orbit.ts",
    "outer.inner",
    "function",
    P(7, 3),
    P(7, 22),
    [P(7, 12)],
    "function inner() {}",
  ),
];

it("nests Orbit.position under Orbit and outer.inner under outer", () => {
  // a Python def directly in a class body is a method; one nested in a method is a function
  expect(buildOutline(NESTED)).toEqual(NESTED_OUTLINE);
});

it("orders the outline by file, then position, whatever order the matches come in", () => {
  expect(buildOutline([...NESTED].reverse())).toEqual(NESTED_OUTLINE);
});

it("nests a definition under one that starts at the same position but ends later", () => {
  // the shorter sorts first by rule id, so its parent must come from the range alone
  const f = "web/same.ts";
  expect(
    buildOutline([
      d(
        "ts-def-function",
        f,
        P(1, 1),
        P(3, 2),
        ["f", P(1, 10)],
        "function f() {",
      ),
      d("ts-def-class", f, P(1, 1), P(1, 12), ["C", P(1, 7)], "function f() {"),
    ]).map((o) => o.qualname),
  ).toEqual(["f", "f.C"]);
});

it("merges overload signatures with their implementation", () => {
  // web/solve.ts
  //  1 export function solve(a: number): number;
  //  2 export function solve(a: string): string;
  //  3 export function solve(a: unknown) {
  //  4   return a;
  //  5 }
  const f = "web/solve.ts";
  const outline = buildOutline([
    d(
      "ts-def-function-signature",
      f,
      P(1, 8),
      P(1, 42),
      ["solve", P(1, 17)],
      "export function solve(a: number): number;",
    ),
    ex("ts", f, "solve", P(1, 17)),
    d(
      "ts-def-function-signature",
      f,
      P(2, 8),
      P(2, 42),
      ["solve", P(2, 17)],
      "export function solve(a: string): string;",
    ),
    ex("ts", f, "solve", P(2, 17)),
    d(
      "ts-def-function",
      f,
      P(3, 8),
      P(5, 2),
      ["solve", P(3, 17)],
      "export function solve(a: unknown) {",
    ),
    ex("ts", f, "solve", P(3, 17)),
  ]);
  expect(outline).toEqual([
    def(
      f,
      "solve",
      "function",
      P(1, 8),
      P(5, 2),
      [P(1, 17), P(2, 17), P(3, 17)],
      "export function solve(a: number): number;",
      true,
    ),
  ]);
});

it("keeps a signature group with no implementation as one definition, and merges method overloads", () => {
  // web/sky.ts
  //  1 declare function look(a: number): void;
  //  2 declare function look(a: string): void;
  //  3 class Sky {
  //  4   draw(a: number): void;
  //  5   draw(a: unknown) {}
  //  6   fade(): void;
  //  7 }
  //  8 function other() {}
  const f = "web/sky.ts";
  expect(
    buildOutline([
      d(
        "ts-def-function-signature",
        f,
        P(1, 9),
        P(1, 40),
        ["look", P(1, 18)],
        "declare function look(a: number): void;",
      ),
      d(
        "ts-def-function-signature",
        f,
        P(2, 9),
        P(2, 40),
        ["look", P(2, 18)],
        "declare function look(a: string): void;",
      ),
      d("ts-def-class", f, P(3, 1), P(7, 2), ["Sky", P(3, 7)], "class Sky {"),
      d(
        "ts-def-method-signature",
        f,
        P(4, 3),
        P(4, 25),
        ["draw", P(4, 3)],
        "  draw(a: number): void;",
      ),
      d(
        "ts-def-method",
        f,
        P(5, 3),
        P(5, 22),
        ["draw", P(5, 3)],
        "  draw(a: unknown) {}",
      ),
      d(
        "ts-def-method-signature",
        f,
        P(6, 3),
        P(6, 16),
        ["fade", P(6, 3)],
        "  fade(): void;",
      ),
      d(
        "ts-def-function",
        f,
        P(8, 1),
        P(8, 20),
        ["other", P(8, 10)],
        "function other() {}",
      ),
    ]),
  ).toEqual([
    def(
      f,
      "look",
      "function",
      P(1, 9),
      P(2, 40),
      [P(1, 18), P(2, 18)],
      "declare function look(a: number): void;",
    ),
    def(f, "Sky", "class", P(3, 1), P(7, 2), [P(3, 7)], "class Sky {"),
    def(
      f,
      "Sky.draw",
      "method",
      P(4, 3),
      P(5, 22),
      [P(4, 3), P(5, 3)],
      "draw(a: number): void;",
    ),
    def(f, "Sky.fade", "method", P(6, 3), P(6, 16), [P(6, 3)], "fade(): void;"),
    def(
      f,
      "other",
      "function",
      P(8, 1),
      P(8, 20),
      [P(8, 10)],
      "function other() {}",
    ),
  ]);
});

it("takes a decorated Python def's range from its first decorator", () => {
  // sim/sky.py
  //  1 @cache
  //  2 @trace("look")
  //  3 def look():
  //  4     return 1
  //  5 class Sky:
  //  6     @property
  //  7     def show(self):
  //  8         return 2
  const f = "sim/sky.py";
  expect(
    buildOutline([
      d(
        "py-def-function",
        f,
        P(1, 1),
        P(4, 13),
        ["look", P(3, 5)],
        "def look():",
      ),
      d("py-def-class", f, P(5, 1), P(8, 17), ["Sky", P(5, 7)], "class Sky:"),
      d(
        "py-def-function",
        f,
        P(6, 5),
        P(8, 17),
        ["show", P(7, 9)],
        "    def show(self):",
      ),
    ]),
  ).toEqual([
    def(f, "look", "function", P(1, 1), P(4, 13), [P(3, 5)], "def look():"),
    def(f, "Sky", "class", P(5, 1), P(8, 17), [P(5, 7)], "class Sky:"),
    def(
      f,
      "Sky.show",
      "method",
      P(6, 5),
      P(8, 17),
      [P(7, 9)],
      "def show(self):",
    ),
  ]);
});

it("marks export keywords, export clauses and public members of exported classes", () => {
  // web/orbit.ts
  //  1 export class Orbit {                 9 export { helper };
  //  2   position(t: number) { return t; } 10 class Hidden { show() {} }
  //  3   private drift() {}                12 export const G = 6.674e-11;
  //  4   protected pull() {}               13 function local() { function inner() {} }
  //  5   #secret() {}                      14 module.exports.run = function () {};
  //  6   public spin() {}                  15 class Sky {}
  //  7 }                                   16 export default Sky;
  //  8 const helper = () => 1;             17 export { inner };
  // web/main.ts
  //  1 export default function () {}
  const f = "web/orbit.ts";
  const outline = buildOutline([
    d(
      "ts-def-class",
      f,
      P(1, 8),
      P(7, 2),
      ["Orbit", P(1, 14)],
      "export class Orbit {",
    ),
    ex("ts", f, "Orbit", P(1, 14)),
    d(
      "ts-def-method",
      f,
      P(2, 3),
      P(2, 36),
      ["position", P(2, 3)],
      "  position(t: number) { return t; }",
    ),
    d(
      "ts-def-method",
      f,
      P(3, 3),
      P(3, 21),
      ["drift", P(3, 11)],
      "  private drift() {}",
      { ACCESS: ["private", P(3, 3)] },
    ),
    d(
      "ts-def-method",
      f,
      P(4, 3),
      P(4, 22),
      ["pull", P(4, 13)],
      "  protected pull() {}",
      { ACCESS: ["protected", P(4, 3)] },
    ),
    d(
      "ts-def-method",
      f,
      P(5, 3),
      P(5, 15),
      ["#secret", P(5, 3)],
      "  #secret() {}",
    ),
    d(
      "ts-def-method",
      f,
      P(6, 3),
      P(6, 19),
      ["spin", P(6, 10)],
      "  public spin() {}",
      { ACCESS: ["public", P(6, 3)] },
    ),
    d(
      "ts-def-const-function",
      f,
      P(8, 7),
      P(8, 23),
      ["helper", P(8, 7)],
      "const helper = () => 1;",
    ),
    ex("ts", f, "helper", P(9, 10)),
    d(
      "ts-def-class",
      f,
      P(10, 1),
      P(10, 27),
      ["Hidden", P(10, 7)],
      "class Hidden { show() {} }",
    ),
    d(
      "ts-def-method",
      f,
      P(10, 16),
      P(10, 25),
      ["show", P(10, 16)],
      "class Hidden { show() {} }",
    ),
    d(
      "ts-def-constant",
      f,
      P(12, 14),
      P(12, 27),
      ["G", P(12, 14)],
      "export const G = 6.674e-11;",
    ),
    ex("ts", f, "G", P(12, 14)),
    d(
      "ts-def-function",
      f,
      P(13, 1),
      P(13, 42),
      ["local", P(13, 10)],
      "function local() { function inner() {} }",
    ),
    d(
      "ts-def-function",
      f,
      P(13, 20),
      P(13, 40),
      ["inner", P(13, 29)],
      "function local() { function inner() {} }",
    ),
    d(
      "ts-def-exports-function",
      f,
      P(14, 1),
      P(14, 36),
      ["run", P(14, 16)],
      "module.exports.run = function () {};",
    ),
    d(
      "ts-def-class",
      f,
      P(15, 1),
      P(15, 13),
      ["Sky", P(15, 7)],
      "class Sky {}",
    ),
    ex("ts", f, "Sky", P(16, 16)),
    ex("ts", f, "inner", P(17, 10)),
    d(
      "ts-def-default-function",
      "web/main.ts",
      P(1, 16),
      P(1, 30),
      null,
      "export default function () {}",
    ),
  ]);
  expect(outline).toEqual([
    def(
      "web/main.ts",
      "default",
      "function",
      P(1, 16),
      P(1, 30),
      [],
      "export default function () {}",
      true,
    ),
    def(
      f,
      "Orbit",
      "class",
      P(1, 8),
      P(7, 2),
      [P(1, 14)],
      "export class Orbit {",
      true,
    ),
    def(
      f,
      "Orbit.position",
      "method",
      P(2, 3),
      P(2, 36),
      [P(2, 3)],
      "position(t: number) { return t; }",
      true,
    ),
    def(
      f,
      "Orbit.drift",
      "method",
      P(3, 3),
      P(3, 21),
      [P(3, 11)],
      "private drift() {}",
    ),
    def(
      f,
      "Orbit.pull",
      "method",
      P(4, 3),
      P(4, 22),
      [P(4, 13)],
      "protected pull() {}",
    ),
    def(
      f,
      "Orbit.#secret",
      "method",
      P(5, 3),
      P(5, 15),
      [P(5, 3)],
      "#secret() {}",
    ),
    def(
      f,
      "Orbit.spin",
      "method",
      P(6, 3),
      P(6, 19),
      [P(6, 10)],
      "public spin() {}",
      true,
    ),
    def(
      f,
      "helper",
      "function",
      P(8, 7),
      P(8, 23),
      [P(8, 7)],
      "const helper = () => 1;",
      true,
    ),
    def(
      f,
      "Hidden",
      "class",
      P(10, 1),
      P(10, 27),
      [P(10, 7)],
      "class Hidden { show() {} }",
    ),
    def(
      f,
      "Hidden.show",
      "method",
      P(10, 16),
      P(10, 25),
      [P(10, 16)],
      "class Hidden { show() {} }",
    ),
    def(
      f,
      "G",
      "constant",
      P(12, 14),
      P(12, 27),
      [P(12, 14)],
      "export const G = 6.674e-11;",
      true,
    ),
    def(
      f,
      "local",
      "function",
      P(13, 1),
      P(13, 42),
      [P(13, 10)],
      "function local() { function inner() {} }",
    ),
    def(
      f,
      "local.inner",
      "function",
      P(13, 20),
      P(13, 40),
      [P(13, 29)],
      "function local() { function inner() {} }",
    ),
    def(
      f,
      "run",
      "function",
      P(14, 1),
      P(14, 36),
      [P(14, 16)],
      "module.exports.run = function () {};",
      true,
    ),
    def(
      f,
      "Sky",
      "class",
      P(15, 1),
      P(15, 13),
      [P(15, 7)],
      "class Sky {}",
      true,
    ),
  ]);
});

it("keeps the line at the name as the signature, at most 240 characters", () => {
  // 300 emoji: 240 characters is 240 code points, never 240 UTF-16 code units
  const long = `\texport const SKY = "${"😀".repeat(300)}";  `;
  const outline = buildOutline([
    d(
      "ts-def-constant",
      "web/long.ts",
      P(1, 15),
      P(1, 322),
      ["SKY", P(1, 15)],
      long,
    ),
    d(
      "py-def-function",
      "sim/look.py",
      P(1, 1),
      P(3, 9),
      ["look", P(2, 7)],
      "  def  look():   ",
    ),
  ]);
  // the name is on line 2 of the Python match, so its line, trimmed, is the signature
  expect(outline).toEqual([
    def(
      "sim/look.py",
      "look",
      "function",
      P(1, 1),
      P(3, 9),
      [P(2, 7)],
      "def  look():",
    ),
    def(
      "web/long.ts",
      "SKY",
      "constant",
      P(1, 15),
      P(1, 322),
      [P(1, 15)],
      `export const SKY = "${"😀".repeat(220)}`,
    ),
  ]);
  expect([...(outline[1]?.signature ?? "")]).toHaveLength(240);
});

it("drops a definition whose ID would not parse, with the definitions inside it", () => {
  // scripts/a.sh: a:b() { inner() { :; }; }, then sync() { :; }; a ":" in a qualname would read
  // as an external module's ID. Then f(2) holding g: "f(2)" would read as f's second repeat,
  // while "f(2).g" alone would parse, so g goes only because its parent does.
  const f = "scripts/a.sh";
  expect(
    buildOutline([
      d("sh-def-function", f, P(1, 1), P(3, 2), ["a:b", P(1, 1)], "a:b() {"),
      d(
        "sh-def-function",
        f,
        P(2, 3),
        P(2, 17),
        ["inner", P(2, 3)],
        "  inner() { :; }",
      ),
      d(
        "sh-def-function",
        f,
        P(4, 1),
        P(4, 14),
        ["sync", P(4, 1)],
        "sync() { :; }",
      ),
      // the module row's own qualname
      d(
        "sh-def-function",
        f,
        P(8, 1),
        P(8, 18),
        ["<module>", P(8, 1)],
        "<module>() { :; }",
      ),
      d("sh-def-function", f, P(5, 1), P(7, 2), ["f(2)", P(5, 1)], "f(2) {"),
      d(
        "sh-def-function",
        f,
        P(6, 3),
        P(6, 13),
        ["g", P(6, 3)],
        "  g() { :; }",
      ),
    ]),
  ).toEqual([
    def(f, "sync", "function", P(4, 1), P(4, 14), [P(4, 1)], "sync() { :; }"),
  ]);
});

it("keeps repeated qualnames as separate definitions, for the merge to number", () => {
  // web/orbit.ts: class Orbit { get x() {} set x(v) {} }, then function f() {} twice
  const f = "web/orbit.ts";
  expect(
    buildOutline([
      d(
        "ts-def-class",
        f,
        P(1, 1),
        P(1, 41),
        ["Orbit", P(1, 7)],
        "class Orbit { get x() {} set x(v) {} }",
      ),
      d(
        "ts-def-method",
        f,
        P(1, 15),
        P(1, 25),
        ["x", P(1, 19)],
        "class Orbit { get x() {} set x(v) {} }",
      ),
      d(
        "ts-def-method",
        f,
        P(1, 26),
        P(1, 39),
        ["x", P(1, 30)],
        "class Orbit { get x() {} set x(v) {} }",
      ),
      d(
        "ts-def-function",
        f,
        P(2, 1),
        P(2, 16),
        ["f", P(2, 10)],
        "function f() {}",
      ),
      d(
        "ts-def-function",
        f,
        P(3, 1),
        P(3, 16),
        ["f", P(3, 10)],
        "function f() {}",
      ),
    ]).map((o) => [o.qualname, o.start.line, o.start.col]),
  ).toEqual([
    ["Orbit", 1, 1],
    ["Orbit.x", 1, 15],
    ["Orbit.x", 1, 26],
    ["f", 2, 1],
    ["f", 3, 1],
  ]);
});

it("ignores call and import matches, and refuses a definition rule it does not know", () => {
  const call = d(
    "ts-call-call",
    "web/a.ts",
    P(1, 1),
    P(1, 4),
    ["sky", P(1, 1)],
    "",
  );
  const imp = d("py-import-static", "sim/a.py", P(1, 1), P(1, 10), null, "", {
    SPEC: ["os", P(1, 8)],
  });
  expect(buildOutline([call, imp])).toEqual([]);
  const unknown = d(
    "ts-def-namespace",
    "web/a.ts",
    P(1, 1),
    P(1, 20),
    ["N", P(1, 11)],
    "namespace N {}",
  );
  expect(() => buildOutline([unknown])).toThrow(
    "unknown ast-grep rule id: ts-def-namespace",
  );
});
