// The hostile fixtures for tests: fixtures/hostile/make.mjs run into a fresh directory under the
// OS temp directory on every call, removed after the last test of the file that made it, with
// the cases fixtures/hostile/cases.json lists. A case fires when anything appears in canaryDir,
// or when the marker line of markerFile appears where it must not.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { afterAll, expect } from "vitest";
import type { Detail } from "../../src/model/index.js";

const HOSTILE = fileURLToPath(
  new URL("../../fixtures/hostile/", import.meta.url),
);

// The line host/secret.txt holds. It must never reach a snapshot, a store or an answer.
export const MARKER = "HOST-SECRET-MARKER-0f1e";

export type HostileCaseId =
  | "pyright-interpreter"
  | "sgconfig"
  | "git-config"
  | "smudge-filter"
  | "show-signature"
  | "fsmonitor-hooks"
  | "depcruise-config"
  | "python-shadow"
  | "symlink-host"
  | "dotdot-path"
  | "injected-comment"
  | "markup-names"
  | "minified-50mb"
  | "engine-failure-text"
  | "separator-names";

export interface HostileCase {
  id: HostileCaseId;
  stage: string; // "export", "extract", "query" or "viewer"
  vector: string;
  expect: string;
  // How a test shows that the fixture fires: stock git, Python or an engine running the vector
  // on a copy of the case, or, where nothing can run it, a check of the fixture's shape
  control: string;
  detail: Detail;
}

export interface HostileFixtures {
  dir: string;
  canaryDir: string;
  markerFile: string;
  cases: HostileCase[];
}

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

export async function hostileFixtures(): Promise<HostileFixtures> {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-hostile-"));
  made.push(dir);
  execFileSync(process.execPath, [join(HOSTILE, "make.mjs"), dir], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const cases: HostileCase[] = JSON.parse(
    readFileSync(join(HOSTILE, "cases.json"), "utf8"),
  );
  return {
    dir,
    canaryDir: join(dir, "canary"),
    markerFile: join(dir, "host", "secret.txt"),
    cases,
  };
}

// A copy of a case's checkout, its .git included, in a fresh directory under the OS temp
// directory, for a control to run in. Its planted commands still write the fixtures' canary,
// whose path they hold.
export function scratchCopy(fx: HostileFixtures, id: HostileCaseId): string {
  const root = mkdtempSync(join(tmpdir(), "hakutaku-hostile-copy-"));
  made.push(root);
  const copy = join(root, id);
  cpSync(join(fx.dir, id), copy, { recursive: true, verbatimSymlinks: true });
  return copy;
}

// The lines each canary file holds, by file, and the canary emptied again: a control's proof
// that its fixture fires, taken so that the run under test starts from an empty canary.
export function takeCanary(fx: HostileFixtures): Record<string, string[]> {
  const lines: Record<string, string[]> = {};
  for (const name of readdirSync(fx.canaryDir).sort()) {
    const path = join(fx.canaryDir, name);
    lines[name] = readFileSync(path, "utf8").split("\n").filter(Boolean);
    rmSync(path);
  }
  return lines;
}

// The files under dir whose bytes hold needle, by their path from dir. Nothing is followed: a
// link, or anything else that is neither a regular file nor a directory, throws.
export function filesHolding(dir: string, needle: string): string[] {
  const found: string[] = [];
  const walk = (at: string): void => {
    const stats = lstatSync(at);
    if (stats.isDirectory()) {
      for (const name of readdirSync(at).sort()) walk(join(at, name));
    } else if (stats.isFile()) {
      if (readFileSync(at).includes(needle)) found.push(relative(dir, at));
    } else {
      throw new Error(
        `not a regular file or a directory: ${relative(dir, at)}`,
      );
    }
  };
  walk(dir);
  return found;
}

// The columns of a store, as <table>.<column>, in which some row holds needle: every column of
// every table, the text index's own tables included. A blob counts by its bytes, and by what
// it inflates to when it is a zlib stream, as a stored source is.
export function storedTextsHolding(store: string, needle: string): string[] {
  const found = new Set<string>();
  const db = new DatabaseSync(store, { readOnly: true });
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name));
    for (const table of tables) {
      for (const row of db.prepare(`SELECT * FROM "${table}"`).all()) {
        for (const [column, value] of Object.entries(row)) {
          if (holds(value, needle)) found.add(`${table}.${column}`);
        }
      }
    }
  } finally {
    db.close();
  }
  return [...found];
}

function holds(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (!(value instanceof Uint8Array)) return false;
  const bytes = Buffer.from(value);
  if (bytes.includes(needle)) return true;
  try {
    return inflateSync(bytes).includes(needle);
  } catch {
    return false; // not a zlib stream
  }
}

// The two checks every hostile case ends with: nothing wrote the canary, and the marker is in
// no file of the export, its snapshot included, and in no text of the store, when the case
// wrote one.
export function expectContained(
  fx: HostileFixtures,
  where: { exportDir: string; store: string | null },
): void {
  expect(readdirSync(fx.canaryDir)).toEqual([]);
  expect(filesHolding(where.exportDir, MARKER)).toEqual([]);
  if (where.store !== null) {
    expect(storedTextsHolding(where.store, MARKER)).toEqual([]);
  }
}
