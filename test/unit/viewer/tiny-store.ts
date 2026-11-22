// The viewer's tiny store: a five-file TypeScript repo named tiny, built by hand. Its rows are
// the facts the viewer's tests read. Each text in TINY_SOURCES gives its file's line count, and
// a line that a row names holds what the row says: an import, a call, a reference, an entry
// point or a redaction. The texts are not an extraction of themselves, so a construct a row does
// not name has no row. Ids follow path order, as writeStore checks.
import type { DefKind, FileKind } from "../../../src/model/index.js";
import type { StoreContent } from "../../../src/store/index.js";
import { emptyContent, miniStore } from "../../helpers/mini-store.js";

export const TINY_TIME = 1_780_000_000;

const TINY_COMMIT = `4f2a9c1e07b3${"0".repeat(28)}`;
const DAY = 86_400;
const WEEK = 604_800;

// A text of these lines: each ends with "\n", so the store counts exactly these.
const text = (...lines: string[]): string => `${lines.join("\n")}\n`;

export const TINY_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  "package.json": text(
    "{",
    '  "name": "tiny",',
    '  "type": "module",',
    '  "bin": { "tiny": "src/cli/main.ts" },',
    '  "dependencies": { "kleur": "^4.1.5" },',
    '  "scripts": {',
    '    "test": "vitest run"',
    "  }",
    "}",
  ),
  "src/cli/main.ts": text(
    'import { Graph } from "../core/graph";',
    'import kleur from "kleur";',
    "export function main(names: string[]): number {",
    "  const { add } = new Graph();",
    '  add(names[0] ?? "tiny");',
    "",
    "  if (names.length <= 1) return 0;",
    '  console.error(kleur.yellow("one name at a time"));',
    "  return 1;",
    "}",
    "",
    "process.exitCode = main(process.argv.slice(2));",
  ),
  "src/core/graph.test.ts": text(
    'import { Graph } from "./graph";',
    "",
    "const { add, weights } = new Graph();",
    'add("a", 2);',
    "",
    'describe("Graph", () => {',
    '  it("keeps a weight between 0 and 1", () => {',
    '    expect(weights.get("a")).toBe(1);',
    "  });",
    "",
    '  it("holds only the names it was given", () => {',
    '    expect([...weights.keys()]).toEqual(["a"]);',
    "  });",
    "",
    '  it("gives an unknown name no weight", () => {',
    '    expect(weights.has("b")).toBe(false);',
    "  });",
    "});",
    "",
    "// describe, it and expect are vitest's globals.",
  ),
  "src/core/graph.ts": text(
    'import { readFileSync } from "node:fs";',
    'import { clamp } from "./util";',
    "",
    "// A weighted set of names: each name is added once, with a weight from 0 to 1.",
    "export class Graph {",
    "  readonly weights = new Map<string, number>();",
    "  size = 0;",
    "",
    "  add = (name: string, weight = 1): void => {",
    "    if (!this.weights.has(name)) this.size += 1;",
    "    this.weights.set(name, clamp(weight, 0, 1));",
    "  }; // old key: «redacted:generic-api-key»",
    "",
    "  // add is an arrow function, so it keeps its graph when it is",
    "  // destructured, as in const { add } = graph.",
    "  //",
    "  // A weight outside 0 to 1 moves to the nearest end of that range.",
    "  // A name added twice keeps its first place and takes its newest",
    "  // weight, so size counts each name once.",
    "  //",
    "  // A file of names holds one name per line:",
    "  //",
    "  //   alpha",
    "  //   beta",
    "  //",
    '  // Blank lines, and lines that start with "#", are skipped: see the',
    "  // second helper below.",
    "}",
    "",
    "function helper({ add }: Graph, names: string[]): void {",
    "  for (const name of names)",
    "    add(name);",
    "}",
    "",
    "function helper(path: string): string[] {",
    '  const lines = readFileSync(path, "utf8").split("\\n");',
    '  return lines.filter((line) => line !== "" && !line.startsWith("#"));',
    "}",
    "",
    "// Two definitions share the name helper; their IDs tell them apart: helper and helper(2).",
  ),
  "src/core/util.ts": text(
    'import * as graph from "./graph";',
    "export function clamp(value: number, low: number, high: number): number {",
    "  return Math.min(high, Math.max(low, value));",
    "}",
    "",
    "// graph.ts imports clamp from this file, and this file imports",
    "// graph.ts back, so the two files form an import cycle.",
    "//",
    "// Examples:",
    "//",
    "//   clamp(5, 0, 1) is 1",
    "//   clamp(-1, 0, 1) is 0",
    "//   clamp(0.5, 0, 1) is 0.5",
    "//",
    "// The graph namespace is imported only to close that cycle.",
  ),
});

