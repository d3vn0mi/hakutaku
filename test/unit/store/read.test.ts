import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, expect, it } from "vitest";
import {
  contentHash,
  openStore,
  type Store,
  type StoreContent,
  type StoreMeta,
} from "../../../src/store/index.js";
import { HAKUTAKU_VERSION } from "../../../src/version.js";
import { emptyContent, miniStore } from "../../helpers/mini-store.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A fresh directory under the OS temp directory, removed after the file's last test.
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-read-"));
  made.push(dir);
  return dir;
};

const writeTmp = (name: string, text: string): string => {
  const path = join(tmp(), name);
  writeFileSync(path, text);
  return path;
};

// A SQLite file at a store's path, made by sql alone.
const sqliteWith = (sql: string): string => {
  const path = join(tmp(), "store.sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
  return path;
};

const emptySqlite = (): string => sqliteWith("CREATE TABLE orbits (name TEXT)");

const withSchema = (n: number): string => {
  const c = emptyContent();
  c.meta[0].schema_version = n;
  return miniStore(c);
};

// A store written from emptyContent, then changed in place by sql.
const changed = (sql: string): string => {
  const path = miniStore(emptyContent());
  const db = new DatabaseSync(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
  return path;
};

const hashOf = (path: string): string => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return contentHash(db);
  } finally {
    db.close();
  }
};

it.each<[string, () => string, string]>([
  ["a missing file", () => join(tmp(), "store.sqlite"), "not built yet"],
  [
    "a file that is not SQLite",
    () => writeTmp("store.sqlite", "observatory"),
    "store unreadable",
  ],
  ["a SQLite file without meta", () => emptySqlite(), "not an hakutaku store"],
  [
    "a newer schema",
    () => withSchema(2),
    "store schema 2 is newer than this hakutaku's schema 1",
  ],
])("answers not_built for %s", (_, make, reason) =>
  expect(openStore(make())).toEqual({ code: "not_built", reason }),
);

