// ast-grep's stream: canned lines in the pinned version's format (ast-grep 0.51.1, `scan
// --json=stream`), as it wrote them for web/sky.ts below, with the snapshot directory renamed
// /export/snapshot. That version counts columns from 0 in code points, not in UTF-8 bytes.
import { expect, it } from "vitest";
import type { ExtractContext } from "../../../src/extract/context.js";
import {
  astGrepDriver,
  astGrepFacts,
  excludeGlob,
  parseAstGrepStream,
  type RawMatch,
} from "../../../src/extract/drivers/ast-grep.js";
import type { Pos } from "../../../src/extract/facts.js";

const SNAP = "/export/snapshot";

// web/sky.ts, byte for byte: é is 2 bytes and the emoji 4, so on line 2 the definition starts
// at byte 13 but at code point 9 (0-based).
const SKY = [
  'const sky = "é";',
  "/* é😀 */ function orbit(t: number) {",
  "  return sky.at(t);",
  "}",
  "",
].join("\n");

const DEF_LINE =
  '{"text":"function orbit(t: number) {\\n  return sky.at(t);\\n}","range":{"byteOffset":{"start":31,"end":80},"start":{"line":1,"column":9},"end":{"line":3,"column":1}},"file":"/export/snapshot/web/sky.ts","lines":"/* é😀 */ function orbit(t: number) {\\n  return sky.at(t);\\n}","charCount":{"leading":9,"trailing":0},"language":"TypeScript","metaVariables":{"single":{"NAME":{"text":"orbit","range":{"byteOffset":{"start":40,"end":45},"start":{"line":1,"column":18},"end":{"line":1,"column":23}}}},"multi":{"secondary":[{"text":"orbit","range":{"byteOffset":{"start":40,"end":45},"start":{"line":1,"column":18},"end":{"line":1,"column":23}}}]},"transformed":{}},"ruleId":"ts-def-function","severity":"hint","note":null,"message":"","labels":[{"text":"function orbit(t: number) {\\n  return sky.at(t);\\n}","range":{"byteOffset":{"start":31,"end":80},"start":{"line":1,"column":9},"end":{"line":3,"column":1}},"style":"primary"},{"text":"orbit","range":{"byteOffset":{"start":40,"end":45},"start":{"line":1,"column":18},"end":{"line":1,"column":23}},"style":"secondary"}]}';

const CALL_LINE =
  '{"text":"at","range":{"byteOffset":{"start":72,"end":74},"start":{"line":2,"column":13},"end":{"line":2,"column":15}},"file":"/export/snapshot/web/sky.ts","lines":"  return sky.at(t);","charCount":{"leading":13,"trailing":4},"language":"TypeScript","metaVariables":{"single":{"NAME":{"text":"at","range":{"byteOffset":{"start":72,"end":74},"start":{"line":2,"column":13},"end":{"line":2,"column":15}}},"RECV":{"text":"sky","range":{"byteOffset":{"start":68,"end":71},"start":{"line":2,"column":9},"end":{"line":2,"column":12}}}},"multi":{"secondary":[{"text":"sky","range":{"byteOffset":{"start":68,"end":71},"start":{"line":2,"column":9},"end":{"line":2,"column":12}}}]},"transformed":{}},"ruleId":"ts-call-call","severity":"hint","note":null,"message":"","labels":[{"text":"at","range":{"byteOffset":{"start":72,"end":74},"start":{"line":2,"column":13},"end":{"line":2,"column":15}},"style":"primary"},{"text":"sky","range":{"byteOffset":{"start":68,"end":71},"start":{"line":2,"column":9},"end":{"line":2,"column":12}},"style":"secondary"}]}';

