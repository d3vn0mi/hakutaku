// Text made safe to print on a terminal: a repository's or a person's text, which can hold
// escape sequences and characters that change or reorder what a terminal shows.

// A text that may hold a repository's bytes, such as an engine's error or a manifest's name, as
// one line safe for a terminal: each line break (CR, LF, and NEL and the line and paragraph
// separators, which Unicode takes for line breaks too) and the spaces around it become "; ", and
// every other control character "?", as does each bidirectional control, which would show the
// text around it in another order than its own. So no escape sequence reaches the terminal, and
// the text keeps its line and its order.
export function printable(text: string): string {
  return text
    .replace(/[\s\u0085]*[\r\n\u0085\u2028\u2029][\s\u0085]*/g, "; ")
    .replace(/[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "?");
}

// A text of several lines, such as an error's message or its stack, with its line breaks kept,
// CRLF and a lone CR each as LF, and every line made safe for a terminal by printable().
export function printableLines(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => printable(line))
    .join("\n");
}

// An exception a tool raised, as hakutaku query and hakutaku mcp print it on stderr: its stack,
// or else its message, through printableLines(), since either can quote a repository's text.
export function errorDetail(err: unknown): string {
  return printableLines(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
}
