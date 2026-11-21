// Plain-text tables for the command line: each column as wide as its widest cell, numbers
// right-aligned and everything else left-aligned.

const NUMERIC = /^[-+]?\d/;

export function formatTable(
  header: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
): string {
  const widths = header.map((title, col) =>
    Math.max(title.length, ...rows.map((row) => (row[col] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, col) => {
        const width = widths[col] ?? cell.length;
        return NUMERIC.test(cell) ? cell.padStart(width) : cell.padEnd(width);
      })
      .join("  ")
      .trimEnd();
  const rule = widths.map((w) => "-".repeat(w)).join("  ");
  return [line(header), rule, ...rows.map(line)].join("\n");
}
