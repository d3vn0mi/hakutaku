// Text that a repository or a person can put where a command prints a name, a path or a message,
// and the check that none of it reaches a terminal raw. Each character is built from its code,
// so that no file holds one raw.
const ch = (...codes: number[]): string => String.fromCharCode(...codes);

// ESC [2J, which clears a terminal; a C1 CSI, which starts an escape sequence on its own; the
// line separator; and a right-to-left override, which reverses the text after it.
export const HOSTILE = `sky${ch(0x1b)}[2J${ch(0x9b)}31m${ch(0x2028)}${ch(0x202e)}map`;

// HOSTILE as printable() shows it.
export const HOSTILE_SHOWN = "sky?[2J?31m; ?map";

// The characters printable() never lets through, besides the control characters: NEL, the line
// and paragraph separators, and the bidirectional controls.
const NOT_PRINTABLE = new Set([
  0x85, 0x2028, 0x2029, 0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d,
  0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
]);

const raw = (c: string): boolean =>
  /\p{Cc}/u.test(c) || NOT_PRINTABLE.has(c.codePointAt(0) ?? 0);

// Each line of text, split at LF, that holds a character a terminal must not get raw.
export function rawLines(text: string): string[] {
  return text.split("\n").filter((line) => [...line].some(raw));
}
