// Which files keep their metadata only: no text in the store (they answer no_source), and no
// place in any engine's input. A minified or very large file costs the engines memory and
// output out of all proportion to what it adds, enough to take a build past its memory cap.
export const SOURCE_CAP = 1_048_576;

export type MetadataOnlyReason = "size" | "minified" | "generated";

const MINIFIED_ENDINGS: readonly string[] = [
  ".min.js",
  ".min.mjs",
  ".min.cjs",
  ".min.css",
  ".map",
];
// A line over LONG_LINE characters marks a file as minified, but only in a file over
// LINES_FLOOR bytes.
const LONG_LINE = 5000;
const LINES_FLOOR = 10_000;
const GENERATED_MARKS: readonly string[] = [
  "@generated",
  "DO NOT EDIT",
  "Code generated",
];
const HEAD_LINES = 5;

// Code points as UTF-8 text decodes, each byte that is not UTF-8 reading U+FFFD, and a byte
// order mark kept.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

// The first reason that applies: the size, then a minified name or line, then a generated
// mark in the first 5 lines. Names and marks compare in their exact case.
export function metadataOnlyReason(
  path: string,
  bytes: Uint8Array,
): MetadataOnlyReason | null {
  if (bytes.length > SOURCE_CAP) return "size";
  if (MINIFIED_ENDINGS.some((ending) => path.endsWith(ending))) {
    return "minified";
  }
  if (bytes.length > LINES_FLOOR && hasLongLine(bytes)) return "minified";
  if (hasGeneratedMark(bytes)) return "generated";
  return null;
}

// Lines end at a line feed. A line has no more characters than bytes, so only a line of more
// than LONG_LINE bytes is decoded and counted.
function hasLongLine(bytes: Uint8Array): boolean {
  for (let start = 0; start <= bytes.length; ) {
    let end = bytes.indexOf(0x0a, start);
    if (end === -1) end = bytes.length;
    if (end - start > LONG_LINE && characters(bytes, start, end) > LONG_LINE) {
      return true;
    }
    start = end + 1;
  }
  return false;
}

function characters(bytes: Uint8Array, start: number, end: number): number {
  const text = decoder.decode(bytes.subarray(start, end));
  let count = text.length;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xdc00 && unit <= 0xdfff) count -= 1; // the second half of a pair
  }
  return count;
}

// The marks are ASCII, and no other byte decodes to ASCII as Latin-1, so the head is searched
// as Latin-1 text.
function hasGeneratedMark(bytes: Uint8Array): boolean {
  let end = 0;
  for (let line = 0; line < HEAD_LINES && end < bytes.length; line++) {
    const nl = bytes.indexOf(0x0a, end);
    end = nl === -1 ? bytes.length : nl + 1;
  }
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, end).toString(
    "latin1",
  );
  return GENERATED_MARKS.some((mark) => head.includes(mark));
}
