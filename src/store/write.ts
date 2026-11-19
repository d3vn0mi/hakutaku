// writeStore: a new store file from StoreContent. It checks the content before it creates the
// file: meta's one row, each table's row order, ids 1..n in that order, and the type of every
// cell. Then it writes every table and run in one transaction, and leaves the file closed, in
// rollback-journal mode. A store it refuses leaves no file behind.
import { existsSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { deflateSync } from "node:zlib";
import { comparePaths } from "../model/order.js";
import { contentHash } from "./hash.js";
import {
  CONTENT_TABLES,
  type ContentTable,
  DDL,
  ROW_KEY,
  sqlValue,
  TABLE_COLUMNS,
} from "./schema.js";
import type {
  Coverage,
  GateResult,
  RuleFindingRow,
  StoreContent,
} from "./types.js";

type Row = Readonly<Record<string, unknown>>;
// A cell as the order check sees it. A source is its text here; it is deflated when written.
type Cell = null | number | string;

// Each table's row order: these columns, then its other columns in DDL order, an id never
// among them. A path order compares file ids, since files are numbered in path order.
const ROW_ORDER: Readonly<Record<ContentTable, readonly string[]>> = {
  meta: [],
  components: ["path"],
  files: ["path"],
  sources: ["file_id"],
  definitions: ["file_id", "start_line", "start_col", "qualname", "ordinal"],
  externals: ["ecosystem", "name"],
  imports: ["src_file_id", "line", "specifier", "kind"],
  call_sites: ["file_id", "line", "col"],
  call_targets: ["site_id", "def_id"],
  refs: ["file_id", "line", "col", "def_id"],
  entry_points: [
    "file_id",
    "kind",
    "manifest_file_id",
    "manifest_line",
    "name",
  ],
  file_metrics: ["file_id"],
  def_metrics: ["def_id"],
  cochange: ["file_id", "partner_file_id"],
  cycles: ["cycle_id", "ord"],
  rule_findings: ["rule", "from_file_id", "to_file_id"],
  timeline: ["week_start"],
  renames: ["old_path", "new_path", "commit_sha"],
  text_index: ["file_id", "line"],
};

const COVERAGE_KEYS = [
  "files",
  "indexed",
  "unresolvedImports",
  "callSites",
  "redactions",
  "tiers",
  "pythonResolver",
  "computedImports",
  "unmatchedScipDefinitions",
  "unmatchedBoundUses",
  "cycleDifferences",
  "noSourceFiles",
  "denied",
  "cycleSeverity",
] as const satisfies readonly (keyof Coverage)[];

// The JSON columns. A map keyed by data is written with its keys sorted by comparePaths; every
// other object keeps the key order its type declares, whatever order it was built in.
const JSON_CELLS: ReadonlyMap<string, (value: unknown) => string> = new Map([
  ["meta.engines", (v: unknown) => mapJson(v, "meta.engines")],
  ["meta.coverage", (v: unknown) => coverageJson(v as Coverage)],
  [
    "meta.gates",
    (v: unknown) =>
      arrayJson(v, "meta.gates", (g: GateResult, at) =>
        fieldsJson(g, ["gate", "ok", "detail"], at),
      ),
  ],
  [
    "rule_findings.chain",
    (v: unknown) =>
      arrayJson(v, "rule_findings.chain", (s: RuleFindingRow["chain"][0], at) =>
        fieldsJson(s, ["from", "to", "line"], at),
      ),
  ],
]);

export function writeStore(
  path: string,
  content: StoreContent,
): { contentHash: string } {
  checkContent(content);
  if (existsSync(path)) throw new Error(`writeStore: ${path} already exists`);
  const db = new DatabaseSync(path);
  let written = false;
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("BEGIN");
    // A row may name a later row of its own table, such as a component that splits from one
    // later in path order, so references are checked at COMMIT.
    db.exec("PRAGMA defer_foreign_keys = ON");
    db.exec(DDL);
    for (const table of CONTENT_TABLES) {
      insertRows(db, table, rowsOf(content, table));
    }
    const hash = contentHash(db);
    db.prepare(
      `INSERT INTO run (${TABLE_COLUMNS.run.join(", ")}) VALUES (?, ?, ?)`,
    ).run(content.run.ref, hash, content.run.built_at);
    commit(db, content);
    db.exec("PRAGMA journal_mode = DELETE");
    written = true;
    return { contentHash: hash };
  } finally {
    if (!written) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // no transaction is open
      }
    }
    db.close();
    if (!written) {
      rmSync(path, { force: true });
      rmSync(`${path}-journal`, { force: true });
    }
  }
}

