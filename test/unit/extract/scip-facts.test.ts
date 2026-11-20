// scipFacts over decoded indexes written here, with the store's lines of each file. Symbols
// are written as scip-typescript names them: a package, then one namespace per path segment of
// the file, backtick-escaped unless it is a simple identifier.
import { expect, it } from "vitest";
import type { ScipIndex } from "../../../src/extract/scip/decode.js";
import { positionKey, scipFacts } from "../../../src/extract/scip/facts.js";

type Doc = ScipIndex["documents"][number];
type Occurrence = Doc["occurrences"][number];

const occ = (range: number[], symbol: string, roles = 0): Occurrence => ({
  range,
  symbol,
  roles,
  enclosingRange: [],
});

const doc = (
  relativePath: string,
  occurrences: Occurrence[],
  positionEncoding = 0,
): Doc => ({ relativePath, positionEncoding, occurrences });

const index = (...documents: Doc[]): ScipIndex => ({ documents });

const lines = (...text: string[]): string => `${text.join("\n")}\n`;

// The store's lines of each file: its text split at LF, each line without the CR of a CRLF.
function linesOf(
  files: Record<string, string>,
): (file: string, line0: number) => string {
  return (file, line0) => {
    const text = files[file];
    if (text === undefined) throw new Error(`no file ${file}`);
    const line = text.split("\n")[line0];
    if (line === undefined) throw new Error(`${file} has no line ${line0 + 1}`);
    return line.endsWith("\r") ? line.slice(0, -1) : line;
  };
}

const PKG = "scip-typescript npm observatory 0.1.0 ";
const LIB = "scip-typescript npm typescript 6.0.3 ";

const escapeName = (name: string): string =>
  /^[\w$+-]+$/.test(name) ? name : `\`${name.replaceAll("`", "``")}\``;

const moduleOf = (path: string, pkg = PKG): string =>
  `${pkg}${path.split("/").map(escapeName).join("/")}/`;

const ORBIT = moduleOf("src/orbit.ts");

const ORBIT_TS = lines(
  "export class Orbit {",
  "  position(t: number): number {",
  "    return t * 2;",
  "  }",
  "}",
);

it("separates definitions from uses by role", () => {
  const facts = scipFacts(
    index(
      doc("src/orbit.ts", [
        occ([0, 0, 0], ORBIT, 1),
        occ([0, 13, 18], `${ORBIT}Orbit#`, 1),
        // the definition bit, with the generated bit beside it
        occ([1, 2, 10], `${ORBIT}Orbit#position().`, 1 | 16),
        occ([1, 11, 12], `${ORBIT}Orbit#position().(t)`, 1),
        // a read and a write are uses
        occ([2, 11, 12], `${ORBIT}Orbit#position().(t)`, 8),
        occ([2, 4, 10], "local 0", 4),
      ]),
    ),
    linesOf({ "src/orbit.ts": ORBIT_TS }),
  );
  expect(facts.documents).toStrictEqual(new Set(["src/orbit.ts"]));
  expect(facts.definitions).toStrictEqual([
    { file: "src/orbit.ts", at: { line: 1, col: 1 }, symbol: ORBIT },
    {
      file: "src/orbit.ts",
      at: { line: 1, col: 14 },
      symbol: `${ORBIT}Orbit#`,
    },
    {
      file: "src/orbit.ts",
      at: { line: 2, col: 3 },
      symbol: `${ORBIT}Orbit#position().`,
    },
    {
      file: "src/orbit.ts",
      at: { line: 2, col: 12 },
      symbol: `${ORBIT}Orbit#position().(t)`,
    },
  ]);
  expect(facts.uses).toStrictEqual([
    {
      file: "src/orbit.ts",
      at: { line: 3, col: 5 },
      symbol: "local 0",
      roles: 4,
    },
    {
      file: "src/orbit.ts",
      at: { line: 3, col: 12 },
      symbol: `${ORBIT}Orbit#position().(t)`,
      roles: 8,
    },
  ]);
});

