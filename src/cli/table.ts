// Text the commands print for a person: tables, and text that came from a repository.

// Rows as lines: each column as wide as its widest cell and two spaces apart, with nothing after
// the last cell.
export function formatTable(rows: ReadonlyArray<readonly string[]>): string {
  const widths =
    rows[0]?.map((_, i) =>
      Math.max(...rows.map((row) => (row[i] ?? "").length)),
    ) ?? [];
  return rows
    .map((row) =>
      row
        .map((cell, i) =>
          i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0),
        )
        .join("  "),
    )
    .map((line) => `${line}\n`)
    .join("");
}

// A text that may hold a repository's bytes, such as an engine's error or a manifest's name, as
// one line safe for a terminal: each line break and the spaces around it become "; ", and every
// other control character "?", so that no escape sequence reaches the terminal.
export function printable(text: string): string {
  return text.replace(/\s*(?:\r\n|\r|\n)\s*/g, "; ").replace(/\p{Cc}/gu, "?");
}