function checkContent(content: StoreContent): void {
  if (rowsOf(content, "meta").length !== 1) {
    throw new Error(
      `store content: meta holds ${content.meta.length} rows, not one`,
    );
  }
  const run: unknown = content.run;
  if (
    typeof run !== "object" ||
    run === null ||
    !("ref" in run && typeof run.ref === "string") ||
    !("built_at" in run && typeof run.built_at === "string")
  ) {
    throw new Error("store content: run needs a string ref and built_at");
  }
  for (const table of CONTENT_TABLES) {
    const columns = TABLE_COLUMNS[table];
    const hasId = columns[0] === "id";
    const order = [
      ...ROW_ORDER[table],
      ...columns.filter((c) => c !== "id" && !ROW_ORDER[table].includes(c)),
    ].map((c) => columns.indexOf(c));
    let previous: Cell[] | undefined;
    rowsOf(content, table).forEach((row, i) => {
      const n = i + 1;
      const cells = cellsOf(table, row, n);
      if (hasId && cells[0] !== n) {
        throw new Error(
          `row order: ${table}: row ${n} has id ${String(cells[0])}, not ${n}`,
        );
      }
      if (previous !== undefined) {
        const c = compareRows(previous, cells, order);
        if (c === 0) {
          throw new Error(`row order: ${table}: row ${n} repeats row ${n - 1}`);
        }
        if (c > 0) {
          throw new Error(
            `row order: ${table}: row ${n} sorts before row ${n - 1}`,
          );
        }
      }
      previous = cells;
    });
  }
}

function insertRows(
  db: DatabaseSync,
  table: ContentTable,
  rows: readonly Row[],
): void {
  if (rows.length === 0) return;
  // text_index has no key of its own: its rowid is the row's place in the row order.
  const columns =
    table === "text_index"
      ? ["rowid", ...TABLE_COLUMNS[table]]
      : TABLE_COLUMNS[table];
  const insert = db.prepare(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  );
  rows.forEach((row, i) => {
    const n = i + 1;
    const cells = cellsOf(table, row, n);
    const values =
      table === "sources"
        ? [cells[0], deflateSync(String(cells[1]), { level: 9 })]
        : table === "text_index"
          ? [n, ...cells]
          : cells;
    try {
      insert.run(...values.map(sqlValue));
    } catch (error) {
      throw new Error(
        `store content: ${table} row ${n}: ${(error as Error).message}`,
      );
    }
  });
}

// A COMMIT refused for a missing referenced row leaves the transaction open, so the check can
// still name the first such row.
function commit(db: DatabaseSync, content: StoreContent): void {
  try {
    db.exec("COMMIT");
  } catch (error) {
    const missing = db.prepare("PRAGMA foreign_key_check").all();
    const first = missing[0];
    if (first === undefined) throw error;
    const table = String(first.table) as ContentTable;
    const column = String(
      db
        .prepare(`PRAGMA foreign_key_list(${table})`)
        .all()
        .find((fk) => fk.id === first.fkid)?.from,
    );
    const n = placeOf(content, table, Number(first.rowid));
    const more =
      missing.length > 1 ? ` (${missing.length} missing rows in all)` : "";
    throw new Error(
      `store content: ${table} row ${n}: ${column} ${String(rowsOf(content, table)[n - 1]?.[column])} names no ${String(first.parent)} row${more}`,
    );
  }
}

