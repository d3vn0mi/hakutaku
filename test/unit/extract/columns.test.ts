import { expect, it } from "vitest";
import { byteColToCol, utf16ColToCol } from "../../../src/extract/columns.js";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const BOM = [0xef, 0xbb, 0xbf];

it("turns byte columns into code-point columns", () =>
  expect(byteColToCol(bytes("漢 sky()"), 4)).toBe(3)); // 漢 is 3 bytes: byte 4 is s, the 3rd code point

it("turns UTF-16 columns into code-point columns", () =>
  expect(utf16ColToCol("😀😀 orbit()", 5)).toBe(4)); // each emoji is 2 code units

it("decodes invalid UTF-8 as one replacement character", () =>
  expect(byteColToCol(Uint8Array.from([0xff, 0x61]), 1)).toBe(2));

it("gives column 1 at the start of a line, and one past the last code point at its end", () => {
  expect(byteColToCol(bytes("sky"), 0)).toBe(1);
  expect(utf16ColToCol("sky", 0)).toBe(1);
  expect(byteColToCol(bytes("漢字"), 6)).toBe(3);
  expect(utf16ColToCol("😀😀", 4)).toBe(3);
});

it("counts a 4-byte character as one code point", () =>
  expect(byteColToCol(bytes("😀 orbit()"), 5)).toBe(3)); // 😀 is bytes 0-3, the space byte 4, o byte 5

it("counts a byte order mark as a code point, as the stored text keeps it", () => {
  expect(byteColToCol(Uint8Array.from([...BOM, 0x61, 0x62]), 4)).toBe(3); // BOM, a, then b
  expect(utf16ColToCol(`${String.fromCodePoint(0xfeff)}ab`, 2)).toBe(3);
});

it("reads each maximal invalid sequence as one replacement character", () => {
  // two lone bytes are two characters; a lead byte cut short by an ASCII byte is one
  expect(byteColToCol(Uint8Array.from([0xff, 0xfe, 0x61]), 2)).toBe(3);
  expect(byteColToCol(Uint8Array.from([0xe6, 0x41, 0x42]), 2)).toBe(3);
  // three bytes of a four-byte sequence, then A: one replacement character before A
  expect(byteColToCol(Uint8Array.from([0xf0, 0x9f, 0x98, 0x41]), 3)).toBe(2);
});

it("counts a lone surrogate as one code point", () =>
  expect(utf16ColToCol(`${String.fromCharCode(0xd83d)}x`, 1)).toBe(2));
