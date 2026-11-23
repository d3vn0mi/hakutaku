// Splitting highlighted HTML into one fragment per line, so that each line renders on its own: a
// span open at a line feed is closed at the end of its line and opened again on the next, and
// the lines counted are the ones the store counts.
import { expect, it } from "vitest";
import { countLines } from "../../../../src/extract/merge/text.js";
import {
  HIGHLIGHT_ON_PAGE_CHARS,
  SOURCE_CHUNK_CHARS,
  SOURCE_CHUNK_LINES,
  WORKER_HIGHLIGHT_ABOVE,
} from "../../../../src/viewer/app/constants.js";
import {
  chunkEnd,
  highlightedOffPage,
  lineCount,
  splitHighlighted,
} from "../../../../src/viewer/app/source/split-lines.js";

it("keeps plain lines as they are", () => {
  expect(splitHighlighted("a\nb")).toEqual(["a", "b"]);
});

it("closes and reopens spans across a newline", () => {
  expect(
    splitHighlighted('<span class="hljs-comment">/* a\nb */</span>\nx'),
  ).toEqual([
    '<span class="hljs-comment">/* a</span>',
    '<span class="hljs-comment">b */</span>',
    "x",
  ]);
});

it("handles nested spans", () => {
  expect(
    splitHighlighted('<span class="a">x<span class="b">y\nz</span></span>'),
  ).toEqual([
    '<span class="a">x<span class="b">y</span></span>',
    '<span class="a"><span class="b">z</span></span>',
  ]);
});

it("gives a trailing newline its own empty line, and drops carriage returns", () => {
  expect([splitHighlighted("a\n"), splitHighlighted("a\r\nb\r\n")]).toEqual([
    ["a", ""],
    ["a", "b", ""],
  ]);
});

it("drops a carriage return that ends a line inside a span, or that ends the text", () => {
  expect(
    splitHighlighted('<span class="hljs-comment">/* a\r\nb */</span>\r\nc\r'),
  ).toEqual([
    '<span class="hljs-comment">/* a</span>',
    '<span class="hljs-comment">b */</span>',
    "c",
  ]);
  // tags between the carriage return and the line feed
  expect(splitHighlighted('<span class="s">"a"\r</span>\nb')).toEqual([
    '<span class="s">"a"</span>',
    "b",
  ]);
});

it("keeps a carriage return inside a line as a character reference, which HTML never reads as a line break", () => {
  expect(splitHighlighted("a\rb\nc")).toEqual(["a&#13;b", "c"]);
  expect(splitHighlighted('<span class="x">\r\r\n</span>')).toEqual([
    '<span class="x">&#13;</span>',
    '<span class="x"></span>',
  ]);
});

it("gives an empty text one empty line, and keeps empty lines", () => {
  expect(splitHighlighted("")).toEqual([""]);
  expect(splitHighlighted("\n\n")).toEqual(["", "", ""]);
  expect(splitHighlighted('<span class="c">a\n\nb</span>')).toEqual([
    '<span class="c">a</span>',
    '<span class="c"></span>',
    '<span class="c">b</span>',
  ]);
});

it("closes on the same line a span that opens and closes there", () => {
  expect(
    splitHighlighted(
      '<span class="k">const</span> a = <span class="n">1</span>;\nb',
    ),
  ).toEqual([
    '<span class="k">const</span> a = <span class="n">1</span>;',
    "b",
  ]);
});

it("counts a text's lines as the store does", () => {
  for (const text of [
    "",
    "a",
    "a\n",
    "a\nb",
    "a\nb\n",
    "\n",
    "\n\n",
    "a\r\nb",
    "a\rb",
    "a\n\n\nb\n",
  ]) {
    expect(lineCount(text), JSON.stringify(text)).toBe(countLines(text));
  }
});

// A text of n lines, each "x;" padded with spaces, chars characters long with its final line feed.
function textOf(n: number, chars: number): string {
  const width = Math.floor(chars / n) - 1;
  const lines = Array.from({ length: n }, () => "x;".padEnd(width));
  lines[n - 1] = lines[n - 1].padEnd(chars - n * (width + 1) + width);
  return `${lines.join("\n")}\n`;
}

it("highlights a file on the page only while it is small in lines and in characters", () => {
  expect(HIGHLIGHT_ON_PAGE_CHARS).toBe(16_384);
  const small = textOf(WORKER_HIGHLIGHT_ABOVE, HIGHLIGHT_ON_PAGE_CHARS);
  expect([lineCount(small), small.length]).toEqual([2500, 16_384]);
  expect(highlightedOffPage(small)).toBe(false);
  // one line more, or one character more, goes off the page
  const longer = textOf(WORKER_HIGHLIGHT_ABOVE + 1, HIGHLIGHT_ON_PAGE_CHARS);
  expect([lineCount(longer), longer.length]).toEqual([2501, 16_384]);
  expect(highlightedOffPage(longer)).toBe(true);
  const larger = textOf(100, HIGHLIGHT_ON_PAGE_CHARS + 1);
  expect([lineCount(larger), larger.length]).toEqual([100, 16_385]);
  expect(highlightedOffPage(larger)).toBe(true);
  expect(highlightedOffPage("")).toBe(false);
});

it("cuts lines into chunks of at most 100 lines and 65,536 characters, a whole line at least", () => {
  expect([SOURCE_CHUNK_LINES, SOURCE_CHUNK_CHARS]).toEqual([100, 65_536]);
  const short = Array.from({ length: 1200 }, () => "a".repeat(20));
  expect(chunkEnd(short, 0, 1200)).toBe(100);
  expect(chunkEnd(short, 100, 1200)).toBe(200);
  expect(chunkEnd(short, 1150, 1200)).toBe(1200);
  // the total stops it before a line it could not hold
  const wide = Array.from({ length: 300 }, () => "b".repeat(1000));
  expect(chunkEnd(wide, 0, 300)).toBe(65);
  expect(chunkEnd(wide, 65, 300)).toBe(130);
  // exactly at the limit, the line is kept
  const exact = Array.from({ length: 4 }, () => "c".repeat(16_384));
  expect(chunkEnd(exact, 0, 4)).toBe(4);
  // a line longer than the limit is a chunk of its own
  const huge = ["d", "e".repeat(70_000), "f"];
  expect(chunkEnd(huge, 0, 3)).toBe(1);
  expect(chunkEnd(huge, 1, 3)).toBe(2);
  expect(chunkEnd(huge, 2, 3)).toBe(3);
  // never past the lines the store counts
  expect(chunkEnd(["a", "b", ""], 0, 2)).toBe(2);
});