it("converts UTF-16 positions to code points", () => {
  const grin = String.fromCodePoint(0x1f600);
  const text = `${grin}${grin} orbit.position(0)\n`;
  const position = `${ORBIT}Orbit#position().`;
  // each emoji is two UTF-16 code units, so orbit starts at unit 5 and position at unit 11
  const at = (encoding: number) =>
    scipFacts(
      index(
        doc(
          "test/orbit.test.ts",
          [occ([0, 5, 10], "local 0"), occ([0, 11, 19], position)],
          encoding,
        ),
      ),
      linesOf({ "test/orbit.test.ts": text }),
    ).uses.map((u) => u.at);
  expect(at(2)).toStrictEqual([
    { line: 1, col: 4 },
    { line: 1, col: 10 },
  ]);
  // scip-typescript leaves the encoding unspecified (0): its positions are TypeScript's, in
  // UTF-16 code units
  expect(at(0)).toStrictEqual(at(2));
});

it("reads positions as TypeScript reads a file: without its byte order mark, and with CR, U+2028 and U+2029 ending lines", () => {
  const bom = String.fromCodePoint(0xfeff);
  const ls = String.fromCodePoint(0x2028);
  const ps = String.fromCodePoint(0x2029);
  const files = {
    "src/bom.ts": lines(
      `${bom}export const bom = 1;`,
      "export const two = bom;",
    ),
    // one line in the store: TypeScript ends a line at each lone CR
    "src/cr.ts": lines(
      "export const c = 1;\r// lone cr\rexport function lone(): number { return c; }",
    ),
    "src/crlf.ts":
      "export const d = 1;\r\nexport function crlf(): number { return d; }\r\n",
    "src/ls.ts": lines(
      `export const a = "x${ls}y${ps}z";`,
      "export function after(): number { return 1; }",
    ),
  };
  const m = (path: string, name: string) => `${moduleOf(path)}${name}`;
  const facts = scipFacts(
    index(
      doc("src/bom.ts", [
        occ([0, 13, 16], m("src/bom.ts", "bom."), 1),
        occ([1, 13, 16], m("src/bom.ts", "two."), 1),
        occ([1, 19, 22], m("src/bom.ts", "bom.")),
      ]),
      doc("src/cr.ts", [
        occ([0, 13, 14], m("src/cr.ts", "c."), 1),
        occ([2, 16, 20], m("src/cr.ts", "lone()."), 1),
        occ([2, 40, 41], m("src/cr.ts", "c.")),
      ]),
      doc("src/crlf.ts", [
        occ([0, 13, 14], m("src/crlf.ts", "d."), 1),
        occ([1, 16, 20], m("src/crlf.ts", "crlf()."), 1),
        occ([1, 40, 41], m("src/crlf.ts", "d.")),
      ]),
      doc("src/ls.ts", [
        occ([0, 13, 14], m("src/ls.ts", "a."), 1),
        // the y after U+2028 and the z after U+2029
        occ([1, 0, 1], "local 1"),
        occ([2, 0, 1], "local 2"),
        occ([3, 16, 21], m("src/ls.ts", "after()."), 1),
      ]),
    ),
    linesOf(files),
  );
  const at = (f: { file: string; at: { line: number; col: number } }) => [
    f.file,
    f.at.line,
    f.at.col,
  ];
  expect(facts.definitions.map(at)).toStrictEqual([
    // the mark is the first column of the store's line 1
    ["src/bom.ts", 1, 15],
    ["src/bom.ts", 2, 14],
    ["src/cr.ts", 1, 14],
    ["src/cr.ts", 1, 48],
    ["src/crlf.ts", 1, 14],
    ["src/crlf.ts", 2, 17],
    ["src/ls.ts", 1, 14],
    ["src/ls.ts", 2, 17],
  ]);
  expect(facts.uses.map(at)).toStrictEqual([
    ["src/bom.ts", 2, 20],
    ["src/cr.ts", 1, 72],
    ["src/crlf.ts", 2, 41],
    ["src/ls.ts", 1, 21],
    ["src/ls.ts", 1, 23],
  ]);
});

