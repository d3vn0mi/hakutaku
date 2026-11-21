// Rows as CSV, as RFC 4180 writes them: a cell holding a comma, a double quote or a line end is
// quoted, with each double quote doubled.

const NEEDS_QUOTES = /[",\r\n]/;

function quote(cell: string): string {
  return NEEDS_QUOTES.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

export function toCsv(
  header: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
): string {
  return [header, ...rows].map((row) => row.map(quote).join(",")).join("\n");
}
