// What a query function knows of a call besides its arguments, and what it returns: a complete
// answer, or an error. Paging happens later, in runTool.
import type { RepoId, Stale } from "../model/index.js";
import type { ToolError } from "../tools/errors.js";

export interface QueryCtx {
  repo: RepoId;
  builtCommit: string; // the store's commit, 12 hex
  stale: Stale;
  snippets: boolean; // source lines on or off for this repo
}

export type QueryOut<A> =
  | { ok: true; answer: A }
  | { ok: false; error: ToolError };

export function ok<A>(answer: A): QueryOut<A> {
  return { ok: true, answer };
}

export function fail(error: ToolError): { ok: false; error: ToolError } {
  return { ok: false, error };
}