it("opens read-only and parses meta", () => {
  const path = miniStore(emptyContent());
  const s = openStore(path) as Store;
  expect(s.meta.repoId).toBe("observatory");
  expect(s.meta.coverage.cycleSeverity).toBe("warn");
  expect(() => s.db.exec("DELETE FROM meta")).toThrow(/readonly/i);
  // every field of meta, by its StoreMeta name, and run
  const meta: StoreMeta = {
    schemaVersion: 1,
    hakutakuVersion: HAKUTAKU_VERSION,
    repoId: "observatory",
    commit: "fedcba9876543210fedcba9876543210fedcba98",
    commitTime: 1767225600,
    detail: "standard",
    noSource: false,
    engines: {},
    engineLockHash: "0".repeat(64),
    profileHash: "0".repeat(64),
    rulesHash: "",
    coverage: {
      files: 0,
      indexed: {},
      unresolvedImports: 0,
      callSites: { bound: 0, scoped: 0, unresolved: 0 },
      redactions: 0,
      tiers: {},
      pythonResolver: "none",
      computedImports: 0,
      unmatchedScipDefinitions: 0,
      unmatchedBoundUses: 0,
      cycleDifferences: 0,
      noSourceFiles: 0,
      denied: 0,
      cycleSeverity: "warn",
    },
    gates: [
      { gate: "files-indexed", ok: true, detail: "passed" },
      { gate: "unresolved-imports", ok: true, detail: "passed" },
      { gate: "scip-duplicates", ok: true, detail: "passed" },
      { gate: "denylist", ok: true, detail: "passed" },
      { gate: "redaction", ok: true, detail: "passed" },
    ],
  };
  expect(s.path).toBe(path);
  expect(s.meta).toEqual(meta);
  expect(s.run).toEqual({
    ref: "HEAD",
    contentHash: hashOf(path),
    builtAt: "2026-01-01T00:00:00Z",
  });
  s.close();
  // other values in every field: a 1 in no_source, and maps with keys
  const c: StoreContent = emptyContent("kepler");
  c.meta[0] = {
    ...c.meta[0],
    commit_sha: "0123456789abcdef0123456789abcdef01234567",
    commit_time: 1767312000,
    detail: "deep",
    no_source: 1,
    engines: { "ast-grep": "0.39.0", grimp: "3.9" },
    engine_lock_hash: "1".repeat(64),
    profile_hash: "2".repeat(64),
    rules_hash: "3".repeat(64),
    coverage: {
      ...c.meta[0].coverage,
      files: 7,
      indexed: { python: 2, typescript: 3 },
      callSites: { bound: 4, scoped: 1, unresolved: 2 },
      tiers: { "ast-grep": "ran", grimp: "fallback" },
      pythonResolver: "hakutaku-resolver",
      cycleSeverity: "error",
    },
    gates: [{ gate: "redaction", ok: false, detail: "1 secret" }],
  };
  c.run = { ref: "refs/heads/main", built_at: "2026-01-02T00:00:00Z" };
  const otherPath = miniStore(c);
  const other = openStore(otherPath) as Store;
  expect(other.meta).toEqual({
    ...meta,
    repoId: "kepler",
    commit: "0123456789abcdef0123456789abcdef01234567",
    commitTime: 1767312000,
    detail: "deep",
    noSource: true,
    engines: { "ast-grep": "0.39.0", grimp: "3.9" },
    engineLockHash: "1".repeat(64),
    profileHash: "2".repeat(64),
    rulesHash: "3".repeat(64),
    coverage: {
      ...meta.coverage,
      files: 7,
      indexed: { python: 2, typescript: 3 },
      callSites: { bound: 4, scoped: 1, unresolved: 2 },
      tiers: { "ast-grep": "ran", grimp: "fallback" },
      pythonResolver: "hakutaku-resolver",
      cycleSeverity: "error",
    },
    gates: [{ gate: "redaction", ok: false, detail: "1 secret" }],
  });
  expect(other.run).toEqual({
    ref: "refs/heads/main",
    contentHash: hashOf(otherPath),
    builtAt: "2026-01-02T00:00:00Z",
  });
  other.close();
});

it.each<[string, string]>([
  ["no meta row", "DELETE FROM meta"],
  ["a second meta row", "INSERT INTO meta SELECT * FROM meta"],
  ["a schema_version of 0", "UPDATE meta SET schema_version = 0"],
  [
    "a schema_version that is not whole",
    "UPDATE meta SET schema_version = 1.5",
  ],
  ["a meta without a column of schema 1", "ALTER TABLE meta DROP COLUMN gates"],
  ["coverage that is not JSON", "UPDATE meta SET coverage = '{'"],
  [
    "coverage without cycleSeverity",
    "UPDATE meta SET coverage = json_remove(coverage, '$.cycleSeverity')",
  ],
  [
    "a tier that is not one",
    `UPDATE meta SET coverage = json_set(coverage, '$.tiers', json('{"grimp":"slow"}'))`,
  ],
  [
    "tiers out of memory without the cap they had",
    `UPDATE meta SET coverage = json_set(coverage, '$.outOfMemory', json('{"tiers":{"grimp":"reached the cap"}}'))`,
  ],
  [
    "a tier out of memory whose reason is not a string",
    `UPDATE meta SET coverage = json_set(coverage, '$.outOfMemory', json('{"memoryMax":"3G","tiers":{"grimp":1}}'))`,
  ],
  ["a detail that is not one", "UPDATE meta SET detail = 'complete'"],
  ["a no_source other than 0 or 1", "UPDATE meta SET no_source = 2"],
  [
    "an engine version that is not a string",
    `UPDATE meta SET engines = '{"ast-grep":1}'`,
  ],
  [
    "a gate that is not one of the five",
    "UPDATE meta SET gates = json_set(gates, '$[0].gate', 'coverage')",
  ],
  ["gates that are not an array", `UPDATE meta SET gates = '{}'`],
  ["no run row", "DELETE FROM run"],
  ["a second run row", "INSERT INTO run SELECT * FROM run"],
])("answers not an hakutaku store for %s", (_, sql) =>
  expect(openStore(changed(sql))).toEqual({
    code: "not_built",
    reason: "not an hakutaku store",
  }),
);

