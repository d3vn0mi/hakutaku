// The facts the engine drivers return, before the merge turns them into store rows. Each driver
// that has more names its own type beside its code. Positions are 1-based lines and 1-based
// code-point columns, the store's own; a driver converts an engine's columns with columns.ts.
import type { DefKind, ImportKind } from "../model/index.js";

export interface Pos {
  line: number;
  col: number;
}

// A definition in ast-grep's outline, which mints every definition ID.
export interface OutlineDef {
  file: string;
  qualname: string;
  name: string;
  kind: DefKind;
  start: Pos;
  end: Pos;
  nameAt: Pos[];
  exportedSyntax: boolean;
  signature: string;
}

export interface CallFact {
  file: string;
  at: Pos;
  callee: string;
  receiver: string | null;
}

// An import statement: its specifier's position, and the lines the statement covers, which
// for a TS import spread over several lines begin above its specifier's.
export interface ImportFact {
  file: string;
  at: Pos;
  startLine: number;
  endLine: number;
  specifier: string | null; // null for a computed import
  kind: ImportKind;
  names: string[];
}
