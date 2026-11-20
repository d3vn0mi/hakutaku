// Engine columns to the store's. Engines count a line's columns from 0, in UTF-8 bytes or in
// UTF-16 code units; the store counts Unicode code points from 1. Bytes are decoded as the store
// decodes text: each maximal invalid sequence reads as one U+FFFD, and a byte order mark is kept
// as a character.

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

// The 1-based code-point column of the 0-based byte column byteCol0 of rawLine.
export function byteColToCol(rawLine: Uint8Array, byteCol0: number): number {
  return codePoints(decoder.decode(rawLine.subarray(0, byteCol0))) + 1;
}

// The 1-based code-point column of the 0-based UTF-16 column utf16Col0 of line. A lone
// surrogate counts as one code point, as string iteration reads it.
export function utf16ColToCol(line: string, utf16Col0: number): number {
  return codePoints(line.slice(0, utf16Col0)) + 1;
}

function codePoints(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}
