import { expect, it } from "vitest";
import { parseJsonc } from "../../../src/profile/index.js";

it("reads JSONC with comments and trailing commas", () =>
  expect(
    parseJsonc(
      '{ // paths\n "compilerOptions": { "paths": { "@obs/web/*": ["web/src/*",], }, /* end */ } }',
    ),
  ).toEqual({ compilerOptions: { paths: { "@obs/web/*": ["web/src/*"] } } }));

it("reads JSON as JSON.parse does, keys such as __proto__ included", () => {
  const json = String.raw`{"s": "q\" b\\ s\/ \b\f\n\r\t \u00e9 \ud83d\udd2d \ud800", "n": [0, -0, 12, -3.5, 1e3, 2.5E-3, 1E+2, 1e400],
    "l": [true, false, null, [], {}], "dup": 1, "o": {"dup": 2}, "dup": 3, "__proto__": {"x": 1}, "constructor": 4}`;
  const value = parseJsonc(json);
  expect(value).toStrictEqual(JSON.parse(json));
  // the last of a repeated key wins, in the place of the first, as in JSON.parse
  expect(Object.keys(value as object)).toEqual(Object.keys(JSON.parse(json)));
  expect(Object.hasOwn(value as object, "__proto__")).toBe(true);
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
});

it("keeps comment markers and commas inside strings", () =>
  expect(
    parseJsonc(
      '{ "url": "https://example.org/*sky*/", "glob": "//stars", "list": "a,]" }',
    ),
  ).toEqual({
    url: "https://example.org/*sky*/",
    glob: "//stars",
    list: "a,]",
  }));

it("reads a byte order mark and CRLF line ends", () =>
  expect(
    parseJsonc('\uFEFF{\r\n  "a": 1, // sky\r\n  "b": [2,],\r\n}'),
  ).toEqual({
    a: 1,
    b: [2],
  }));

it("reads 512 levels of nesting", () => {
  let value = parseJsonc(`${"[".repeat(512)}${"]".repeat(512)}`);
  for (let level = 1; level < 512; level++) {
    expect(value).toHaveLength(1);
    value = (value as unknown[])[0];
  }
  expect(value).toEqual([]);
});

// line:col points at the character that cannot be read, or at the opening quote of an
// unterminated string or comment; both count from 1, the column in UTF-16 code units, and a byte
// order mark is not counted.
it.each([
  ["", "1:1: expected a value"],
  ["// a comment only\n", "2:1: expected a value"],
  ["{", '1:2: expected a string key or "}"'],
  ['{"a" 1}', '1:6: expected ":"'],
  ['{\n  "a": 1\n  "b": 2\n}', '3:3: expected "," or "}"'],
  ['{\r\n"a" 1}', '2:5: expected ":"'],
  ["[1,,2]", '1:4: expected a value or "]"'],
  ["[,]", '1:2: expected a value or "]"'],
  ["{,}", '1:2: expected a string key or "}"'],
  ["\uFEFF{,}", '1:2: expected a string key or "}"'],
  ["[1 2]", '1:4: expected "," or "]"'],
  ["[1] 2", "1:5: expected the end of the text"],
  ['"\u{1F52D}" x', "1:6: expected the end of the text"],
  ["01", "1:2: expected the end of the text"],
  ["-", "1:1: expected a value"],
  ["tru", "1:1: expected a value"],
  ["'a'", "1:1: expected a value"],
  ["\u00a0{}", "1:1: expected a value"],
  ["{} /* open", "1:4: unterminated comment"],
  ['["ab', "1:2: unterminated string"],
  ['"a\nb"', "1:3: control character in a string"],
  ['"a\tb"', "1:3: control character in a string"],
  [String.raw`"a\x"`, "1:3: invalid escape"],
  [String.raw`"\u12G4"`, "1:2: invalid escape"],
])("throws a SyntaxError at line:col for %j", (text, message) => {
  expect(() => parseJsonc(text)).toThrow(SyntaxError);
  expect(() => parseJsonc(text)).toThrow(new SyntaxError(message));
});

it("refuses nesting deeper than 512 levels as a SyntaxError, never a stack overflow", () => {
  for (const [text, message] of [
    ["[".repeat(513), "1:513: nested too deeply"],
    ["[".repeat(1 << 20), "1:513: nested too deeply"],
    // the 513th "{" of '{"a":{"a":...' is at column 5 x 512 + 1
    ['{"a":'.repeat(600), "1:2561: nested too deeply"],
  ]) {
    expect(() => parseJsonc(text)).toThrow(new SyntaxError(message));
  }
});