// path, kind, component, entry; ids 1.. in this (path) order. Every file but package.json is
// TypeScript, and every file's lines and bytes come from its text.
const FILES: readonly (readonly [string, FileKind, number | null, 0 | 1])[] = [
  ["package.json", "config", null, 0],
  ["src/cli/main.ts", "code", 1, 1],
  ["src/core/graph.test.ts", "test", 2, 0],
  ["src/core/graph.ts", "code", 2, 0],
  ["src/core/util.ts", "code", 2, 0],
];

// file, qualname, ordinal, kind, start line and column, end line and column (exclusive),
// exported, parent, then def_metrics: used by files, of those bound, mentioned by tests. A
// module row's range is its whole file, filled in from the text.
const DEFINITIONS: readonly (readonly [
  number,
  string,
  number,
  DefKind | "module",
  number,
  number,
  number,
  number,
  0 | 1,
  number | null,
  number,
  number,
  number,
])[] = [
  [2, "<module>", 1, "module", 1, 1, 0, 0, 0, null, 0, 0, 0],
  [2, "main", 1, "function", 3, 1, 10, 2, 1, null, 0, 0, 0],
  [3, "<module>", 1, "module", 1, 1, 0, 0, 0, null, 0, 0, 0],
  [4, "<module>", 1, "module", 1, 1, 0, 0, 0, null, 0, 0, 0],
  [4, "Graph", 1, "class", 5, 1, 28, 2, 1, null, 1, 1, 1],
  [4, "Graph.add", 1, "method", 9, 3, 12, 5, 1, 5, 1, 1, 1],
  [4, "helper", 1, "function", 30, 1, 33, 2, 0, null, 0, 0, 0],
  [4, "helper", 2, "function", 35, 1, 38, 2, 0, null, 0, 0, 0],
  [5, "<module>", 1, "module", 1, 1, 0, 0, 0, null, 0, 0, 0],
  [5, "clamp", 1, "function", 2, 1, 4, 2, 1, null, 0, 0, 0],
];

// source file, imported file, imported external, line, specifier; every import is static
const IMPORTS: readonly (readonly [
  number,
  number | null,
  number | null,
  number,
  string,
])[] = [
  [2, 4, null, 1, "../core/graph"],
  [2, null, 2, 2, "kleur"],
  [3, 4, null, 1, "./graph"],
  [4, null, 1, 1, "node:fs"],
  [4, 5, null, 2, "./util"],
  [5, 4, null, 1, "./graph"],
];

// file, line, column, enclosing definition, then the call's one target: definition, label
const CALLS: readonly (readonly [
  number,
  number,
  number,
  number,
  number,
  "bound" | "scoped",
])[] = [
  [2, 5, 3, 2, 6, "bound"],
  [3, 4, 1, 3, 6, "scoped"],
  [4, 32, 5, 7, 6, "bound"],
];

// file, pagerank, dependents rank, fan in, fan out, churn, hotspot, cycle, core, days since
// the last change
const FILE_METRICS: readonly (readonly [
  number,
  number | null,
  number | null,
  number,
  number,
  number,
  number | null,
  number | null,
  0 | 1,
  number,
])[] = [
  [2, 0.2, 3, 0, 1, 1, 0.1, null, 1, 10],
  [3, null, null, 0, 1, 2, null, null, 0, 3],
  [4, 0.5, 1, 3, 1, 4, 1.0, 1, 1, 1],
  [5, 0.3, 2, 1, 1, 0, 0.0, 1, 0, 120],
];

const textOf = (path: string): string => {
  const source = TINY_SOURCES[path];
  if (source === undefined)
    throw new Error(`the tiny store: no text for ${path}`);
  return source;
};

// A text's lines as the store counts them: a final "\n" ends the last line and starts no other.
const linesOf = (source: string): string[] => source.slice(0, -1).split("\n");

