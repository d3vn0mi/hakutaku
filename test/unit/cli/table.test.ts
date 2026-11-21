import { expect, it } from "vitest";
import { printable } from "../../../src/cli/table.js";

// Each character by its code, so that this file holds none of them raw.
const ch = (...codes: number[]): string => String.fromCharCode(...codes);
const ESC = ch(0x1b);
const CSI = ch(0x9b); // a C1 control

it("makes each CR, LF or CRLF and the spaces around it one '; ', and every other control character '?'", () => {
  expect(printable("north \r\n  south\rwest\n\neast")).toBe(
    "north; south; west; east",
  );
  expect(printable(`sky${ESC}[2J${CSI}31m${ch(0x7f, 0, 9)}map`)).toBe(
    "sky?[2J?31m???map",
  );
});

it("keeps every other character as it is, joiners, marks and spaces that are not line breaks included", () => {
  const kept = [
    "the observatory's 2 telescopes, (north) & [south]: ok?",
    `caf${ch(0xe9)} ${ch(0x89b3, 0x6e2c, 0x6240)}`, // a Latin letter, and three CJK ones
    ch(0xd83d, 0xdc69, 0x200d, 0xd83d, 0xdd2d), // two emoji joined by a zero-width joiner
    `a${ch(0x200c)}b${ch(0xa0)}c${ch(0xad)}d${ch(0x2060)}e${ch(0x200b)}f`, // ZWNJ, NBSP, soft hyphen, WJ, ZWSP
    `a${ch(0x206a)}b${ch(0x206f)}c${ch(0xfeff)}d`, // deprecated format controls and a BOM
  ];
  for (const text of kept) expect(printable(text)).toBe(text);
});

// Unicode takes NEL, the line separator and the paragraph separator for line breaks too: each is
// one, as CR and LF are, so that the text stays on one line wherever it is shown.
it.each<[string, number]>([
  ["NEL", 0x85],
  ["the line separator", 0x2028],
  ["the paragraph separator", 0x2029],
])("takes %s for a line break, with the spaces around it", (_, code) => {
  const lb = ch(code);
  expect(printable(`north ${lb} south`)).toBe("north; south");
  expect(printable(`north${lb}${lb}south${lb}\nwest`)).toBe(
    "north; south; west",
  );
});

// A bidirectional control makes a terminal that applies it show the text around it in another
// order than its own, as in a "Trojan Source" attack: each becomes "?".
it.each<[string, number[]]>([
  ["the Arabic letter mark", [0x061c]],
  ["the left-to-right and right-to-left marks", [0x200e, 0x200f]],
  [
    "the embeddings, the pop and the overrides",
    [0x202a, 0x202b, 0x202c, 0x202d, 0x202e],
  ],
  ["the isolates and their pop", [0x2066, 0x2067, 0x2068, 0x2069]],
])("turns %s into '?'", (_, codes) => {
  for (const code of codes) {
    expect(printable(`sky${ch(code)}map`), code.toString(16)).toBe("sky?map");
  }
});
