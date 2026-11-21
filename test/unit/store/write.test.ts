import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inflateSync } from "node:zlib";
import { expect, it } from "vitest";
import {
  type Coverage,
  contentHash,
  type FileRow,
  type GateResult,
  writeStore,
} from "../../../src/store/index.js";
import { emptyContent, miniStore } from "../../helpers/mini-store.js";

// One shape serves every test: the writer checks row order and references, not what a row
// says about its file.
const fileRow = (id: number, path: string): FileRow => ({
  id,
  path,
  lang: "typescript",
  kind: "code",
  component_id: null,
  lines: 1,
  bytes: 13,
  blob_sha: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
  mode: "100644",
  link_target: null,
  entry: 0,
  has_source: 0,
});

const hashOf = (path: string): string => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return contentHash(db);
  } finally {
    db.close();
  }
};

// The same keys and values, in the reverse insertion order.
const reversed = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).reverse()) as T;

it("refuses rows out of order", () => {
  const c = emptyContent();
  c.files = [fileRow(2, "b.ts"), fileRow(1, "a.ts")];
  expect(() => miniStore(c)).toThrow(/row order: files/);
  // ids that count from 1 do not excuse paths out of order
  c.files = [fileRow(1, "b.ts"), fileRow(2, "a.ts")];
  expect(() => miniStore(c)).toThrow(/row order: files/);
});

it("refuses ids that do not count 1..n in row order", () => {
  const c = emptyContent();
  c.files = [fileRow(1, "a.ts"), fileRow(3, "b.ts")];
  expect(() => miniStore(c)).toThrow(/row order: files: row 2 has id 3, not 2/);
  c.files = [fileRow(0, "a.ts")];
  expect(() => miniStore(c)).toThrow(/row order: files: row 1 has id 0, not 1/);
});

it("orders paths by UTF-16 code units, never by locale", () => {
  const c = emptyContent();
  // "Z" (U+005A) before "a" (U+0061); U+1F52D's surrogate D83D before U+FFFD
  c.files = [
    fileRow(1, "Zenith.ts"),
    fileRow(2, "apsis.ts"),
    fileRow(3, "\u{1F52D}.ts"),
    fileRow(4, "�.ts"),
  ];
  expect(() => miniStore(c)).not.toThrow();
  c.files = [fileRow(1, "apsis.ts"), fileRow(2, "Zenith.ts")];
  expect(() => miniStore(c)).toThrow(
    /row order: files: row 2 sorts before row 1/,
  );
  c.files = [fileRow(1, "�.ts"), fileRow(2, "\u{1F52D}.ts")];
  expect(() => miniStore(c)).toThrow(
    /row order: files: row 2 sorts before row 1/,
  );
});

it("sorts the keys of maps keyed by data", () => {
  const c = emptyContent();
  c.meta[0].engines = { "scip-typescript": "1", "ast-grep": "2" };
  const db = new DatabaseSync(miniStore(c), { readOnly: true });
  expect(db.prepare("SELECT engines FROM meta").get()?.engines).toBe(
    '{"ast-grep":"2","scip-typescript":"1"}',
  );
});

it("stores sources deflated", () => {
  const c = emptyContent();
  c.files = [fileRow(1, "a.ts")];
  c.sources = [{ file_id: 1, text: "const a = 1;\n" }];
  const db = new DatabaseSync(miniStore(c), { readOnly: true });
  expect(
    inflateSync(
      db.prepare("SELECT body FROM sources").get()?.body as Uint8Array,
    ).toString(),
  ).toBe("const a = 1;\n");
});

it("leaves no -wal or -shm file and records the content hash in run", () => {
  const path = miniStore(emptyContent());
  expect(existsSync(`${path}-wal`) || existsSync(`${path}-shm`)).toBe(false);
  // the header's write and read versions: 1 in rollback-journal mode, 2 in WAL mode
  expect([...readFileSync(path).subarray(18, 20)]).toEqual([1, 1]);
  const db = new DatabaseSync(path, { readOnly: true });
  expect(db.prepare("SELECT content_hash FROM run").get()?.content_hash).toBe(
    contentHash(db),
  );
});

it("breaks a tie on the remaining columns in DDL order, and refuses a repeated row", () => {
  const c = emptyContent();
  // text_index orders by (file, line); the text breaks the tie
  c.text_index = [
    { text: "perihelion", file_id: 1, line: 2 },
    { text: "aphelion", file_id: 1, line: 2 },
  ];
  expect(() => miniStore(c)).toThrow(/row order: text_index: row 2 /);
  c.text_index.reverse();
  expect(() => miniStore(c)).not.toThrow();
  c.timeline = [
    { week_start: 604800, commits: 1 },
    { week_start: 604800, commits: 1 },
  ];
  expect(() => miniStore(c)).toThrow(
    /row order: timeline: row 2 repeats row 1/,
  );
});

it("accepts a reference to a later row, and refuses one to a missing row", () => {
  const c = emptyContent();
  // the root component splits, and "-tools/" sorts before "./"
  c.components = [
    {
      id: 1,
      path: "-tools/",
      kind: "split",
      parent_id: 2,
      files: 0,
      tests: 0,
      lines: 0,
    },
    {
      id: 2,
      path: "./",
      kind: "folder",
      parent_id: null,
      files: 0,
      tests: 0,
      lines: 0,
    },
  ];
  expect(() => miniStore(c)).not.toThrow();
  c.imports = [
    {
      id: 1,
      src_file_id: 9,
      dst_file_id: null,
      dst_external_id: null,
      kind: "static",
      line: 1,
      specifier: "./kepler",
      resolved: 0,
      producer: "dependency-cruiser",
    },
  ];
  expect(() => miniStore(c)).toThrow(
    /imports row 1: src_file_id 9 names no files row/,
  );
});