it("reads UTF-8 and UTF-32 positions too, and refuses an unknown encoding", () => {
  const text = `${String.fromCodePoint(0xe9, 0x1f600)} orbit\n`;
  // orbit starts at UTF-8 byte 7, UTF-16 unit 4 and code point 3: column 4
  const at = (range: number[], encoding: number) =>
    scipFacts(
      index(doc("a.ts", [occ(range, "local 0")], encoding)),
      linesOf({ "a.ts": text }),
    ).uses[0]?.at;
  expect(at([0, 7, 12], 1)).toStrictEqual({ line: 1, col: 4 });
  expect(at([0, 4, 9], 2)).toStrictEqual({ line: 1, col: 4 });
  expect(at([0, 3, 8], 3)).toStrictEqual({ line: 1, col: 4 });
  expect(() => at([0, 3, 8], 4)).toThrow(
    /^SCIP document a\.ts uses position encoding 4, which hakutaku does not read$/,
  );
});

it("counts a symbol defined in two matching documents as a duplicate, and a lib symbol never", () => {
  // Two packages with one name and version name their files alike, so both index.ts files
  // define the same symbols. A lib symbol a repo file augments, a local symbol, and a symbol of
  // another file's module (a module augmentation) are defined in two documents too, but
  // never in two documents that are the file the symbol names.
  const sky = moduleOf("src/index.ts", "scip-typescript npm sky 1.0.0 ");
  const sum = `${LIB}lib/\`lib.es5.d.ts\`/Array#sum().`;
  const augment = moduleOf("src/augment.ts");
  const files: Record<string, string> = {};
  const file = (path: string) => {
    files[path] = lines("export function draw(): number { return 1; }");
    return path;
  };
  const facts = scipFacts(
    index(
      doc(file("web/a/src/index.ts"), [
        occ([0, 0, 0], sky, 1),
        occ([0, 16, 20], `${sky}draw().`, 1),
        occ([0, 7, 15], "local 0", 1),
      ]),
      doc(file("web/b/src/index.ts"), [
        occ([0, 0, 0], sky, 1),
        occ([0, 16, 20], `${sky}draw().`, 1),
        occ([0, 7, 15], "local 0", 1),
      ]),
      doc(file("src/a.ts"), [
        occ([0, 0, 0], moduleOf("src/a.ts"), 1),
        occ([0, 16, 20], sum, 1),
      ]),
      doc(file("src/b.ts"), [
        occ([0, 0, 0], moduleOf("src/b.ts"), 1),
        occ([0, 16, 20], sum, 1),
      ]),
      doc(file("src/orbit.ts"), [
        occ([0, 0, 0], ORBIT, 1),
        occ([0, 16, 20], `${ORBIT}Orbit#tilt().`, 1),
      ]),
      doc(file("src/augment.ts"), [
        occ([0, 0, 0], augment, 1),
        occ([0, 16, 20], `${ORBIT}Orbit#tilt().`, 1),
      ]),
    ),
    linesOf(files),
  );
  expect(facts.duplicates).toStrictEqual([sky, `${sky}draw().`]);
});