// The raw lines of files given as bytes, without their line feeds, recording each request.
function linesOf(files: Record<string, Uint8Array>) {
  const asked: Array<[string, number]> = [];
  const rawLine = (file: string, line0: number): Uint8Array => {
    asked.push([file, line0]);
    const bytes = files[file];
    if (bytes === undefined) throw new Error(`no file ${file}`);
    let start = 0;
    for (let n = 0; n < line0; n++) start = bytes.indexOf(0x0a, start) + 1;
    const end = bytes.indexOf(0x0a, start);
    return bytes.subarray(start, end === -1 ? bytes.length : end);
  };
  return { rawLine, asked };
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const P = (line: number, col: number): Pos => ({ line, col });

// One stream line, as ast-grep writes it, for a match with the given single captures.
function streamLine(
  ruleId: string,
  file: string,
  start: [number, number],
  end: [number, number],
  single: Record<string, [string, [number, number], [number, number]]> = {},
): string {
  const range = (s: [number, number], e: [number, number]) => ({
    byteOffset: { start: 0, end: 0 },
    start: { line: s[0], column: s[1] },
    end: { line: e[0], column: e[1] },
  });
  const vars: Record<string, unknown> = {};
  for (const [name, [text, s, e]] of Object.entries(single)) {
    vars[name] = { text, range: range(s, e) };
  }
  return JSON.stringify({
    text: "",
    range: range(start, end),
    file: `${SNAP}/${file}`,
    lines: "",
    language: "TypeScript",
    metaVariables: { single: vars, multi: {}, transformed: {} },
    ruleId,
    severity: "hint",
    note: null,
    message: "",
    labels: [],
  });
}

it("parses a stream line into a match with 1-based code-point positions", () => {
  const { rawLine, asked } = linesOf({ "web/sky.ts": utf8(SKY) });
  const matches = parseAstGrepStream(`${DEF_LINE}\n`, SNAP, rawLine);
  // the definition starts after "/* é😀 */ ": 9 code points, so column 10, though it is byte 13
  expect(matches).toEqual([
    {
      ruleId: "ts-def-function",
      file: "web/sky.ts",
      start: P(2, 10),
      end: P(4, 2),
      vars: { NAME: { text: "orbit", start: P(2, 19), end: P(2, 24) } },
      nameLine: "/* é😀 */ function orbit(t: number) {",
    },
  ] satisfies RawMatch[]);
  expect(asked).toEqual([["web/sky.ts", 1]]);
});

it("keeps every single capture with its positions, and reads no line for a call", () => {
  const { rawLine, asked } = linesOf({ "web/sky.ts": utf8(SKY) });
  expect(parseAstGrepStream(CALL_LINE, SNAP, rawLine)).toEqual([
    {
      ruleId: "ts-call-call",
      file: "web/sky.ts",
      start: P(3, 14),
      end: P(3, 16),
      vars: {
        NAME: { text: "at", start: P(3, 14), end: P(3, 16) },
        RECV: { text: "sky", start: P(3, 10), end: P(3, 13) },
      },
      nameLine: "",
    },
  ] satisfies RawMatch[]);
  expect(asked).toEqual([]);
});

it("reads the name line at $NAME, decoded as the store decodes text", () => {
  // a decorated def starts at its decorator; its name is two lines down, in a CRLF file
  // holding a byte that is not UTF-8
  const file = Uint8Array.from([
    ...utf8("@cache\r\n@trace\r\ndef look(\xff"),
    0xff,
    ...utf8("):\r\n    pass\r\n"),
  ]);
  const { rawLine, asked } = linesOf({ "sim/sky.py": file });
  const line = streamLine("py-def-function", "sim/sky.py", [0, 0], [3, 8], {
    NAME: ["look", [2, 4], [2, 8]],
  });
  const [match] = parseAstGrepStream(line, SNAP, rawLine);
  expect(asked).toEqual([["sim/sky.py", 2]]);
  // U+00FF as written, the lone byte as U+FFFD, and no CR
  expect(match?.nameLine).toBe(
    `def look(${String.fromCodePoint(0xff, 0xfffd)}):`,
  );
  expect(match?.start).toEqual(P(1, 1));
  expect(match?.vars.NAME?.start).toEqual(P(3, 5));
});

it("reads the match's first line for a definition with no name", () => {
  const { rawLine, asked } = linesOf({
    "web/main.ts": utf8("// sky\nexport default function () {}\n"),
  });
  const line = streamLine(
    "ts-def-default-function",
    "web/main.ts",
    [1, 15],
    [1, 29],
  );
  expect(parseAstGrepStream(line, SNAP, rawLine)[0]?.nameLine).toBe(
    "export default function () {}",
  );
  expect(asked).toEqual([["web/main.ts", 1]]);
});

it("orders matches by file, then start, then rule id, whatever order ast-grep wrote them in", () => {
  const { rawLine } = linesOf({});
  const lines = [
    streamLine("ts-call-new", "web/b.ts", [0, 4], [0, 9], {
      NAME: ["Sky", [0, 4], [0, 7]],
    }),
    streamLine("ts-call-call", "web/b.ts", [0, 4], [0, 9], {
      NAME: ["sky", [0, 4], [0, 7]],
    }),
    streamLine("ts-call-call", "web/a.ts", [3, 0], [3, 2], {
      NAME: ["f", [3, 0], [3, 1]],
    }),
    streamLine("ts-call-call", "web/b.ts", [0, 0], [0, 2], {
      NAME: ["g", [0, 0], [0, 1]],
    }),
    streamLine("ts-call-call", "web/a.ts", [1, 7], [1, 9], {
      NAME: ["h", [1, 7], [1, 8]],
    }),
  ];
  const order = parseAstGrepStream(
    `\n${lines.join("\n")}\n\n`,
    SNAP,
    rawLine,
  ).map((m) => `${m.file}:${m.start.line}:${m.start.col}:${m.ruleId}`);
  expect(order).toEqual([
    "web/a.ts:2:8:ts-call-call",
    "web/a.ts:4:1:ts-call-call",
    "web/b.ts:1:1:ts-call-call",
    "web/b.ts:1:5:ts-call-call",
    "web/b.ts:1:5:ts-call-new",
  ]);
});

it("refuses a line that is not a match, a file outside the snapshot and an unknown rule id", () => {
  const { rawLine } = linesOf({});
  expect(() => parseAstGrepStream("{not json", SNAP, rawLine)).toThrow(
    "ast-grep wrote a line that is not a match: {not json",
  );
  expect(() =>
    parseAstGrepStream('{"ruleId":"ts-call-call"}', SNAP, rawLine),
  ).toThrow("ast-grep wrote a line that is not a match");
  const outside = streamLine("ts-call-call", "x.ts", [0, 0], [0, 1]).replace(
    `${SNAP}/x.ts`,
    "/export/snapshot-old/x.ts",
  );
  expect(() => parseAstGrepStream(outside, SNAP, rawLine)).toThrow(
    "ast-grep reported a file outside the snapshot: /export/snapshot-old/x.ts",
  );
  for (const path of ["../x.ts", "web/../../x.ts", "web//x.ts", "./x.ts", ""]) {
    const line = streamLine("ts-call-call", path, [0, 0], [0, 1]);
    expect(() => parseAstGrepStream(line, SNAP, rawLine)).toThrow(
      `ast-grep reported a file outside the snapshot: ${SNAP}/${path}`,
    );
  }
  for (const id of [
    "ts-def",
    "rb-def-function",
    "ts-ref-function",
    "ts-def-",
  ]) {
    expect(() =>
      parseAstGrepStream(streamLine(id, "x.ts", [0, 0], [0, 1]), SNAP, rawLine),
    ).toThrow(`unknown ast-grep rule id: ${id}`);
  }
});

it("anchors an exclusion glob at the snapshot and escapes every glob character", () => {
  expect(excludeGlob("/export/snapshot", "web/gen.ts")).toBe(
    "!**/export/snapshot/web/gen.ts",
  );
  expect(excludeGlob("/tmp/a[1]/snap", "web/{a,b}*?\\.ts")).toBe(
    "!**/tmp/a\\[1\\]/snap/web/\\{a,b\\}\\*\\?\\\\.ts",
  );
});

// A match written by hand, for the fact tests.
function m(
  ruleId: string,
  file: string,
  start: Pos,
  end: Pos,
  vars: Record<string, [string, Pos]> = {},
): RawMatch {
  const out: RawMatch["vars"] = {};
  for (const [name, [text, at]] of Object.entries(vars)) {
    out[name] = { text, start: at, end: P(at.line, at.col + [...text].length) };
  }
  return { ruleId, file, start, end, vars: out, nameLine: "" };
}

it("turns call matches into call facts at the callee's name, with the receiver or null", () => {
  const facts = astGrepFacts([
    m("ts-call-call", "web/a.ts", P(1, 3), P(1, 11), {
      NAME: ["position", P(1, 3)],
      RECV: ["o", P(1, 1)],
    }),
    m("ts-call-new", "web/a.ts", P(2, 5), P(2, 10), {
      NAME: ["Orbit", P(2, 5)],
    }),
    m("tsx-call-jsx", "web/b.tsx", P(1, 2), P(1, 5), {
      NAME: ["Sky", P(1, 2)],
    }),
    m("py-call-call", "sim/sky.py", P(3, 14), P(3, 18), {
      NAME: ["draw", P(3, 14)],
      RECV: ["self", P(3, 9)],
    }),
    m("sh-call-command", "scripts/sync.sh", P(4, 1), P(4, 5), {
      NAME: ["sync", P(4, 1)],
    }),
  ]);
  // in file order, then position order, whatever order the matches came in
  expect(facts.calls).toEqual([
    { file: "scripts/sync.sh", at: P(4, 1), callee: "sync", receiver: null },
    { file: "sim/sky.py", at: P(3, 14), callee: "draw", receiver: "self" },
    { file: "web/a.ts", at: P(1, 3), callee: "position", receiver: "o" },
    { file: "web/a.ts", at: P(2, 5), callee: "Orbit", receiver: null },
    { file: "web/b.tsx", at: P(1, 2), callee: "Sky", receiver: null },
  ]);
  expect(facts.defs).toEqual([]);
  expect(facts.imports).toEqual([]);
  expect(facts.computed).toEqual([]);
});

it("turns import matches into facts at the specifier, unquoted, with their kind and names", () => {
  const f = "web/orbit.ts";
  const facts = astGrepFacts([
    // import D, * as E, {
    //   a, b as c, "a\x2db" as ab } from "./sky";   (lines 1-3)
    m("ts-import-static", f, P(1, 1), P(3, 23), {
      SPEC: ['"./sky"', P(3, 15)],
    }),
    m("ts-import-default", f, P(1, 8), P(1, 9)),
    m("ts-import-namespace", f, P(1, 11), P(1, 17)),
    m("ts-import-name", f, P(2, 3), P(2, 4), { NAMES: ["a", P(2, 3)] }),
    m("ts-import-name", f, P(2, 6), P(2, 12), { NAMES: ["b", P(2, 6)] }),
    // a string name, "a\x2db" as ab: its value
    m("ts-import-name", f, P(2, 14), P(2, 29), {
      NAMES: ['"a\\x2db"', P(2, 14)],
    }),
    // import type { Body } from './body';
    m("ts-import-type-only", f, P(4, 1), P(4, 36), {
      SPEC: ["'./body'", P(4, 27)],
    }),
    m("ts-import-name", f, P(4, 15), P(4, 19), { NAMES: ["Body", P(4, 15)] }),
    // import "./polyfill";
    m("ts-import-side-effect", f, P(5, 1), P(5, 21), {
      SPEC: ['"./polyfill"', P(5, 8)],
    }),
    // export * from "./stars";  export { x as y } from "./x";  (the rules match export * from
    // as a namespace binding spanning the statement)
    m("ts-import-re-export", f, P(6, 1), P(6, 25), {
      SPEC: ['"./stars"', P(6, 15)],
    }),
    m("ts-import-namespace", f, P(6, 1), P(6, 25)),
    m("ts-import-re-export", f, P(7, 1), P(7, 31), {
      SPEC: ['"./x"', P(7, 25)],
    }),
    m("ts-import-name", f, P(7, 10), P(7, 16), { NAMES: ["x", P(7, 10)] }),
    // const m = await import(`./sky`); const r = require("./a\x2fb");
    m("ts-import-dynamic", f, P(8, 17), P(8, 32), {
      SPEC: ["`./sky`", P(8, 24)],
    }),
    m("ts-import-require", f, P(9, 11), P(9, 30), {
      SPEC: ['"./a\\x2fb"', P(9, 19)],
    }),
    // import(`./${name}`)
    m("ts-import-computed", f, P(10, 1), P(10, 20)),
    // a binding outside every statement, as tree-sitter may leave in code that does not
    // parse: it joins none, though the require above starts before it
    m("ts-import-name", f, P(11, 3), P(11, 4), { NAMES: ["z", P(11, 3)] }),
    // sim/sky.py: from ..pkg import (a,\n b as c); import os . path, sys as system
    m("py-import-static", "sim/sky.py", P(1, 1), P(2, 10), {
      SPEC: ["..pkg", P(1, 6)],
    }),
    m("py-import-name", "sim/sky.py", P(1, 20), P(1, 21), {
      NAMES: ["a", P(1, 20)],
    }),
    m("py-import-name", "sim/sky.py", P(2, 2), P(2, 3), {
      NAMES: ["b", P(2, 2)],
    }),
    m("py-import-static", "sim/sky.py", P(3, 8), P(3, 15), {
      SPEC: ["os . path", P(3, 8)],
    }),
    m("py-import-static", "sim/sky.py", P(3, 17), P(3, 20), {
      SPEC: ["sys", P(3, 17)],
    }),
    m("py-import-static", "sim/sky.py", P(4, 1), P(4, 16), {
      SPEC: [".", P(4, 6)],
    }),
    m("py-import-name", "sim/sky.py", P(4, 15), P(4, 16), {
      NAMES: ["*", P(4, 15)],
    }),
    // __import__('obs\x2eervatory'), then a raw string, whose backslash stays
    m("py-import-dynamic", "sim/sky.py", P(5, 1), P(5, 27), {
      SPEC: ["'obs\\x2eervatory'", P(5, 12)],
    }),
    m("py-import-computed", "sim/sky.py", P(6, 1), P(6, 22)),
    m("py-import-dynamic", "sim/sky.py", P(7, 1), P(7, 28), {
      SPEC: ["r'obs\\x2eervatory'", P(7, 12)],
    }),
    // scripts/sync.sh: source ./lib.sh; bash "./run me.sh"; ./x\ y.sh; . './b.sh'
    m("sh-import-source", "scripts/sync.sh", P(1, 1), P(1, 16), {
      SPEC: ["./lib.sh", P(1, 8)],
    }),
    m("sh-import-exec", "scripts/sync.sh", P(2, 1), P(2, 19), {
      SPEC: ['"./run me.sh"', P(2, 6)],
    }),
    m("sh-import-exec", "scripts/sync.sh", P(3, 1), P(3, 9), {
      SPEC: ["./x\\ y.sh", P(3, 1)],
    }),
    m("sh-import-source", "scripts/sync.sh", P(4, 1), P(4, 14), {
      SPEC: ["'./b.sh'", P(4, 3)],
    }),
    // arguments that expand when the script runs name no file: no fact
    m("sh-import-source", "scripts/sync.sh", P(5, 1), P(5, 21), {
      SPEC: ['"$DIR/lib.sh"', P(5, 8)],
    }),
    m("sh-import-exec", "scripts/sync.sh", P(6, 1), P(6, 16), {
      SPEC: ["./lib/*.sh", P(6, 6)],
    }),
    m("sh-import-source", "scripts/sync.sh", P(7, 1), P(7, 14), {
      SPEC: ["~/x.sh", P(7, 8)],
    }),
  ]);
  const imp = (
    file: string,
    at: Pos,
    [startLine, endLine]: [number, number],
    specifier: string,
    kind: string,
    names: string[] = [],
  ) => ({ file, at, startLine, endLine, specifier, kind, names });
  // in file order, then statement order; a binding joins the statement whose match holds it.
  // A statement's lines run from its match's first line to its last: the TS import on lines
  // 1-3 names its specifier on line 3
  expect(facts.imports).toEqual([
    imp("scripts/sync.sh", P(1, 8), [1, 1], "./lib.sh", "source"),
    imp("scripts/sync.sh", P(2, 6), [2, 2], "./run me.sh", "exec"),
    imp("scripts/sync.sh", P(3, 1), [3, 3], "./x y.sh", "exec"),
    imp("scripts/sync.sh", P(4, 3), [4, 4], "./b.sh", "source"),
    imp("sim/sky.py", P(1, 6), [1, 2], "..pkg", "static", ["a", "b"]),
    imp("sim/sky.py", P(3, 8), [3, 3], "os.path", "static"),
    imp("sim/sky.py", P(3, 17), [3, 3], "sys", "static"),
    imp("sim/sky.py", P(4, 6), [4, 4], ".", "static", ["*"]),
    imp("sim/sky.py", P(5, 12), [5, 5], "obs.ervatory", "dynamic"),
    imp("sim/sky.py", P(7, 12), [7, 7], "obs\\x2eervatory", "dynamic"),
    imp(f, P(3, 15), [1, 3], "./sky", "static", [
      "default",
      "*",
      "a",
      "b",
      "a-b",
    ]),
    imp(f, P(4, 27), [4, 4], "./body", "type-only", ["Body"]),
    imp(f, P(5, 8), [5, 5], "./polyfill", "side-effect"),
    imp(f, P(6, 15), [6, 6], "./stars", "re-export", ["*"]),
    imp(f, P(7, 25), [7, 7], "./x", "re-export", ["x"]),
    imp(f, P(8, 24), [8, 8], "./sky", "dynamic"),
    imp(f, P(9, 19), [9, 9], "./a/b", "require"),
  ]);
  expect(facts.computed).toEqual([
    { file: "sim/sky.py", line: 6 },
    { file: f, line: 10 },
  ]);
  expect(facts.calls).toEqual([]);
});

it("ends an import's lines at the last line its match covers", () => {
  // a match whose exclusive end is column 1 of the next line covers only the lines before it
  const facts = astGrepFacts([
    m("sh-import-source", "scripts/a.sh", P(1, 1), P(3, 1), {
      SPEC: ["./lib.sh", P(1, 8)],
    }),
  ]);
  expect(facts.imports[0]?.endLine).toBe(2);
});

it("keeps a code-point escape with no closing brace as written, and ends", () => {
  // tree-sitter still gives a string node for "\u{41", which JavaScript would refuse:
  // require("\u{41") and import { "x\u{42" as y } from "./sky"
  const f = "web/orbit.ts";
  const facts = astGrepFacts([
    m("ts-import-require", f, P(1, 1), P(1, 17), {
      SPEC: ['"\\u{41"', P(1, 9)],
    }),
    m("ts-import-static", f, P(2, 1), P(2, 35), {
      SPEC: ['"./sky"', P(2, 28)],
    }),
    m("ts-import-name", f, P(2, 10), P(2, 20), {
      NAMES: ['"x\\u{42"', P(2, 10)],
    }),
  ]);
  expect(facts.imports).toEqual([
    {
      file: f,
      at: P(1, 9),
      startLine: 1,
      endLine: 1,
      specifier: "\\u{41",
      kind: "require",
      names: [],
    },
    {
      file: f,
      at: P(2, 28),
      startLine: 2,
      endLine: 2,
      specifier: "./sky",
      kind: "static",
      names: ["x\\u{42"],
    },
  ]);
});

it("applies only when the tree holds a regular file the rules scan, outside the metadata-only files", () => {
  const ctx = (
    tree: Array<[string, string]>,
    metadataOnly: string[] = [],
  ): ExtractContext =>
    ({
      manifest: {
        tree: tree.map(([path, mode]) => ({
          path,
          mode,
          blob: "0".repeat(40),
          bytes: 1,
        })),
        metadataOnly: metadataOnly.map((path) => ({
          path,
          reason: "generated",
        })),
      },
    }) as unknown as ExtractContext;
  // an empty repo, docs only, and a shell file outside hakutaku's extensions
  expect(astGrepDriver.applies(ctx([]))).toBe(false);
  expect(
    astGrepDriver.applies(
      ctx([
        ["README.md", "100644"],
        ["x.zsh", "100644"],
      ]),
    ),
  ).toBe(false);
  // a link and a submodule are no input
  expect(
    astGrepDriver.applies(
      ctx([
        ["web/a.ts", "120000"],
        ["sim/b.py", "160000"],
      ]),
    ),
  ).toBe(false);
  // a metadata-only file is no input
  expect(
    astGrepDriver.applies(ctx([["web/gen.ts", "100644"]], ["web/gen.ts"])),
  ).toBe(false);
  expect(astGrepDriver.applies(ctx([["scripts/run.sh", "100755"]]))).toBe(true);
  expect(astGrepDriver.applies(ctx([["sim/sky.pyi", "100644"]]))).toBe(true);
});
