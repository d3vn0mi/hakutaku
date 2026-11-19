import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { CONTENT_TABLES, DDL } from "../../../src/store/index.js";
import { ROW_KEY, TABLE_COLUMNS } from "../../../src/store/schema.js";

it("creates every table of the schema", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(DDL);
  const names = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table') AND name NOT LIKE 'text_index_%' ORDER BY name",
    )
    .all()
    .map((r) => r.name);
  expect(names).toEqual([...CONTENT_TABLES, "run"].sort());
});

it("creates the four lookup indexes", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(DDL);
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((r) => r.name),
  ).toEqual([
    "call_sites_callee",
    "call_targets_def",
    "imports_dst",
    "refs_def",
  ]);
});

it("indexes text with the case-sensitive trigram tokenizer", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(DDL);
  db.prepare(
    "INSERT INTO text_index (text, file_id, line) VALUES (?, ?, ?)",
  ).run("const observatoryValue = 1;", 1, 3);
  expect(
    db
      .prepare("SELECT line FROM text_index WHERE text_index MATCH ?")
      .all('"atoryVal"'),
  ).toEqual([{ line: 3 }]);
  expect(
    db
      .prepare("SELECT line FROM text_index WHERE text_index MATCH ?")
      .all('"ATORYVAL"'),
  ).toEqual([]);
});

it("lists each table's columns in DDL order, and keys its dump by the primary key or rowid", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(DDL);
  for (const table of [...CONTENT_TABLES, "run"] as const) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all();
    expect(TABLE_COLUMNS[table], table).toEqual(info.map((c) => c.name));
    if (table === "run") continue;
    // a composite key in the order of its PRIMARY KEY clause, not of the columns
    const key = info
      .filter((c) => Number(c.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((c) => c.name);
    expect(ROW_KEY[table], table).toEqual(key.length > 0 ? key : ["rowid"]);
  }
  expect(ROW_KEY.meta).toEqual(["rowid"]);
  expect(ROW_KEY.text_index).toEqual(["rowid"]);
  expect(ROW_KEY.entry_points).toEqual([
    "file_id",
    "kind",
    "manifest_file_id",
    "manifest_line",
    "name",
  ]);
});
