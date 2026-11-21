// The facts of a decoded SCIP index, at the store's positions: the documents it indexed, each
// definition and each use of a symbol, the module that an import specifier names, and the
// symbols defined more than once.
//
// A position is read as TypeScript reads a file, which is how scip-typescript counts lines and
// characters: without a byte order mark at its start, and with a line ending at each LF, CR,
// CRLF, U+2028 and U+2029. The store ends a line at LF only, keeps the mark as the first column
// of line 1, and drops the CR of a CRLF; rawLine gives a store line, so each of TypeScript's
// lines is found inside one of the store's.
import { posix } from "node:path";
import { comparePaths } from "../../model/index.js";
import { utf16ColToCol } from "../columns.js";
import type { Pos } from "../facts.js";
import { comparePos } from "../outline.js";
import { isRepoPath } from "../resolve/ts.js";
import type { ScipDocument, ScipIndex } from "./decode.js";

export interface ScipFacts {
  documents: Set<string>;
  definitions: Array<{ file: string; at: Pos; symbol: string }>;
  uses: Array<{ file: string; at: Pos; symbol: string; roles: number }>;
  // the document that the module symbol at "<file>:<line>:<col>" names
  moduleAt: Map<string, string>;
  duplicates: string[];
}

// SymbolRole.Definition: the symbol is defined here. Any other occurrence is a use.
export const DEFINITION_ROLE = 1;

// The key of a position in moduleAt.
export const positionKey = (file: string, at: Pos): string =>
  `${file}:${at.line}:${at.col}`;

type Definition = ScipFacts["definitions"][number];
type Use = ScipFacts["uses"][number];

// Document.position_encoding. An unspecified encoding is read as UTF-16 code units, which is
// what scip-typescript writes without saying so: TypeScript's positions.
const UNSPECIFIED = 0;
const UTF8 = 1;
const UTF16 = 2;
const UTF32 = 3;

// - documents: the paths of the indexed files, in path order;
// - definitions and uses: each occurrence with a symbol, by its role, sorted by file, position
//   and symbol (a use then by roles), without repeats. A local symbol ("local N") names
//   something inside its own document only;
// - moduleAt: each use of a document's module symbol, the symbol a specifier such as "./body"
//   carries, keyed by its position and naming that document;
// - duplicates: each non-local symbol that two or more documents define as their own.
export function scipFacts(
  index: ScipIndex,
  rawLine: (file: string, line0: number) => string,
): ScipFacts {
  const byFile = new Map<string, ScipDocument[]>();
  for (const doc of index.documents) {
    if (!isRepoPath(doc.relativePath)) {
      throw new Error(
        `SCIP document ${JSON.stringify(doc.relativePath)} is not a repo path`,
      );
    }
    const docs = byFile.get(doc.relativePath);
    if (docs === undefined) byFile.set(doc.relativePath, [doc]);
    else docs.push(doc);
  }
  const files = [...byFile.keys()].sort(comparePaths);

  const definitions: Definition[] = [];
  const uses: Use[] = [];
  for (const file of files) {
    const lines = new TypeScriptLines(file, rawLine);
    const defs: Definition[] = [];
    const used: Use[] = [];
    for (const doc of byFile.get(file) ?? []) {
      const encoding = doc.positionEncoding;
      if (encoding < UNSPECIFIED || encoding > UTF32) {
        throw new Error(
          `SCIP document ${file} uses position encoding ${encoding}, which hakutaku does not read`,
        );
      }
      for (const o of doc.occurrences) {
        const [line, char] = startOf(o.range, file);
        // an occurrence that names no symbol says nothing about one
        if (o.symbol === "") continue;
        const at = lines.pos(line, char, encoding);
        if ((o.roles & DEFINITION_ROLE) !== 0) {
          defs.push({ file, at, symbol: o.symbol });
        } else {
          used.push({ file, at, symbol: o.symbol, roles: o.roles });
        }
      }
    }
    definitions.push(...unique(defs.sort(compareInFile), compareInFile));
    uses.push(...unique(used.sort(compareUsesInFile), compareUsesInFile));
  }

  // The module symbols each document defines as its own, and the documents defining each.
  const modulesOf = new Map<string, string[]>();
  const definedBy = new Map<string, Set<string>>();
  for (const d of definitions) {
    if (!isModuleOf(d.symbol, d.file)) continue;
    add(modulesOf, d.file, d.symbol);
    const by = definedBy.get(d.symbol) ?? new Set<string>();
    by.add(d.file);
    definedBy.set(d.symbol, by);
  }

  const moduleAt = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const u of uses) {
    const by = definedBy.get(u.symbol);
    // a module that two documents define names neither
    if (by === undefined || by.size !== 1) continue;
    const target = by.values().next().value as string;
    const key = positionKey(u.file, u.at);
    const seen = moduleAt.get(key);
    if (seen === undefined && !ambiguous.has(key)) {
      moduleAt.set(key, target);
    } else if (seen !== target) {
      moduleAt.delete(key);
      ambiguous.add(key);
    }
  }

  // A document owns a symbol when the symbol starts with the document's own module symbol: the
  // symbol names that file. So a lib symbol that a repo file augments, a symbol of another
  // file's module, and a local symbol are never owned by the document that defines them.
  const owners = new Map<string, Set<string>>();
  for (const d of definitions) {
    const own = modulesOf.get(d.file) ?? [];
    if (!own.some((m) => d.symbol.startsWith(m))) continue;
    const by = owners.get(d.symbol) ?? new Set<string>();
    by.add(d.file);
    owners.set(d.symbol, by);
  }
  const duplicates = [...owners]
    .filter(([, by]) => by.size >= 2)
    .map(([symbol]) => symbol)
    .sort(comparePaths);

  return {
    documents: new Set(files),
    definitions,
    uses,
    moduleAt,
    duplicates,
  };
}