it("maps an import specifier's module symbol to its document", () => {
  const body = moduleOf("src/body.ts");
  const render = moduleOf("src/render.ts");
  const sky = moduleOf("src/index.ts", "scip-typescript npm sky 1.0.0 ");
  const files = {
    "src/body.ts": lines(
      "export interface Body {",
      "  position(t: number): number;",
      "}",
    ),
    "src/render.ts": lines(
      'import type { Body } from "./body";',
      'import { Geometry } from "./geometry";',
      'import { draw } from "@obs/sky";',
      "export const area = Geometry.area;",
      "export const n = [].length;",
    ),
    "src/geometry.ts": lines(
      "export namespace Geometry { export const area = 1; }",
    ),
    "web/a/src/index.ts": lines("export function draw(): number { return 1; }"),
    "web/b/src/index.ts": lines("export function draw(): number { return 1; }"),
  };
  const geometry = moduleOf("src/geometry.ts");
  const facts = scipFacts(
    index(
      doc("src/body.ts", [
        occ([0, 0, 0], body, 1),
        occ([0, 17, 21], `${body}Body#`, 1),
      ]),
      doc("src/geometry.ts", [
        occ([0, 0, 0], geometry, 1),
        occ([0, 17, 25], `${geometry}Geometry/`, 1),
      ]),
      doc("src/render.ts", [
        occ([0, 0, 0], render, 1),
        // the specifier, from its opening quote: the module of src/body.ts
        occ([0, 26, 34], body),
        occ([1, 25, 37], geometry),
        // a module two documents define is left out
        occ([2, 21, 31], sky),
        // a TypeScript namespace also ends in "/", but is no document's module
        occ([3, 20, 28], `${geometry}Geometry/`),
        // nor is a file of the TypeScript lib
        occ([4, 20, 26], `${LIB}lib/\`lib.es5.d.ts\`/`),
      ]),
      doc("web/a/src/index.ts", [occ([0, 0, 0], sky, 1)]),
      doc("web/b/src/index.ts", [occ([0, 0, 0], sky, 1)]),
    ),
    linesOf(files),
  );
  expect(facts.moduleAt).toStrictEqual(
    new Map([
      [positionKey("src/render.ts", { line: 1, col: 27 }), "src/body.ts"],
      [positionKey("src/render.ts", { line: 2, col: 26 }), "src/geometry.ts"],
    ]),
  );
  expect(positionKey("src/render.ts", { line: 1, col: 27 })).toBe(
    "src/render.ts:1:27",
  );
  // a module's own definition, at the start of its file, is no import
  expect([...facts.moduleAt.keys()].some((k) => k.endsWith(":1:1"))).toBe(
    false,
  );
});

it("leaves out a position whose module symbols name two documents", () => {
  const a = moduleOf("src/a.ts");
  const b = moduleOf("src/b.ts");
  const files = {
    "src/a.ts": lines("export const a = 1;"),
    "src/b.ts": lines("export const b = 1;"),
    "src/use.ts": lines('export * from "./a";', 'export * from "./b";'),
  };
  const facts = scipFacts(
    index(
      doc("src/a.ts", [occ([0, 0, 0], a, 1)]),
      doc("src/b.ts", [occ([0, 0, 0], b, 1)]),
      doc("src/use.ts", [
        occ([0, 14, 19], a),
        occ([0, 14, 19], b),
        occ([1, 14, 19], b),
        // the same module twice at one position is still one
        occ([1, 14, 19], b, 8),
      ]),
    ),
    linesOf(files),
  );
  expect(facts.moduleAt).toStrictEqual(
    new Map([[positionKey("src/use.ts", { line: 2, col: 15 }), "src/b.ts"]]),
  );
});

it("names a module's file by its escaped segments", () => {
  // a backtick in a file name is doubled inside the escape
  const path = "web/sky map/o`rbit-2.ts";
  const files = {
    [path]: lines("export const o = 1;"),
    "src/use.ts": lines('import { o } from "../web/sky map/o`rbit-2";'),
  };
  const facts = scipFacts(
    index(
      doc(path, [occ([0, 0, 0], moduleOf(path), 1)]),
      doc("src/use.ts", [
        occ([0, 0, 0], moduleOf("src/use.ts"), 1),
        occ([0, 18, 43], moduleOf(path)),
      ]),
    ),
    linesOf(files),
  );
  expect(moduleOf(path)).toBe(`${PKG}web/\`sky map\`/\`o\`\`rbit-2.ts\`/`);
  expect(facts.moduleAt).toStrictEqual(
    new Map([[positionKey("src/use.ts", { line: 1, col: 19 }), path]]),
  );
});

