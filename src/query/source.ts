// Source text: a stored file's body, and its lines. The store holds each body redacted and
// deflated, so reading one only inflates it.
import type { StatementSync } from "node:sqlite";
import { inflateSync } from "node:zlib";
import type { Store } from "../store/index.js";
import { cutText, MAX_TEXT_CHARS } from "../tools/limits.js";
import type { QueryCtx } from "./ctx.js";

// How many files' lines sourceLines keeps per store, the most recently read.
const KEPT_FILES = 64;

const BODY_SQL = "SELECT body FROM sources WHERE file_id = ?";
const bodies = new WeakMap<Store, StatementSync>();
const kept = new WeakMap<Store, Map<number, readonly string[] | null>>();

// A file's stored text, or null when the store holds no source for it.
export function readSource(store: Store, fileId: number): string | null {
  let statement = bodies.get(store);
  if (statement === undefined) {
    statement = store.db.prepare(BODY_SQL);
    bodies.set(store, statement);
  }
  const body = statement.get(fileId)?.body;
  return body instanceof Uint8Array ? inflateSync(body).toString("utf8") : null;
}

// A file's lines, split on "\n", as the store counts them: a final "\n" ends the last line and
// starts no other. Null when the store holds no source for the file.
export function sourceLines(
  store: Store,
  fileId: number,
): readonly string[] | null {
  let files = kept.get(store);
  if (files === undefined) {
    files = new Map();
    kept.set(store, files);
  }
  let lines = files.get(fileId);
  if (lines !== undefined) {
    files.delete(fileId); // read again: now the most recent
  } else {
    const text = readSource(store, fileId);
    lines = text === null ? null : Object.freeze(linesOf(text));
  }
  files.set(fileId, lines);
  if (files.size > KEPT_FILES) {
    for (const oldest of files.keys()) {
      files.delete(oldest);
      break;
    }
  }
  return lines;
}

// The text a location carries: its source line, trimmed and cut to MAX_TEXT_CHARS. Undefined
// when snippets are off, the file has no stored source, or the line does not exist.
export function locationText(
  store: Store,
  q: QueryCtx,
  fileId: number,
  line: number,
): string | undefined {
  if (!q.snippets) return undefined;
  const text = sourceLines(store, fileId)?.[line - 1];
  return text === undefined ? undefined : cutText(text.trim(), MAX_TEXT_CHARS);
}

function linesOf(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
