import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { contentDump } from "../../../src/store/hash.js";
import { contentHash, type FileRow } from "../../../src/store/index.js";
import { HAKUTAKU_VERSION } from "../../../src/version.js";
import { emptyContent, miniStore } from "../../helpers/mini-store.js";

const fileRow = (id: number, path: string): FileRow => ({
  id,
  path,
  lang: "typescript",
  kind: "code",
  component_id: null,
  lines: 1,
  bytes: 25,
  blob_sha: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
  mode: "100644",
  link_target: null,
  entry: 0,
  has_source: 1,
});

const hashOf = (path: string): string => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return contentHash(db);
  } finally {
    db.close();
  }
};

const dumpOf = (path: string): string[] => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return contentDump(db);
  } finally {
    db.close();
  }
};

// The row lines of one table: those after its "#<table>" line, up to the next table's.
const section = (lines: string[], table: string): string[] => {
  const start = lines.indexOf(`#${table}`) + 1;
  const end = lines.findIndex((l, i) => i >= start && l.startsWith("#"));
  return lines.slice(start, end === -1 ? undefined : end);
};

it("dumps a table as #name and one JSON line per row", () => {
  const lines = contentDump(
    new DatabaseSync(miniStore(emptyContent()), { readOnly: true }),
  );
  expect(lines[0]).toBe("#meta");
  expect(
    lines[1].startsWith(
      `[1,${JSON.stringify(HAKUTAKU_VERSION)},"observatory",`,
    ),
  ).toBe(true);
  expect(lines).toContain("#text_index");
});

it("ignores run", () => {
  const a = emptyContent();
  const b = emptyContent();
  b.run = { ref: "main", built_at: "2026-02-01T00:00:00Z" };
  expect(hashOf(miniStore(a))).toBe(hashOf(miniStore(b)));
});

it("changes when one cell changes", () => {
  const a = emptyContent();
  const b = emptyContent();
  b.meta[0].detail = "quick";
  expect(hashOf(miniStore(a))).not.toBe(hashOf(miniStore(b)));
});

it("dumps a source as its inflated text, and cells as JSON numbers, strings and null", () => {
  const c = emptyContent();
  c.files = [fileRow(1, "kepler.ts")];
  c.sources = [{ file_id: 1, text: "export const e = 0.0167;\n" }];
  c.file_metrics = [
    {
      file_id: 1,
      pagerank: 0.125,
      dependents_rank: 1,
      fan_in: 0,
      fan_out: 0,
      churn_90d: 2,
      hotspot: null,
      cycle_id: null,
      core: 1,
      last_change: 1767225600,
    },
  ];
  const lines = dumpOf(miniStore(c));
  expect(section(lines, "sources")).toEqual([
    '[1,"export const e = 0.0167;\\n"]',
  ]);
  expect(section(lines, "file_metrics")).toEqual([
    "[1,0.125,1,0,0,2,null,null,1,1767225600]",
  ]);
  expect(section(lines, "files")).toEqual([
    '[1,"kepler.ts","typescript","code",null,1,25,"e69de29bb2d1d6434b8b29ae775ad8c2e48c5391","100644",null,0,1]',
  ]);
});

it("reads every row of a table longer than a page, in key order", () => {
  const c = emptyContent();
  // 12,006 rows: the pages of 5,000 end inside runs of rows that share a key prefix
  for (let g = 0; g < 1334; g++) {
    for (const n of [0, 1, 2]) {
      for (const s of [0, 1, 2]) {
        c.renames.push({
          old_path: `src/old-${String(g).padStart(4, "0")}.ts`,
          new_path: `src/new-${n}.ts`,
          commit_sha: String(s).repeat(40),
        });
      }
    }
  }
  for (let line = 1; line <= 12006; line++) {
    c.text_index.push({ text: `orbit ${line}`, file_id: 1, line });
  }
  const lines = dumpOf(miniStore(c));
  expect(section(lines, "renames")).toEqual(
    c.renames.map((r) =>
      JSON.stringify([r.old_path, r.new_path, r.commit_sha]),
    ),
  );
  expect(section(lines, "text_index")).toEqual(
    c.text_index.map((r) => JSON.stringify([r.text, r.file_id, r.line])),
  );
});