export function tinyContent(
  opts: { commit?: string; noSource?: boolean } = {},
): StoreContent {
  const base = emptyContent("tiny");
  const [meta] = base.meta;
  if (meta === undefined) throw new Error("emptyContent has no meta row");
  const withSource = opts.noSource !== true;
  const paths = FILES.map(([path]) => path);
  const lines = paths.map((path) => linesOf(textOf(path)));
  return {
    ...base,
    meta: [
      {
        ...meta,
        commit_sha: opts.commit ?? TINY_COMMIT,
        commit_time: TINY_TIME,
        detail: "standard",
        no_source: withSource ? 0 : 1,
        engines: {
          "ast-grep": "0.0.0",
          "dependency-cruiser": "0.0.0",
          "scip-typescript": "0.0.0",
        },
        coverage: {
          ...meta.coverage,
          files: FILES.length,
          indexed: { typescript: 4 },
          callSites: { bound: 2, scoped: 1, unresolved: 0 },
          redactions: 1,
          tiers: {
            "ast-grep": "ran",
            "dependency-cruiser": "ran",
            "scip-typescript": "ran",
          },
        },
      },
    ],
    components: [
      {
        id: 1,
        path: "src/cli/",
        kind: "folder",
        parent_id: null,
        files: 1,
        tests: 0,
        lines: 12,
      },
      {
        id: 2,
        path: "src/core/",
        kind: "folder",
        parent_id: null,
        files: 2,
        tests: 1,
        lines: 75,
      },
    ],
    files: FILES.map(([path, kind, component, entry], i) => ({
      id: i + 1,
      path,
      lang: kind === "config" ? null : "typescript",
      kind,
      component_id: component,
      lines: lines[i]?.length ?? 0,
      bytes: new TextEncoder().encode(textOf(path)).length,
      blob_sha: "c".repeat(40),
      mode: "100644",
      link_target: null,
      entry,
      has_source: withSource ? 1 : 0,
    })),
    sources: withSource
      ? paths.map((path, i) => ({ file_id: i + 1, text: textOf(path) }))
      : [],
    definitions: DEFINITIONS.map(
      (
        [
          file,
          qualname,
          ordinal,
          kind,
          line,
          col,
          end,
          endCol,
          exported,
          parent,
        ],
        i,
      ) => {
        // a module row ends after the last character of its file
        const own = lines[file - 1] ?? [];
        const whole = kind === "module";
        return {
          id: i + 1,
          file_id: file,
          qualname,
          ordinal,
          name: qualname.slice(qualname.lastIndexOf(".") + 1),
          kind,
          start_line: line,
          start_col: col,
          end_line: whole ? own.length : end,
          end_col: whole ? (own.at(-1)?.length ?? 0) + 1 : endCol,
          exported,
          parent_id: parent,
          scip_symbol: null,
          signature: null,
          producer: "ast-grep",
        };
      },
    ),
    externals: [
      { id: 1, ecosystem: "node", name: "fs", files: 1 },
      { id: 2, ecosystem: "npm", name: "kleur", files: 1 },
    ],
    imports: IMPORTS.map(([src, dstFile, dstExternal, line, specifier], i) => ({
      id: i + 1,
      src_file_id: src,
      dst_file_id: dstFile,
      dst_external_id: dstExternal,
      kind: "static",
      line,
      specifier,
      resolved: 1,
      producer: "dependency-cruiser",
    })),
    call_sites: CALLS.map(([file, line, col, enclosing], i) => ({
      id: i + 1,
      file_id: file,
      line,
      col,
      enclosing_def_id: enclosing,
      callee_name: "add",
      receiver_text: null,
      producer: "ast-grep",
    })),
    call_targets: CALLS.map(([, , , , def, label], i) => ({
      site_id: i + 1,
      def_id: def,
      label,
      collision: 0,
    })),
    refs: [
      {
        id: 1,
        file_id: 2,
        line: 1,
        col: 10,
        enclosing_def_id: 1,
        def_id: 5,
        role: "import",
        producer: "scip-typescript",
      },
    ],
    entry_points: [
      {
        file_id: 2,
        def_id: null,
        kind: "bin",
        manifest_file_id: 1,
        manifest_line: 4,
        name: "tiny",
      },
    ],
    file_metrics: FILE_METRICS.map(
      ([
        file,
        pagerank,
        rank,
        fanIn,
        fanOut,
        churn,
        hotspot,
        cycle,
        core,
        days,
      ]) => ({
        file_id: file,
        pagerank,
        dependents_rank: rank,
        fan_in: fanIn,
        fan_out: fanOut,
        churn_90d: churn,
        hotspot,
        cycle_id: cycle,
        core,
        last_change: TINY_TIME - days * DAY,
      }),
    ),
    def_metrics: DEFINITIONS.map(
      ([, , , , , , , , , , used, bound, tests], i) => ({
        def_id: i + 1,
        used_by_files: used,
        used_by_files_bound: bound,
        mentioned_by_tests: tests,
      }),
    ),
    cochange: [
      { file_id: 3, partner_file_id: 4, commits: 3 },
      { file_id: 4, partner_file_id: 3, commits: 3 },
    ],
    cycles: [
      { cycle_id: 1, ord: 0, file_id: 4, line: 2 },
      { cycle_id: 1, ord: 1, file_id: 5, line: 1 },
    ],
    timeline: Array.from({ length: 26 }, (_, k) => ({
      week_start: TINY_TIME - (26 - k) * WEEK,
      commits: k === 25 ? 3 : k === 24 ? 1 : 0,
    })),
    text_index: withSource
      ? lines.flatMap((own, i) =>
          own.flatMap((line, n) =>
            line === "" ? [] : [{ text: line, file_id: i + 1, line: n + 1 }],
          ),
        )
      : [],
  };
}

export function tinyStore(opts?: {
  commit?: string;
  noSource?: boolean;
}): string {
  return miniStore(tinyContent(opts));
}
