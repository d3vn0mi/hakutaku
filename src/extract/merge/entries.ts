// The entry_points table: each launch-manifest fact readEntryPoints finds becomes a row,
// naming its file, its manifest and the manifest's line. A console script's def_id is the
// definition its qualname names in the entry's file, the first of that qualname (its ID
// carries no ordinal), when one exists. A name is redacted, then cut to 240 characters; two
// rows the cut makes alike in the table's key keep the first. files.entry is set to 1 for
// each file a row of any kind but dev-script names.
import {
  type ManifestInput,
  pythonModuleIndex,
  readEntryPoints,
} from "../../manifests/index.js";
import { comparePaths } from "../../model/index.js";
import type { EntryPointRow, FileRow } from "../../store/index.js";
import type { MergedDefinitions } from "./definitions.js";
import { isRegular, regularPaths } from "./files.js";
import { decodeText, redactLine } from "./text.js";
import type { MergeInput } from "./types.js";

export function mergeEntries(
  input: MergeInput,
  files: readonly FileRow[],
  defs: MergedDefinitions,
): { entryPoints: EntryPointRow[]; redactions: number } {
  const { manifest, profile } = input;
  const byPath = new Map(files.map((f) => [f.path, f]));
  const paths = regularPaths(manifest);
  const tracked = new Set(paths);
  const metadataOnly = new Set(manifest.metadataOnly.map((m) => m.path));
  const texts = new Map<string, string>();
  const manifestInput: ManifestInput = {
    paths: tracked,
    modes: new Map(
      manifest.tree
        .filter((e) => isRegular(e.mode))
        .map((e) => [e.path, e.mode]),
    ),
    read: (path) => {
      if (!tracked.has(path) || metadataOnly.has(path)) return null;
      let text = texts.get(path);
      if (text === undefined) {
        text = decodeText(input.readSnapshot(path));
        texts.set(path, text);
      }
      return text;
    },
    profile,
    // test support is not marked yet; a test file is never an entry point
    isTest: (path) => byPath.get(path)?.kind === "test",
    pythonModules: pythonModuleIndex(
      paths,
      profile.python.roots,
      profile.python.singleFileModules,
    ),
  };

  const idOf = (path: string): number => {
    const file = byPath.get(path);
    if (file === undefined) {
      throw new Error(
        `an entry point names ${path}, which the tree does not hold`,
      );
    }
    return file.id;
  };
  const rows = readEntryPoints(manifestInput).map((fact) => {
    const name = redactLine(fact.name);
    const def =
      fact.qualname === null
        ? undefined
        : defs.byFile
            .get(fact.file)
            ?.find((d) => d.qualname === fact.qualname && d.ordinal === 1);
    const row: EntryPointRow = {
      file_id: idOf(fact.file),
      def_id: def?.id ?? null,
      kind: fact.kind,
      manifest_file_id: idOf(fact.manifest),
      manifest_line: fact.line,
      name: name.text,
    };
    return { row, redactions: name.count };
  });
  rows.sort((a, b) => compareKeys(a.row, b.row) || compareDefs(a.row, b.row));

  const entryPoints: EntryPointRow[] = [];
  let redactions = 0;
  for (const { row, redactions: count } of rows) {
    const last = entryPoints.at(-1);
    if (last !== undefined && compareKeys(last, row) === 0) continue;
    entryPoints.push(row);
    redactions += count;
  }
  for (const row of entryPoints) {
    if (row.kind === "dev-script") continue;
    (files[row.file_id - 1] as FileRow).entry = 1;
  }
  return { entryPoints, redactions };
}

// The table's key, in its order: file, kind, manifest, line, name.
const compareKeys = (a: EntryPointRow, b: EntryPointRow): number =>
  a.file_id - b.file_id ||
  comparePaths(a.kind, b.kind) ||
  a.manifest_file_id - b.manifest_file_id ||
  a.manifest_line - b.manifest_line ||
  comparePaths(a.name, b.name);

// No definition first, as SQLite orders NULL.
const compareDefs = (a: EntryPointRow, b: EntryPointRow): number =>
  a.def_id === b.def_id
    ? 0
    : a.def_id === null
      ? -1
      : b.def_id === null
        ? 1
        : a.def_id - b.def_id;
