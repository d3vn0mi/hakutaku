import { formatDeclination, formatMagnitude, formatRightAscension } from "../format/angles";
import { formatTable } from "../format/table";
import { Catalog } from "../sky/catalog";
import { toCsv } from "./csv";

const USAGE = "usage: export-sky [--csv] [--limit N]";

// The export-sky command: prints the brightest stars as a table, or as CSV with --csv. Writes
// each line through `write`, and returns the exit status.
export function exportSky(args: readonly string[], write: (line: string) => void): number {
  let csv = false;
  let limit = 10;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--csv") {
      csv = true;
    } else if (arg === "--limit") {
      limit = Number(args[++i]);
    } else {
      write(`export-sky: unknown argument ${JSON.stringify(arg)}\n${USAGE}`);
      return 2;
    }
  }
  if (!Number.isInteger(limit) || limit < 1) {
    write(`export-sky: --limit takes a whole number above 0\n${USAGE}`);
    return 2;
  }
  const header = ["name", "ra", "dec", "magnitude"];
  const rows = new Catalog()
    .brightest(limit)
    .map((s) => [
      s.name,
      formatRightAscension(s.ra),
      formatDeclination(s.dec),
      formatMagnitude(s.magnitude),
    ]);
  write(csv ? toCsv(header, rows) : formatTable(header, rows));
  return 0;
}

// Run as the package's bin, dist/cli/export-sky.js; importing the module runs nothing.
if (process.argv[1]?.endsWith("export-sky.js")) {
  process.exitCode = exportSky(process.argv.slice(2), (line) => console.log(line));
}
