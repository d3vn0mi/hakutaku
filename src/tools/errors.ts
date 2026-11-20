// The errors a tool answers with. A failed call is written everywhere as { "error": ToolError },
// with the fields in the order ToolError declares them.
import type { DefKind, Id, RepoId } from "../model/index.js";
import { cutText, ECHO_CHARS } from "./limits.js";

export type ErrorCode =
  | "unknown_repo"
  | "not_built"
  | "not_found"
  | "ambiguous"
  | "invalid_argument"
  | "denied_file"
  | "no_source"
  | "rate_limited"
  | "refresh_disabled"
  | "internal";

// A near miss, a rename or one of several matches, offered so that the caller can pass its id.
export interface Candidate {
  id: Id;
  kind: DefKind | "file" | "test-file";
  line?: number;
}

// Each optional field appears only with the codes named beside it.
export interface ToolError {
  code: ErrorCode;
  message: string;
  known?: RepoId[]; // unknown_repo: the repo ids this caller may ask about
  reason?: string; // not_built
  field?: string; // invalid_argument: the argument at fault
  candidates?: Candidate[]; // not_found (near misses, then renames), ambiguous
  retryAfterSeconds?: number; // rate_limited
  hint?: string; // invalid_argument; optional on ambiguous and not_found
}

export type ToolResult =
  | { ok: true; answer: object }
  | { ok: false; error: ToolError };

// Every code, in the order the documentation lists them.
export const ERROR_CODES: readonly ErrorCode[] = Object.freeze([
  "unknown_repo",
  "not_built",
  "not_found",
  "ambiguous",
  "invalid_argument",
  "denied_file",
  "no_source",
  "rate_limited",
  "refresh_disabled",
  "internal",
]);

const CODES: ReadonlySet<string> = new Set(ERROR_CODES);

// A fresh ToolError whose keys follow ToolError's declared order, whatever the order of extra;
// a field that is undefined is left out.
export function toolError(
  code: ErrorCode,
  message: string,
  extra?: Omit<Partial<ToolError>, "code" | "message">,
): ToolError {
  const error: ToolError = { code, message };
  if (extra?.known !== undefined) error.known = extra.known;
  if (extra?.reason !== undefined) error.reason = extra.reason;
  if (extra?.field !== undefined) error.field = extra.field;
  if (extra?.candidates !== undefined) error.candidates = extra.candidates;
  if (extra?.retryAfterSeconds !== undefined) {
    error.retryAfterSeconds = extra.retryAfterSeconds;
  }
  if (extra?.hint !== undefined) error.hint = extra.hint;
  return error;
}

// A model's input as an error message quotes it: at most ECHO_CHARS characters.
export function echo(input: string): string {
  return cutText(input, ECHO_CHARS);
}

// An object with a string code that is one of ERROR_CODES, and a string message.
export function isToolError(x: unknown): x is ToolError {
  return (
    typeof x === "object" &&
    x !== null &&
    "code" in x &&
    typeof x.code === "string" &&
    CODES.has(x.code) &&
    "message" in x &&
    typeof x.message === "string"
  );
}