it("reads back the tiers that ran out of memory, and a store with none as before", () => {
  const outOfMemory = {
    memoryMax: "3G",
    tiers: {
      "scip-typescript":
        "reached the 3G memory cap; rebuild with a larger --memory-max",
    },
  };
  const c = emptyContent();
  c.meta[0].coverage = { ...c.meta[0].coverage, outOfMemory };
  const s = openStore(miniStore(c)) as Store;
  expect(s.meta.coverage.outOfMemory).toEqual(outOfMemory);
  s.close();
  const plain = openStore(miniStore(emptyContent())) as Store;
  expect(plain.meta.coverage.outOfMemory).toBeUndefined();
  plain.close();
});

it("names a newer schema whatever else its meta holds", () => {
  // no run, and a meta of another layout
  const path = sqliteWith(
    "CREATE TABLE meta (schema_version INTEGER, layout TEXT); INSERT INTO meta VALUES (3, 'next')",
  );
  expect(openStore(path)).toEqual({
    code: "not_built",
    reason: "store schema 3 is newer than this hakutaku's schema 1",
  });
});

it("answers store unreadable for a directory, and not built yet for a path through a file", () => {
  expect(openStore(tmp())).toEqual({
    code: "not_built",
    reason: "store unreadable",
  });
  expect(openStore(join(writeTmp("store.sqlite", ""), "store.sqlite"))).toEqual(
    { code: "not_built", reason: "not built yet" },
  );
});

it("closes a store once, however often close is called", () => {
  const s = openStore(miniStore(emptyContent())) as Store;
  s.close();
  expect(() => s.close()).not.toThrow();
  expect(() => s.db.prepare("SELECT 1")).toThrow();
});

// SQLite's open of a FIFO blocks until a writer opens it, so openStore must refuse it unopened.
it.skipIf(process.platform === "win32")(
  "answers store unreadable for a FIFO, without opening it",
  () => {
    const path = join(tmp(), "store.sqlite");
    execFileSync("mkfifo", [path]);
    expect(openStore(path)).toEqual({
      code: "not_built",
      reason: "store unreadable",
    });
  },
);

// Only a build puts a store in place, by a rename: a link there is never followed, whatever it
// names.
it.skipIf(process.platform === "win32")(
  "answers store unreadable for a link, even to a valid store",
  () => {
    const store = miniStore(emptyContent());
    const control = openStore(store) as Store;
    expect(control.meta.repoId).toBe("observatory");
    control.close();
    const link = join(tmp(), "store.sqlite");
    symlinkSync(store, link);
    expect(openStore(link)).toEqual({
      code: "not_built",
      reason: "store unreadable",
    });
  },
);

it.each<[string, string]>([
  [
    "shadowed modules that are not an array",
    `UPDATE meta SET coverage = json_set(coverage, '$.shadowedPython', json('{}'))`,
  ],
  [
    "a shadowed module without the file that holds its name",
    `UPDATE meta SET coverage = json_set(coverage, '$.shadowedPython', json('[{"path":"tools/config/__init__.py","name":"config","by":"root"}]'))`,
  ],
  [
    "a shadowed module shadowed by neither a root nor a package",
    `UPDATE meta SET coverage = json_set(coverage, '$.shadowedPython', json('[{"path":"tools/config/__init__.py","name":"config","heldBy":"sim/src/config.py","by":"stub"}]'))`,
  ],
])("answers not an hakutaku store for %s", (_, sql) =>
  expect(openStore(changed(sql))).toEqual({
    code: "not_built",
    reason: "not an hakutaku store",
  }),
);
