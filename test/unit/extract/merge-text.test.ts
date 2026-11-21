// The stored-text rule: how a file's bytes become the text the store keeps and counts.
// Characters outside ASCII are built from their code points, and secret-looking values are
// assembled at run time.
import { expect, it } from "vitest";
import {
  countLines,
  countLinesOf,
  decodeText,
  redactLine,
} from "../../../src/extract/merge/text.js";

const BOM = String.fromCodePoint(0xfeff);
const BAD = String.fromCodePoint(0xfffd);
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const high = (n: number) =>
  Array.from({ length: n }, (_, i) => ALPHA[(i * 37 + 11) % ALPHA.length]).join(
    "",
  );
const join = (...parts: string[]) => parts.join("");

it("stores CRLF, BOM and invalid UTF-8 text by the fixed rule", () => {
  expect(
    decodeText(
      Uint8Array.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0xff, 0x0a]),
    ),
  ).toBe(`${BOM}a\n${BAD}\n`);
  expect(countLines("a\nb")).toBe(2);
  expect(countLines("a\nb\n")).toBe(2);
  expect(countLines("")).toBe(0);
});

it("keeps a lone CR, and reads each maximal invalid sequence as one U+FFFD", () => {
  // a, CR, b, CR, CR, LF; a three-byte sequence cut short by a LF; a whole four-byte one
  expect(
    decodeText(
      Uint8Array.from([
        0x61, 0x0d, 0x62, 0x0d, 0x0d, 0x0a, 0xe2, 0x82, 0x0a, 0xf0, 0x9f, 0x98,
        0x80,
      ]),
    ),
  ).toBe(`a\rb\r\n${BAD}\n${String.fromCodePoint(0x1f600)}`);
  expect(countLines("\n")).toBe(1);
  expect(countLines("a\r\rb")).toBe(1);
});

it("counts a file's lines from its bytes as countLines counts its decoded text", () => {
  const samples = [
    [],
    [0x0a],
    [0x61],
    [0x61, 0x0a],
    [0x61, 0x0d, 0x0a, 0x62],
    [0xef, 0xbb, 0xbf],
    [0xff, 0x0a, 0xff],
    [0x0a, 0x0a],
    [0x0d],
  ].map((b) => Uint8Array.from(b));
  expect(samples.map(countLinesOf)).toEqual([0, 1, 1, 1, 2, 1, 2, 2, 1]);
  expect(samples.map(countLinesOf)).toEqual(
    samples.map((b) => countLines(decodeText(b))),
  );
});

it("redacts a stored line before cutting it to 240 characters", () => {
  const github = join("gh", "p_", high(36));
  // cut first, the 240th character would fall inside the token and keep 19 of its 40
  const line = `connect(${"x".repeat(210)}, "${github}")`;
  expect(redactLine(line)).toEqual({
    text: `connect(${"x".repeat(210)}, "«redacted:github-to`,
    count: 1,
  });
  // characters are code points: 300 astral characters keep 240, not 120
  const stars = String.fromCodePoint(0x1f31f);
  expect(redactLine(stars.repeat(300))).toEqual({
    text: stars.repeat(240),
    count: 0,
  });
  expect(redactLine("short")).toEqual({ text: "short", count: 0 });
});
