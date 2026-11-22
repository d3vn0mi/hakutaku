// The viewer data's constants: the closed sets that its compact arrays index into, the size above
// which outlines and co-change are left out of the map, and the place of each field of a file.
// The browser app reads this file too, so it imports types only.
import type {
  DefKind,
  Ecosystem,
  EntryKind,
  FileKind,
  ImportKind,
} from "../../model/types.js";

export const FILE_KINDS = [
  "code",
  "test",
  "test-support",
  "config",
  "doc",
  "other",
] as const satisfies readonly FileKind[];

export const DEF_KINDS = [
  "function",
  "class",
  "method",
  "constant",
  "type",
] as const satisfies readonly DefKind[];

export const IMPORT_KINDS = [
  "static",
  "dynamic",
  "type-only",
  "re-export",
  "require",
  "side-effect",
  "source",
  "exec",
] as const satisfies readonly ImportKind[];

export const ENTRY_KINDS = [
  "bin",
  "script",
  "dev-script",
  "unit",
  "console-script",
  "container",
  "procfile",
  "ci",
  "plugin",
  "executable",
  "main-guard",
  "route",
] as const satisfies readonly EntryKind[];

export const ECOSYSTEMS = [
  "npm",
  "pypi",
  "node",
  "python",
] as const satisfies readonly Ecosystem[];

// Up to this many production files, the map carries every outline and the co-change pairs.
// Above it, the page asks for them one file at a time.
export const INLINE_OUTLINES_UP_TO = 2000;

// The bits of a file's flags.
export const FLAG_ENTRY = 1; // an entry point of a kind other than dev-script names it
export const FLAG_CORE = 2; // it is in the core set
export const FLAG_SOURCE = 4; // the store holds its text

// The place of each field in a MapFile.
export const F = {
  path: 0,
  kind: 1,
  lang: 2,
  component: 3,
  lines: 4,
  rank: 5,
  pagerank: 6,
  hotspot: 7,
  churn: 8,
  changedDaysAgo: 9,
  cycle: 10,
  flags: 11,
} as const;