// The 1-based place in its table's rows of the row SQLite numbered rowid. A table whose key is
// one integer column numbers its rows by that key; any other table numbers them as inserted.
function placeOf(
  content: StoreContent,
  table: ContentTable,
  rowid: number,
): number {
  const [key, ...rest] = ROW_KEY[table];
  if (key === undefined || key === "rowid" || rest.length > 0) return rowid;
  return rowsOf(content, table).findIndex((row) => row[key] === rowid) + 1;
}

function rowsOf(content: StoreContent, table: ContentTable): readonly Row[] {
  const rows: unknown = content[table];
  if (!Array.isArray(rows)) {
    throw new Error(`store content: ${table} is not an array`);
  }
  return rows;
}

// A row's cells in DDL column order: JSON columns as their text, a source as its text.
function cellsOf(table: ContentTable, row: Row, n: number): Cell[] {
  return TABLE_COLUMNS[table].map((column) => {
    const name = table === "sources" && column === "body" ? "text" : column;
    const value = row[name];
    const where = `${table} row ${n}: ${name}`;
    const json = JSON_CELLS.get(`${table}.${column}`);
    if (json !== undefined) return json(value);
    if (name === "text" && typeof value !== "string") {
      throw new Error(`store content: ${where} is not a string`);
    }
    if (
      value === null ||
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      return value;
    }
    throw new Error(
      `store content: ${where} is ${value === undefined ? "missing" : "not a finite number, a string or null"}`,
    );
  });
}

// NULL first, then numbers, then strings, as SQLite orders them. Strings compare by
// comparePaths, never by locale.
function compareRows(
  a: readonly Cell[],
  b: readonly Cell[],
  order: readonly number[],
): number {
  for (const i of order) {
    const x = a[i] ?? null;
    const y = b[i] ?? null;
    const rank = cellRank(x) - cellRank(y);
    if (rank !== 0) return rank;
    if (typeof x === "number" && typeof y === "number" && x !== y) {
      return x < y ? -1 : 1;
    }
    if (typeof x === "string" && typeof y === "string" && x !== y) {
      return comparePaths(x, y);
    }
  }
  return 0;
}

const cellRank = (cell: Cell): number =>
  cell === null ? 0 : typeof cell === "number" ? 1 : 2;

function coverageJson(coverage: Coverage): string {
  objectAt(coverage, "meta.coverage");
  return objectJson(
    COVERAGE_KEYS.map((key) => {
      const at = `meta.coverage.${key}`;
      if (key === "indexed" || key === "tiers") {
        return [key, mapJson(coverage[key], at)];
      }
      if (key === "callSites") {
        return [
          key,
          fieldsJson(coverage.callSites, ["bound", "scoped", "unresolved"], at),
        ];
      }
      return [key, json(coverage[key], at)];
    }),
  );
}

function mapJson(map: unknown, at: string): string {
  const value = objectAt(map, at);
  return objectJson(
    Object.keys(value)
      .sort(comparePaths)
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, json(value[key], `${at}.${key}`)]),
  );
}

function fieldsJson<T extends object>(
  value: T,
  keys: readonly (keyof T & string)[],
  at: string,
): string {
  objectAt(value, at);
  return objectJson(keys.map((key) => [key, json(value[key], `${at}.${key}`)]));
}

function arrayJson<T>(
  value: unknown,
  at: string,
  item: (element: T, at: string) => string,
): string {
  if (!Array.isArray(value)) {
    throw new Error(`store content: ${at} is not an array`);
  }
  return `[${value.map((element: T, i) => item(element, `${at}[${i}]`)).join(",")}]`;
}

// JSON text of an object whose values are already JSON text, its keys in the order given.
const objectJson = (entries: readonly (readonly [string, string])[]): string =>
  `{${entries.map(([key, text]) => `${JSON.stringify(key)}:${text}`).join(",")}}`;

function objectAt(value: unknown, at: string): Row {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`store content: ${at} is not an object`);
  }
  return value as Row;
}

function json(value: unknown, at: string): string {
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new Error(`store content: ${at} is not a JSON value`);
  }
  return text;
}