// The 0-based line and character a range starts at: [line, start, end] or
// [line, start, endLine, end].
function startOf(range: readonly number[], file: string): [number, number] {
  const [line, char] = range;
  if (
    (range.length !== 3 && range.length !== 4) ||
    !range.every((n) => Number.isInteger(n) && n >= 0) ||
    line === undefined ||
    char === undefined
  ) {
    throw new Error(
      `SCIP occurrence in ${file} has the range ${JSON.stringify(range)}, not three or four numbers from 0`,
    );
  }
  return [line, char];
}

const isLocal = (symbol: string): boolean => symbol.startsWith("local ");

// Whether symbol is the module symbol of file: a symbol ending in a namespace, "/", whose last
// name is the file's name. scip-typescript defines one at the start of every file, named after
// the file's path below its package; a TypeScript namespace also ends in "/", under another
// name. The merge gives it to the file's module row rather than to an outline definition.
export function isModuleOf(symbol: string, file: string): boolean {
  return (
    !isLocal(symbol) &&
    symbol.endsWith("/") &&
    lastName(symbol.slice(0, -1)) === posix.basename(file)
  );
}

// The name of a symbol's last descriptor, the symbol cut before that descriptor's suffix: a
// simple name, or an escaped one between backticks, each backtick inside it doubled.
function lastName(s: string): string | null {
  if (!s.endsWith("`")) return /[\w$+-]+$/.exec(s)?.[0] ?? null;
  for (let i = s.length - 2; i >= 0; i--) {
    if (s[i] !== "`") continue;
    if (i > 0 && s[i - 1] === "`") {
      i--;
      continue;
    }
    return s.slice(i + 1, -1).replaceAll("``", "`");
  }
  return null;
}

// Where each of a file's lines, as TypeScript counts them, lies in the store's lines.
class TypeScriptLines {
  // TypeScript's lines in order, each a span [from, to) of a store line, in UTF-16 code units
  private readonly spans: Array<{ line0: number; from: number; to: number }> =
    [];
  private readonly texts: string[] = [];

  constructor(
    private readonly file: string,
    private readonly rawLine: (file: string, line0: number) => string,
  ) {}

  // The store position of a 0-based line and character, counted in the given encoding.
  pos(line: number, char: number, encoding: number): Pos {
    while (this.spans.length <= line) this.readStoreLine();
    const span = this.spans[line] as {
      line0: number;
      from: number;
      to: number;
    };
    const text = this.texts[span.line0] as string;
    const unit = unitAt(text, span.from, span.to, char, encoding);
    if (unit === null) {
      throw new Error(
        `SCIP occurrence in ${this.file} starts at line ${line}, character ${char}, past the end of its line`,
      );
    }
    return { line: span.line0 + 1, col: utf16ColToCol(text, unit) };
  }

  private readStoreLine(): void {
    const line0 = this.texts.length;
    const text = this.rawLine(this.file, line0);
    this.texts.push(text);
    let from = line0 === 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;
    for (let i = from; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 0x0d || c === 0x2028 || c === 0x2029) {
        this.spans.push({ line0, from, to: i });
        from = i + 1;
      }
    }
    this.spans.push({ line0, from, to: text.length });
  }
}

// The UTF-16 index in text of the character `char` of the line text[from, to), counted in
// UTF-16 code units, UTF-8 bytes or code points, or null when it lies past the line's end.
function unitAt(
  text: string,
  from: number,
  to: number,
  char: number,
  encoding: number,
): number | null {
  if (encoding === UNSPECIFIED || encoding === UTF16) {
    return from + char <= to ? from + char : null;
  }
  let unit = from;
  let counted = 0;
  while (counted < char) {
    if (unit >= to) return null;
    const cp = text.codePointAt(unit) as number;
    counted += encoding === UTF8 ? utf8Width(cp) : 1;
    unit += cp > 0xffff ? 2 : 1;
  }
  return unit;
}

const utf8Width = (cp: number): number =>
  cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;

function compareInFile(
  a: { at: Pos; symbol: string },
  b: { at: Pos; symbol: string },
): number {
  return comparePos(a.at, b.at) || comparePaths(a.symbol, b.symbol);
}

const compareUsesInFile = (a: Use, b: Use): number =>
  compareInFile(a, b) || a.roles - b.roles;

// A sorted list without the items equal to the one before.
function unique<T>(sorted: T[], compare: (a: T, b: T) => number): T[] {
  return sorted.filter(
    (item, i) => i === 0 || compare(sorted[i - 1] as T, item) !== 0,
  );
}

function add(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}