it("writes coverage and gates in the key order of their types, with coverage's maps sorted", () => {
  const coverage: Coverage = {
    files: 6,
    indexed: { javascript: 1, python: 2, typescript: 3 },
    unresolvedImports: 0,
    callSites: { bound: 4, scoped: 1, unresolved: 2 },
    redactions: 1,
    tiers: {
      "ast-grep": "ran",
      grimp: "fallback",
      "scip-typescript": "skipped",
    },
    pythonResolver: "hakutaku-resolver",
    computedImports: 0,
    unmatchedScipDefinitions: 0,
    unmatchedBoundUses: 0,
    cycleDifferences: 0,
    noSourceFiles: 0,
    denied: 0,
    cycleSeverity: "error",
  };
  const gates: GateResult[] = [
    { gate: "redaction", ok: false, detail: "1 secret" },
  ];
  const a = emptyContent();
  a.meta[0].coverage = coverage;
  a.meta[0].gates = gates;
  const b = emptyContent();
  b.meta[0].coverage = reversed({
    ...coverage,
    indexed: reversed(coverage.indexed),
    callSites: reversed(coverage.callSites),
    tiers: reversed(coverage.tiers),
  });
  b.meta[0].gates = gates.map(reversed);
  const pathA = miniStore(a);
  const db = new DatabaseSync(pathA, { readOnly: true });
  expect(db.prepare("SELECT coverage, gates FROM meta").get()).toEqual({
    coverage:
      '{"files":6,"indexed":{"javascript":1,"python":2,"typescript":3},"unresolvedImports":0,' +
      '"callSites":{"bound":4,"scoped":1,"unresolved":2},"redactions":1,' +
      '"tiers":{"ast-grep":"ran","grimp":"fallback","scip-typescript":"skipped"},' +
      '"pythonResolver":"hakutaku-resolver","computedImports":0,"unmatchedScipDefinitions":0,' +
      '"unmatchedBoundUses":0,"cycleDifferences":0,"noSourceFiles":0,"denied":0,"cycleSeverity":"error"}',
    gates: '[{"gate":"redaction","ok":false,"detail":"1 secret"}]',
  });
  expect(hashOf(miniStore(b))).toBe(hashOf(pathA));
});

it("writes the tiers that ran out of memory last, with their map sorted, and only when there are any", () => {
  const capped =
    "reached the 3G memory cap; rebuild with a larger --memory-max";
  const heap = "ran out of JavaScript heap; rebuild with a larger --memory-max";
  const a = emptyContent();
  a.meta[0].coverage = {
    ...a.meta[0].coverage,
    outOfMemory: {
      memoryMax: "3G",
      tiers: { "dependency-cruiser": capped, "scip-typescript": heap },
    },
  };
  const b = emptyContent();
  b.meta[0].coverage = {
    ...b.meta[0].coverage,
    outOfMemory: reversed({
      memoryMax: "3G",
      tiers: reversed({
        "dependency-cruiser": capped,
        "scip-typescript": heap,
      }),
    }),
  };
  const pathA = miniStore(a);
  const db = new DatabaseSync(pathA, { readOnly: true });
  const { coverage } = db.prepare("SELECT coverage FROM meta").get() as {
    coverage: string;
  };
  db.close();
  expect(coverage).toMatch(
    new RegExp(
      `,"cycleSeverity":"warn","outOfMemory":\\{"memoryMax":"3G","tiers":\\{"dependency-cruiser":"${capped}","scip-typescript":"${heap}"\\}\\}\\}$`,
    ),
  );
  expect(hashOf(miniStore(b))).toBe(hashOf(pathA));
  // with none, the key is not written, so such a store hashes as it always did
  const none = emptyContent();
  const plain = new DatabaseSync(miniStore(none), { readOnly: true });
  expect(
    (plain.prepare("SELECT coverage FROM meta").get() as { coverage: string })
      .coverage,
  ).not.toContain("outOfMemory");
  plain.close();
});

it("leaves no file when it refuses content, and never writes over a file", () => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-write-"));
  try {
    const path = join(dir, "store.sqlite");
    const c = emptyContent();
    c.files = [fileRow(1, "kepler.ts")];
    c.cochange = [{ file_id: 1, partner_file_id: 2, commits: 2 }];
    expect(() => writeStore(path, c)).toThrow(
      /cochange row 1: partner_file_id 2 names no files row/,
    );
    expect(existsSync(path) || existsSync(`${path}-journal`)).toBe(false);
    writeFileSync(path, "observatory");
    expect(() => writeStore(path, emptyContent())).toThrow(/already exists/);
    expect(readFileSync(path, "utf8")).toBe("observatory");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// SQLite follows a link at the path it creates, so a link there, even one naming no file yet, is
// refused as a file that already exists.
it.skipIf(process.platform === "win32")(
  "never writes through a link at its path, even one that names no file yet",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "hakutaku-write-"));
    try {
      const path = join(dir, "store.tmp.sqlite");
      const target = join(dir, "planted.sqlite");
      symlinkSync(target, path);
      expect(() => writeStore(path, emptyContent())).toThrow(
        `writeStore: ${path} already exists`,
      );
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
