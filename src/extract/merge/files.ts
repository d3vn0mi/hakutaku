// The files table and the components, in two passes. fileRows makes one row per tree entry
// before anything is known of the imports: each file's kind and language as classifyFile
// gives them, its lines, and whether its source is stored. mergeFiles runs once the imports
// and the entry points are merged: it marks test support, which needs both, then groups the
// files into components by their final kinds, since the 40% split counts production files.
// The rows are the same objects throughout, so the entry flags mergeEntries sets survive.
import { posix } from "node:path";
import type { ExportManifest } from "../../export/index.js";
import {
  comparePaths,
  type FileKind,
  type GitMode,
} from "../../model/index.js";
import { redactText } from "../../redact/index.js";
import type { ComponentRow, FileRow } from "../../store/index.js";
import {
  classifyFile,
  computeComponents,
  markTestSupport,
} from "../classify.js";
import { countLinesOf } from "./text.js";
import type { MergeInput } from "./types.js";

// How much of a file git's binary check reads, as classifyFile does: a NUL byte there makes
// the file binary.
const HEAD_BYTES = 8000;

// The kinds on the map, which get definitions, imports and a component.
const ON_MAP: ReadonlySet<FileKind> = new Set(["code", "test", "test-support"]);

export const isOnMap = (kind: FileKind): boolean => ON_MAP.has(kind);

// The kinds whose text the store keeps, when the file is not metadata-only and the build
// keeps sources.
const WITH_SOURCE: ReadonlySet<FileKind> = new Set([
  "code",
  "test",
  "test-support",
  "config",
  "doc",
]);

// The files that make their directory a package root.
const PACKAGE_MANIFESTS: ReadonlySet<string> = new Set([
  "package.json",
  "pyproject.toml",
  "setup.cfg",
]);

export const isRegular = (mode: GitMode): boolean =>
  mode === "100644" || mode === "100755";

// The tree's regular files in path order: the snapshot's own files. A link or a submodule is
// a tree entry with no file in the snapshot.
export function regularPaths(manifest: Pick<ExportManifest, "tree">): string[] {
  return manifest.tree
    .filter((e) => isRegular(e.mode))
    .map((e) => e.path)
    .sort(comparePaths);
}

// A link's target as the store keeps it: redacted, as every stored text is, and never cut.
function storedTarget(target: string): { text: string; count: number } {
  return redactText(target);
}

// redactText's count over the link targets fileRows stores.
export function linkRedactions(
  manifest: Pick<ExportManifest, "tree" | "symlinks">,
): number {
  const targets = new Map(manifest.symlinks.map((s) => [s.path, s.target]));
  let count = 0;
  for (const entry of manifest.tree) {
    const target = targets.get(entry.path);
    if (entry.mode === "120000" && target !== undefined) {
      count += storedTarget(target).count;
    }
  }
  return count;
}

// One row per tree entry, in path order, its id its place. Links and submodules are other,
// with no lines and no source; a link keeps its text, redacted and never followed. A regular
// file is read once: its first 8,000 bytes classify it, and a binary one has no lines. entry is
// 0 and component_id null until the later passes set them.
export function fileRows(input: MergeInput): FileRow[] {
  const { manifest } = input;
  const targets = new Map(manifest.symlinks.map((s) => [s.path, s.target]));
  const metadataOnly = new Set(manifest.metadataOnly.map((m) => m.path));
  return [...manifest.tree]
    .sort((a, b) => comparePaths(a.path, b.path))
    .map((entry, i) => {
      const row: FileRow = {
        id: i + 1,
        path: entry.path,
        lang: null,
        kind: "other",
        component_id: null,
        lines: 0,
        bytes: entry.bytes,
        blob_sha: entry.blob,
        mode: entry.mode,
        link_target: null,
        entry: 0,
        has_source: 0,
      };
      if (entry.mode === "120000") {
        const target = targets.get(entry.path);
        if (target === undefined) {
          throw new Error(
            `the export lists no target for the link ${entry.path}`,
          );
        }
        row.link_target = storedTarget(target).text;
      }
      if (!isRegular(entry.mode)) return row;
      const bytes = input.readSnapshot(entry.path);
      const head = bytes.subarray(0, HEAD_BYTES);
      const { kind, lang } = classifyFile(entry.path, head, input.profile);
      row.kind = kind;
      row.lang = lang;
      row.lines = head.includes(0) ? 0 : countLinesOf(bytes);
      row.has_source =
        WITH_SOURCE.has(kind) &&
        !metadataOnly.has(entry.path) &&
        !input.noSource
          ? 1
          : 0;
      return row;
    });
}

// Test support and the components, once the imports and the entry points are known.
// importersOf maps each imported repo file to the files that import it. An entry point
// (files.entry, so a file only a dev script launches is none) never becomes test support.
// Each component counts its production code files, its test and test-support files, and the
// lines of both. The rows are changed in place and returned.
export function mergeFiles(
  input: MergeInput,
  files: FileRow[],
  importersOf: ReadonlyMap<string, ReadonlySet<string>>,
): {
  files: FileRow[];
  components: ComponentRow[];
  kinds: Map<string, FileKind>;
} {
  const kinds = new Map(files.map((f) => [f.path, f.kind]));
  const entries = new Set(
    files.filter((f) => f.entry === 1).map((f) => f.path),
  );
  markTestSupport(kinds, importersOf, entries);
  for (const f of files) f.kind = kinds.get(f.path) ?? f.kind;

  const packageRoots = new Set<string>();
  for (const f of files) {
    if (!isRegular(f.mode) || !PACKAGE_MANIFESTS.has(posix.basename(f.path))) {
      continue;
    }
    const dir = posix.dirname(f.path);
    if (dir !== ".") packageRoots.add(`${dir}/`);
  }
  const { components, of } = computeComponents(
    files,
    packageRoots,
    input.profile.python.roots,
    input.profile.components,
  );
  const ids = new Map(components.map((c, i) => [c.path, i + 1]));
  const rows: ComponentRow[] = components.map((c, i) => ({
    id: i + 1,
    path: c.path,
    kind: c.kind,
    parent_id: c.parent === null ? null : (ids.get(c.parent) as number),
    files: 0,
    tests: 0,
    lines: 0,
  }));
  for (const f of files) {
    const path = of.get(f.path);
    if (path === undefined) continue;
    const id = ids.get(path) as number;
    const row = rows[id - 1] as ComponentRow;
    f.component_id = id;
    if (f.kind === "code") row.files++;
    else row.tests++;
    row.lines += f.lines;
  }
  return { files, components: rows, kinds };
}
