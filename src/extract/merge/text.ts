// The stored-text rule: how a file's bytes become the text the store keeps and counts, and how
// a one-line text is stored.
// - Text is decoded as UTF-8, each maximal invalid sequence read as one U+FFFD, and a byte
//   order mark is kept as a character.
// - CRLF becomes LF; a lone CR stays.
// - Lines end at LF.
import { redactText } from "../../redact/index.js";

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

export function decodeText(bytes: Uint8Array): string {
  return decoder.decode(bytes).replaceAll("\r\n", "\n");
}

// The number of LFs, plus 1 when the text is not empty and does not end in a LF.
export function countLines(text: string): number {
  let n = 0;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) n++;
  return text.length > 0 && !text.endsWith("\n") ? n + 1 : n;
}

// countLines(decodeText(bytes)), counted on the bytes: decoding never makes or removes a LF,
// and a CRLF keeps its LF, so a file of any size is counted without becoming a string.
export function countLinesOf(bytes: Uint8Array): number {
  let n = 0;
  for (let i = bytes.indexOf(0x0a); i >= 0; i = bytes.indexOf(0x0a, i + 1)) {
    n++;
  }
  return bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a ? n + 1 : n;
}

// The most characters, as Unicode code points, that a stored one-line text keeps.
export const LINE_CHARS = 240;

// A one-line text as the store keeps it: redacted first, then cut to 240 characters, so a cut
// never leaves part of a secret whose whole a rule would have matched. count is redactText's.
export function redactLine(text: string): { text: string; count: number } {
  const redacted = redactText(text);
  return { text: cutLine(redacted.text), count: redacted.count };
}

// The text's first 240 code points.
function cutLine(text: string): string {
  if (text.length <= LINE_CHARS) return text;
  let end = 0;
  for (let chars = 0; chars < LINE_CHARS && end < text.length; chars++) {
    end += (text.codePointAt(end) as number) > 0xffff ? 2 : 1;
  }
  return text.slice(0, end);
}