it("sorts and dedupes its facts whatever order the index lists them in, and skips an occurrence that names no symbol", () => {
  const position = `${ORBIT}Orbit#position().`;
  const files = {
    "src/orbit.ts": ORBIT_TS,
    "test/orbit.test.ts": lines(
      'import { Orbit } from "../src/orbit";',
      "new Orbit().position(0);",
    ),
  };
  const ordered = index(
    doc("src/orbit.ts", [
      occ([0, 0, 0], ORBIT, 1),
      occ([0, 13, 18], `${ORBIT}Orbit#`, 1),
      occ([1, 2, 10], position, 1),
    ]),
    doc("test/orbit.test.ts", [
      occ([0, 0, 0], moduleOf("test/orbit.test.ts"), 1),
      occ([0, 9, 14], `${ORBIT}Orbit#`),
      occ([0, 22, 36], ORBIT),
      occ([1, 4, 9], `${ORBIT}Orbit#`),
      occ([1, 12, 20], position, 8),
    ]),
  );
  const [first, second] = ordered.documents as [Doc, Doc];
  // the same facts listed backwards, a document split in two, occurrences repeated, and one
  // with no symbol
  const shuffled = index(
    doc("test/orbit.test.ts", [...second.occurrences].reverse().slice(0, 2)),
    doc("src/orbit.ts", [...first.occurrences].reverse()),
    doc("test/orbit.test.ts", [
      ...second.occurrences,
      occ([1, 0, 3], ""),
      // the module's definition and two uses, again
      ...second.occurrences.slice(0, 3),
    ]),
  );
  const want = scipFacts(ordered, linesOf(files));
  const got = scipFacts(shuffled, linesOf(files));
  expect(got).toStrictEqual(want);
  expect([...got.documents]).toStrictEqual([
    "src/orbit.ts",
    "test/orbit.test.ts",
  ]);
  expect(got.uses.map((u) => [u.file, u.at.line, u.at.col])).toStrictEqual([
    ["test/orbit.test.ts", 1, 10],
    ["test/orbit.test.ts", 1, 23],
    ["test/orbit.test.ts", 2, 5],
    ["test/orbit.test.ts", 2, 13],
  ]);
  expect(got.definitions).toHaveLength(4);
});

it.each<[string, Doc, RegExp]>([
  [
    "a path out of the repo",
    doc("../x.ts", []),
    /^SCIP document "\.\.\/x\.ts" is not a repo path$/,
  ],
  ["an absolute path", doc("/x.ts", []), /is not a repo path/],
  ["an empty segment", doc("src//x.ts", []), /is not a repo path/],
  ["an empty path", doc("", []), /is not a repo path/],
  [
    "a range of two numbers",
    doc("a.ts", [occ([0, 1], "local 0")]),
    /^SCIP occurrence in a\.ts has the range \[0,1\], not three or four numbers from 0$/,
  ],
  [
    "a range of five numbers",
    doc("a.ts", [occ([0, 1, 0, 2, 3], "local 0")]),
    /not three or four numbers/,
  ],
  [
    "a negative range",
    doc("a.ts", [occ([0, -1, 2], "local 0")]),
    /not three or four numbers/,
  ],
  [
    "a column past its line",
    doc("a.ts", [occ([0, 25, 26], "local 0")]),
    /^SCIP occurrence in a\.ts starts at line 0, character 25, past the end of its line$/,
  ],
  [
    "a column past a line TypeScript ends at a lone CR",
    doc("cr.ts", [occ([0, 25, 26], "local 0")]),
    /past the end of its line/,
  ],
])("refuses %s", (_, document, error) => {
  const files = {
    "a.ts": lines("export const a = 1;"),
    "cr.ts": lines("export const c = 1;\r// lone cr"),
  };
  expect(() => scipFacts(index(document), linesOf(files))).toThrow(error);
});

it("refuses a line past the end of its file", () => {
  expect(() =>
    scipFacts(
      index(doc("a.ts", [occ([5, 0, 1], "local 0")])),
      linesOf({ "a.ts": lines("export const a = 1;") }),
    ),
  ).toThrow("a.ts has no line 3");
});
