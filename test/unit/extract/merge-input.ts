// The MergeInput the merge tests share. Every file given is a tracked regular file read from
// memory, with mode 100644 unless `modes` names another; links and submodules are tree
// entries with no snapshot file, so reading one throws. No engine ran unless a test gives its
// facts. Secret-looking values are assembled at run time, never written whole.
import { createHash } from "node:crypto";
import type { ExportManifest } from "../../../src/export/index.js";
import type { AstGrepFacts } from "../../../src/extract/drivers/ast-grep.js";
import type {
  CallFact,
  ImportFact,
  OutlineDef,
  Pos,
} from "../../../src/extract/facts.js";
import { mergeDefinitions } from "../../../src/extract/merge/definitions.js";
import { mergeEntries } from "../../../src/extract/merge/entries.js";
import { fileRows, mergeFiles } from "../../../src/extract/merge/files.js";
import { mergeImports } from "../../../src/extract/merge/imports.js";
import type { MergeInput } from "../../../src/extract/merge/types.js";
import type { ScipFacts } from "../../../src/extract/scip/facts.js";
import {
  comparePaths,
  type DefKind,
  type GitMode,
  type ImportKind,
} from "../../../src/model/index.js";
import { DEFAULT_PROFILE, type Profile } from "../../../src/profile/index.js";

const encoder = new TextEncoder();

export const COMMIT = "fedcba9876543210fedcba9876543210fedcba98";

// The sample's Python layout: one import root, sim/src.
export const SIM: Partial<Profile> = {
  python: { roots: ["sim/src"], singleFileModules: [] },
};

// A blob id of its own for each path, so a row's blob_sha shows which entry it came from.
export const blobOf = (path: string): string =>
  createHash("sha1").update(path).digest("hex");

export const P = (line: number, col: number): Pos => ({ line, col });

// A file's text: each line ended by a line feed.
export const lines = (...text: string[]): string => `${text.join("\n")}\n`;

// The mark redaction leaves for a rule: its name between guillemets.
export const mark = (rule: string): string =>
  `${String.fromCodePoint(0xab)}redacted:${rule}${String.fromCodePoint(0xbb)}`;

// A SCIP symbol of the sample's package, as scip-typescript names one: the file's directory,
// its name between backticks, then the descriptor ("" for the file's module).
export function symbolOf(file: string, descriptor: string): string {
  const slash = file.lastIndexOf("/");
  return `scip-typescript npm observatory 0.1.0 ${file.slice(0, slash + 1)}\`${file.slice(slash + 1)}\`/${descriptor}`;
}

export const scip = (facts: Partial<ScipFacts>): ScipFacts => ({
  documents: new Set(),
  definitions: [],
  uses: [],
  moduleAt: new Map(),
  duplicates: [],
  ...facts,
});

// Where `needle` starts on line `line` of `text`: 1-based, in code points.
export function spot(text: string, line: number, needle: string): Pos {
  const found = text.split("\n")[line - 1];
  if (found === undefined) throw new Error(`no line ${line}`);
  const i = found.indexOf(needle);
  if (i < 0) throw new Error(`no ${needle} on line ${line}`);
  return { line, col: [...found.slice(0, i)].length + 1 };
}

// An import statement's fact, its specifier at `at`, on one line unless `lines` gives the
// statement's first and last.
export const importFact = (
  file: string,
  at: Pos,
  specifier: string,
  kind: ImportKind = "static",
  names: string[] = [],
  [startLine, endLine]: [number, number] = [at.line, at.line],
): ImportFact => ({ file, at, startLine, endLine, specifier, kind, names });

// A call site's fact, its callee's name at `at`.
export const callFact = (
  file: string,
  at: Pos,
  callee: string,
  receiver: string | null = null,
): CallFact => ({ file, at, callee, receiver });

// An outline definition; its name is the last segment of its qualname.
export const outlineDef = (
  file: string,
  qualname: string,
  kind: DefKind,
  start: Pos,
  end: Pos,
  nameAt: Pos[],
  signature: string,
  exportedSyntax = false,
): OutlineDef => ({
  file,
  qualname,
  name: qualname.slice(qualname.lastIndexOf(".") + 1),
  kind,
  start,
  end,
  nameAt,
  exportedSyntax,
  signature,
});

export const astGrep = (facts: Partial<AstGrepFacts>): AstGrepFacts => ({
  defs: [],
  calls: [],
  imports: [],
  computed: [],
  ...facts,
});

export interface TreeOptions {
  modes?: Record<string, GitMode>;
  links?: Record<string, string>; // path to the link's text
  submodules?: Record<string, string>; // path to the commit
  metadataOnly?: Record<string, "size" | "minified" | "generated">;
  profile?: Partial<Profile>;
  noSource?: boolean;
  facts?: Partial<
    Pick<
      MergeInput,
      "astGrep" | "depcruise" | "scip" | "grimp" | "pythonResolver" | "detail"
    >
  >;
}

export function mergeInput(
  files: Record<string, string | Uint8Array>,
  options: TreeOptions = {},
): MergeInput {
  const bytes = new Map(
    Object.entries(files).map(([path, content]) => [
      path,
      typeof content === "string" ? encoder.encode(content) : content,
    ]),
  );
  const links = Object.entries(options.links ?? {});
  const submodules = Object.entries(options.submodules ?? {});
  const tree: ExportManifest["tree"] = [
    ...[...bytes].map(([path, content]) => ({
      path,
      mode: options.modes?.[path] ?? ("100644" as const),
      blob: blobOf(path),
      bytes: content.length,
    })),
    ...links.map(([path, target]) => ({
      path,
      mode: "120000" as const,
      blob: blobOf(path),
      bytes: encoder.encode(target).length,
    })),
    ...submodules.map(([path, commit]) => ({
      path,
      mode: "160000" as const,
      blob: commit,
      bytes: 0,
    })),
  ].sort((a, b) => comparePaths(a.path, b.path));
  const manifest: ExportManifest = {
    formatVersion: 1,
    id: "observatory",
    commit: COMMIT,
    commitTime: 1767225600,
    ref: "main",
    hakutakuVersion: "0.0.0",
    files: tree.length,
    denied: 0,
    engineConfigsRemoved: [],
    symlinks: links.map(([path, target]) => ({ path, target })),
    submodules: submodules.map(([path, commit]) => ({ path, commit })),
    refused: [],
    metadataOnly: Object.entries(options.metadataOnly ?? {})
      .map(([path, reason]) => ({ path, reason }))
      .sort((a, b) => comparePaths(a.path, b.path)),
    tree,
  };
  return {
    manifest,
    profile: { ...DEFAULT_PROFILE, ...options.profile },
    rules: null,
    detail: "standard",
    noSource: options.noSource ?? false,
    readSnapshot: (path) => {
      const content = bytes.get(path);
      if (content === undefined) throw new Error(`no snapshot file ${path}`);
      return content;
    },
    astGrep: null,
    depcruise: null,
    scip: null,
    grimp: null,
    pythonResolver: "none",
    ...options.facts,
  };
}

// The first part of the merge, in the order an extract runs it: the tree's rows, the
// definitions, the imports, the entry points, then test support and the components.
export function mergeInOrder(input: MergeInput) {
  const files = fileRows(input);
  const defs = mergeDefinitions(input, files);
  const imports = mergeImports(input, files, defs);
  const entries = mergeEntries(input, files, defs);
  const done = mergeFiles(input, files, imports.importersOf);
  return { ...done, defs, imports, entries };
}
