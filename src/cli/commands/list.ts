// hakutaku list [--json]
// The registered repos: one row each, with the ref, the built commit, the head the ref names,
// whether the store is stale and why, the detail, and when the store was built. Freshness is
// worded as the MCP server words it. --json prints the rows as a JSON array instead, with 12-hex
// commits or null. Exit codes: 0 done, 1 failed (the message on stderr), 2 a usage error.
import { parseArgs } from "node:util";
import type { Detail, RepoId, Stale } from "../../model/index.js";
import {
  computeFreshness,
  createRefReader,
  loadRegistry,
  type RefResult,
  type RegistryEntry,
  storePathFor,
} from "../../registry/index.js";
import { openStore, readAttempt } from "../../store/index.js";
import { formatTable, printable } from "../table.js";
import type { CliIO, Command } from "./index.js";

const USAGE = "usage: hakutaku list [--json]\n";

const parse = (argv: string[]) =>
  parseArgs({
    args: argv,
    options: { json: { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  });

interface Row {
  id: RepoId;
  ref: string;
  builtCommit: string | null; // 12 hex
  headCommit: string | null; // 12 hex
  stale: Stale;
  staleReason?: string;
  detail: Detail;
  builtAt: string | null;
}

function rowOf(
  entry: RegistryEntry,
  refs: (repoPath: string, ref: string) => RefResult,
): Row {
  const path = storePathFor(entry.id);
  const store = openStore(path);
  try {
    const freshness = computeFreshness(
      "code" in store ? store : store.meta.commit,
      refs(entry.source, entry.ref),
      readAttempt(path),
      entry.ref,
    );
    const built = "code" in store ? null : store;
    return {
      id: entry.id,
      ref: entry.ref,
      builtCommit: built?.meta.commit.slice(0, 12) ?? null,
      headCommit: freshness.headCommit?.slice(0, 12) ?? null,
      stale: freshness.stale,
      ...(freshness.reason === undefined
        ? {}
        : { staleReason: freshness.reason }),
      detail: entry.detail,
      builtAt: built?.run.builtAt ?? null,
    };
  } finally {
    if (!("code" in store)) store.close();
  }
}

// "no", or "yes" or "unknown" with the reason, on one line safe for a terminal.
function staleCell(row: Row): string {
  const word =
    row.stale === false ? "no" : row.stale === true ? "yes" : "unknown";
  return row.staleReason === undefined
    ? word
    : `${word}: ${printable(row.staleReason)}`;
}

async function run(argv: string[], io: CliIO): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.stderr(`hakutaku list: ${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  if (parsed.positionals.length > 0) {
    io.stderr(
      `hakutaku list: expected no argument, got ${parsed.positionals.length}\n${USAGE}`,
    );
    return 2;
  }
  const refs = createRefReader();
  const rows = loadRegistry().repos.map((entry) => rowOf(entry, refs));
  if (parsed.values.json === true) {
    io.stdout(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  if (rows.length === 0) {
    io.stderr("no repo is registered; run hakutaku map <repo> first\n");
    return 0;
  }
  io.stdout(
    formatTable([
      ["id", "ref", "built", "head", "stale", "detail", "built at"],
      ...rows.map((row) => [
        row.id,
        printable(row.ref),
        row.builtCommit ?? "-",
        row.headCommit ?? "-",
        staleCell(row),
        row.detail,
        row.builtAt === null ? "-" : printable(row.builtAt),
      ]),
    ]),
  );
  return 0;
}

export const listCommand: Command = {
  name: "list",
  summary: "the registered repos, their commits and their freshness",
  run,
};
