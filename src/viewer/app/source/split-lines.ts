// Highlighted HTML split into one fragment per line, so that each line of the Source tab renders
// on its own, and the lines of a text counted as the store counts them. No DOM here: Node tests
// import it.
// - At each line feed, every span still open is closed, and opened again at the start of the next
//   line, so each fragment is whole HTML.
// - A carriage return that ends a line, before its line feed or at the end of the text, is
//   dropped. Any other is written as the character reference &#13;: HTML reads a raw carriage
//   return as a line break, which would split the line in two on the page.
// - A text that ends in a line feed gives a last, empty fragment; the store does not count it as
//   a line, and the page does not draw it.
// Also which texts are too large to highlight on the page, and where each chunk of lines ends.
import {
  HIGHLIGHT_ON_PAGE_CHARS,
  SOURCE_CHUNK_CHARS,
  SOURCE_CHUNK_LINES,
  WORKER_HIGHLIGHT_ABOVE,
} from "../constants.js";

// A tag, a line feed, or text; a "<" that starts no tag is text too, so no character is lost.
const TOKEN = /<[^>]*>|\n|[^<\n]+|</g;
const TRAILING_CR = /\r((?:<[^>]*>)*)(?=\n|$)/g;

export function splitHighlighted(html: string): string[] {
  const text = html.replace(TRAILING_CR, "$1").replaceAll("\r", "&#13;");
  const lines: string[] = [];
  const open: string[] = [];
  let line = "";
  for (const [token] of text.matchAll(TOKEN)) {
    if (token === "\n") {
      lines.push(line + "</span>".repeat(open.length));
      line = open.join("");
    } else if (token.startsWith("</")) {
      open.pop();
      line += token;
    } else if (token.startsWith("<")) {
      open.push(token);
      line += token;
    } else {
      line += token;
    }
  }
  lines.push(line + "</span>".repeat(open.length));
  return lines;
}

// The number of line feeds, plus one when the text is not empty and does not end in one.
export function lineCount(text: string): number {
  let n = 0;
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) {
    n++;
  }
  return text.length > 0 && !text.endsWith("\n") ? n + 1 : n;
}

// Whether a text is highlighted away from the page, in the worker, or, where there is none, shown
// as plain text a chunk at a time: one of more than WORKER_HIGHLIGHT_ABOVE lines, or of more than
// HIGHLIGHT_ON_PAGE_CHARS characters, whose highlighting in one task would block the page.
export function highlightedOffPage(text: string): boolean {
  return (
    text.length > HIGHLIGHT_ON_PAGE_CHARS ||
    lineCount(text) > WORKER_HIGHLIGHT_ABOVE
  );
}

// Where the chunk of lines that starts at index from ends: at most SOURCE_CHUNK_LINES lines, and
// at most SOURCE_CHUNK_CHARS characters of them, but always one line at least, and never past
// total, the lines the store counts.
export function chunkEnd(lines: string[], from: number, total: number): number {
  const last = Math.min(from + SOURCE_CHUNK_LINES, total);
  let chars = 0;
  let to = from;
  while (to < last) {
    chars += lines[to].length;
    if (chars > SOURCE_CHUNK_CHARS && to > from) break;
    to++;
  }
  return to;
}
