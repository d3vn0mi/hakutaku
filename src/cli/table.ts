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

// Kept in src/redact, where the code below the commands that writes on stderr itself reaches them.
export {
  errorDetail,
  printable,
  printableLines,
} from "../redact/printable.js";
