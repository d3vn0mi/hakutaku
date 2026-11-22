// Looking things up in a store for the viewer: each store's prepared statements, kept for as long
// as its Store object is, a file's row by its id, and a file's id by its exact path.
import type { SQLInputValue, StatementSync } from "node:sqlite";
import type { Store } from "../../store/index.js";

const prepared = new WeakMap<Store, Map<string, StatementSync>>();

function statement(store: Store, sql: string): StatementSync {
  let statements = prepared.get(store);
  if (statements === undefined) {
    statements = new Map();
    prepared.set(store, statements);
  }
  let found = statements.get(sql);
  if (found === undefined) {
    found = store.db.prepare(sql);
    statements.set(sql, found);
  }
  return found;
}

// Every row a SELECT answers, typed as the store's writer guarantees its columns.
export const rows = <R>(
  store: Store,
  sql: string,
  ...params: SQLInputValue[]
): R[] => statement(store, sql).all(...params) as unknown as R[];

const row = <R>(
  store: Store,
  sql: string,
  ...params: SQLInputValue[]
): R | undefined =>
  statement(store, sql).get(...params) as unknown as R | undefined;

export const builtCommitOf = (store: Store): string =>
  store.meta.commit.slice(0, 12);

export interface FileFacts {
  path: string;
  lines: number;
  has_source: number;
}

// A file's path, lines and whether its text is stored. A RangeError for an id the store does
// not hold: callers look the file up first.
export function fileFacts(store: Store, fileId: number): FileFacts {
  const facts = row<FileFacts>(
    store,
    "SELECT path, lines, has_source FROM files WHERE id = ?",
    fileId,
  );
  if (facts === undefined) {
    throw new RangeError(`the store holds no file with id ${fileId}`);
  }
  return facts;
}

// The id of the file at exactly this path, or null. SQLite compares UTF-8, where a lone
// surrogate becomes U+FFFD, so the path it finds is compared again as JavaScript text.
export function fileIdOf(store: Store, path: string): number | null {
  const found = row<{ id: number; path: string }>(
    store,
    "SELECT id, path FROM files WHERE path = ?",
    path,
  );
  return found !== undefined && found.path === path ? found.id : null;
}
