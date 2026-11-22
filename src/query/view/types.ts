// The viewer's data: what its map, outline, source and history endpoints answer. The browser app
// reads these types too, so this file imports types only.
//
// An index counts places in one of MapData's arrays: files, components, langs, externals or
// defs. files holds every tracked file in store order, so a file's index is its store id minus
// 1, and so do components and externals; a definition's index is its place in defs, which leaves
// module scope out. -1 means none.
import type { DefKind, Detail, Id, RepoId, Stale } from "../../model/types.js";

// One file, by the places in F. kind indexes FILE_KINDS, lang indexes langs, and component
// indexes components.
// - rank is the dependents rank (1 is the most depended-on production file) and pagerank has
//   four significant digits; both, and hotspot, are 0 off production.
// - churn counts the commits of the last 90 days that touched the file.
// - changedDaysAgo is the number of whole days from the file's last change to the built
//   commit, or -1 when no commit in the history touched it.
// - cycle is the number of the import cycle the file is in, 0 for none, so its chain is
//   cycles[cycle - 1].
// - flags holds FLAG_ENTRY, FLAG_CORE and FLAG_SOURCE.
export type MapFile = [
  path: string,
  kind: number,
  lang: number,
  component: number,
  lines: number,
  rank: number,
  pagerank: number,
  hotspot: number,
  churn: number,
  changedDaysAgo: number,
  cycle: number,
  flags: number,
];

export interface MapData {
  format: 1;
  repo: RepoId;
  builtCommit: string; // the first 12 hex characters of the built commit
  stale: Stale;
  detail: Detail;
  sources: boolean; // whether the page may ask for source: the store holds it and snippets are on
  counts: {
    productionFiles: number; // files of kind code
    tests: number; // test and test-support files
    components: number;
    entryPoints: number; // files an entry point of a kind other than dev-script names
    cycles: number;
    importEdges: number; // imports of one repo file by another
    libraries: number;
    definitions: number; // module scope left out
  };
  coreSet: { files: number; ofFiles: number }; // the core set's files, of the production files
  langs: string[]; // in path order
  // path without its final "/" ("." for the root component), production files, test and
  // test-support files, lines
  components: Array<
    [path: string, files: number, tests: number, lines: number]
  >;
  files: MapFile[];
  imports: number[]; // [src, dst, kind] per file-to-file import, in store order
  externals: Array<[ecosystem: number, name: string, files: number]>;
  libImports: number[]; // [src file, external] per file-to-library import, in store order
  cycles: number[][]; // each cycle's files, in chain order
  // the entry point's file, its kind, the manifest file that names it, that manifest's line,
  // its name, and its definition
  entries: Array<
    [
      file: number,
      kind: number,
      manifest: number,
      line: number,
      name: string,
      def: number,
    ]
  >;
  // Every definition but module scope, in store order, as parallel arrays: file index,
  // qualified name, ordinal, start line, DEF_KINDS index, 1 when exported, and the number of
  // files that use it.
  defs: {
    file: number[];
    name: string[];
    ordinal: number[];
    line: number[];
    kind: number[];
    exported: number[];
    usedBy: number[];
  };
  // Parallel to defs: end line, and 1 when tests mention the definition. Null above the inline
  // limit, where outlines are fetched one file at a time.
  outline: { endLine: number[]; tested: number[] } | null;
  // [file, partner, commits] per co-change row, in store order. Null above the inline limit.
  cochange: number[] | null;
}

// One file's definitions, module scope left out, and the files that change together with it.
export interface OutlineData {
  builtCommit: string;
  file: Id;
  defs: Array<{
    id: Id;
    qualname: string;
    ordinal: number;
    kind: DefKind;
    line: number;
    endLine: number;
    exported: boolean;
    usedByFiles: number;
    mentionedByTests: boolean;
  }>;
  cochange: Array<{ id: Id; commits: number }>;
}

// One file's stored text, redacted, with its definitions and the call sites in it.
export interface SourceData {
  builtCommit: string;
  file: Id;
  lines: number;
  text: string;
  redactions: number; // the redaction marks in the text
  defs: Array<{ id: Id; kind: DefKind; line: number; endLine: number }>;
  sites: Array<{
    line: number;
    col: number;
    target: Id;
    label: "bound" | "scoped";
    collision: boolean;
  }>;
}

// The commits of each of the 26 weeks before the built commit, oldest first.
export interface HistoryData {
  builtCommit: string;
  weeks: Array<{ start: number; commits: number }>;
}
