// Splitting highlighted HTML into one fragment per line, so that each line renders on its own: a
// span open at a line feed is closed at the end of its line and opened again on the next, and
// the lines counted are the ones the store counts.
import { expect, it } from "vitest";
import { countLines } from "../../../../src/extract/merge/text.js";
import {
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
