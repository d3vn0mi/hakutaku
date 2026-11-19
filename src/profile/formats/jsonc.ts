// JSONC: JSON plus "//" and "/* */" comments and trailing commas, as tsconfig files are
// written. It is read as data; nothing in it runs.
//
// Anything else throws a SyntaxError whose message starts "<line>:<column>: ". Both count from
// 1: lines by LF, columns in UTF-16 code units, and a leading byte order mark is not counted.
// The position is the character that cannot be read, or the start of an unterminated string or
// comment.
//
// Objects get their keys as own properties, as JSON.parse gives them, so a key such as
// "__proto__" is data and never a prototype; the last of a repeated key wins, in the place of
// the first. Arrays and objects nest at most MAX_DEPTH deep, so deep text is refused as a
// SyntaxError and never overflows the stack.

const MAX_DEPTH = 512;

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const HEX4 = /^[0-9A-Fa-f]{4}$/;
const LITERALS = [
  ["true", true],
  ["false", false],
  ["null", null],
] as const;

const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

// An own, enumerable data property, whatever the key, as JSON.parse makes one.
const define = (
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void => {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
};

export function parseJsonc(text: string): unknown {
  const src = text.startsWith("\uFEFF") ? text.slice(1) : text;
  let pos = 0;

  const fail = (at: number, problem: string): never => {
    let line = 1;
    let start = 0;
    for (let nl = src.indexOf("\n"); nl !== -1 && nl < at; ) {
      line++;
      start = nl + 1;
      nl = src.indexOf("\n", start);
    }
    throw new SyntaxError(`${line}:${at - start + 1}: ${problem}`);
  };

  // White space and comments.
  const skip = (): void => {
    for (;;) {
      const c = src.charCodeAt(pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
        pos++;
      } else if (c === 0x2f && src.charCodeAt(pos + 1) === 0x2f) {
        const nl = src.indexOf("\n", pos + 2);
        pos = nl === -1 ? src.length : nl + 1;
      } else if (c === 0x2f && src.charCodeAt(pos + 1) === 0x2a) {
        const end = src.indexOf("*/", pos + 2);
        if (end === -1) fail(pos, "unterminated comment");
        pos = end + 2;
      } else {
        return;
      }
    }
  };

  const string = (): string => {
    const start = pos;
    pos++;
    let out = "";
    for (;;) {
      const run = pos;
      while (pos < src.length) {
        const c = src.charCodeAt(pos);
        if (c === 0x22 || c === 0x5c || c < 0x20) break;
        pos++;
      }
      out += src.slice(run, pos);
      if (pos >= src.length) return fail(start, "unterminated string");
      const c = src[pos];
      if (c === '"') {
        pos++;
        return out;
      }
      if (c !== "\\") return fail(pos, "control character in a string");
      const e = src[pos + 1] ?? "";
      if (e === "u") {
        const hex = src.slice(pos + 2, pos + 6);
        if (!HEX4.test(hex)) return fail(pos, "invalid escape");
        out += String.fromCharCode(Number.parseInt(hex, 16));
        pos += 6;
      } else if (Object.hasOwn(ESCAPES, e)) {
        out += ESCAPES[e];
        pos += 2;
      } else {
        return fail(pos, "invalid escape");
      }
    }
  };

  // A value at pos, after white space; `expected` names what the caller would take there.
  const value = (depth: number, expected: string): unknown => {
    const c = src[pos];
    if (c === "{") return object(depth + 1);
    if (c === "[") return array(depth + 1);
    if (c === '"') return string();
    for (const [word, literal] of LITERALS) {
      if (src.startsWith(word, pos)) {
        pos += word.length;
        return literal;
      }
    }
    NUMBER.lastIndex = pos;
    const number = NUMBER.exec(src);
    if (number === null) return fail(pos, expected);
    pos += number[0].length;
    return Number(number[0]);
  };

  const object = (depth: number): Record<string, unknown> => {
    if (depth > MAX_DEPTH) fail(pos, "nested too deeply");
    pos++;
    const out: Record<string, unknown> = {};
    for (;;) {
      skip();
      // after "{", or after a comma, which may trail
      if (src[pos] === "}") {
        pos++;
        return out;
      }
      if (src[pos] !== '"') fail(pos, 'expected a string key or "}"');
      const key = string();
      skip();
      if (src[pos] !== ":") fail(pos, 'expected ":"');
      pos++;
      skip();
      define(out, key, value(depth, "expected a value"));
      skip();
      if (src[pos] === "}") {
        pos++;
        return out;
      }
      if (src[pos] !== ",") fail(pos, 'expected "," or "}"');
      pos++;
    }
  };

  const array = (depth: number): unknown[] => {
    if (depth > MAX_DEPTH) fail(pos, "nested too deeply");
    pos++;
    const out: unknown[] = [];
    for (;;) {
      skip();
      // after "[", or after a comma, which may trail
      if (src[pos] === "]") {
        pos++;
        return out;
      }
      out.push(value(depth, 'expected a value or "]"'));
      skip();
      if (src[pos] === "]") {
        pos++;
        return out;
      }
      if (src[pos] !== ",") fail(pos, 'expected "," or "]"');
      pos++;
    }
  };

  skip();
  const result = value(0, "expected a value");
  skip();
  if (pos < src.length) fail(pos, "expected the end of the text");
  return result;
}
