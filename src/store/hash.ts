// The content hash: SHA-256 over a canonical dump of the content tables. The dump writes each
// table as the line "#<table>", then one line per row, JSON.stringify of its values in DDL
// column order. Rows come in primary-key order, or rowid order for meta and text_index, and a
// source is written as its inflated text. run, the sqlite_* tables, FTS5's shadow tables and
// the indexes never reach it.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { inflateSync } from "node:zlib";
import { CONTENT_TABLES, ROW_KEY, sqlValue, TABLE_COLUMNS } from "./schema.js";

// node:sqlite at the Node floor has no statement iterator, so each table is read in pages, by
// keyset on its ORDER BY columns.
const PAGE_ROWS = 5000;

function visitDump(db: DatabaseSync, emit: (line: string) => void): void {
  for (const table of CONTENT_TABLES) {
    emit(`#${table}`);
    const columns = TABLE_COLUMNS[table];
    const key = ROW_KEY[table];
    const select = `SELECT ${[...new Set([...key, ...columns])].join(", ")} FROM ${table}`;
    const order = `ORDER BY ${key.join(", ")} LIMIT ${PAGE_ROWS}`;
    const after = `(${key.join(", ")}) > (${key.map(() => "?").join(", ")})`;
    const nextPage = db.prepare(`${select} WHERE ${after} ${order}`);
    let page = db.prepare(`${select} ${order}`).all();
    for (;;) {
      for (const row of page) {
        emit(
          JSON.stringify(
            columns.map((column) =>
              table === "sources" && column === "body"
                ? inflateSync(row.body as Uint8Array).toString("utf8")
                : row[column],
            ),
          ),
        );
      }
      if (page.length < PAGE_ROWS) break;
      const last = page[page.length - 1];
      page = nextPage.all(...key.map((column) => sqlValue(last[column])));
    }
  }
}

// The dump lines contentHash hashes. Internal; exported for tests.
export function contentDump(db: DatabaseSync): string[] {
  const lines: string[] = [];
  visitDump(db, (line) => {
    lines.push(line);
  });
  return lines;
}

// SHA-256, in lower-case hex, of the dump's lines joined with "\n", as UTF-8.
export function contentHash(db: DatabaseSync): string {
  const hash = createHash("sha256");
  let first = true;
  visitDump(db, (line) => {
    if (!first) hash.update("\n");
    hash.update(line, "utf8");
    first = false;
  });
  return hash.digest("hex");
}
