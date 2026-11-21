// computeMetrics over merged rows sketched by path, and histories written by hand: ranks and fan
// counts, churn, hotspots and the core set, the cycles and how the two cycle finders differ,
// who uses each definition and whether tests mention it, co-change, the timeline, the renames
// and each file's last change. Every window is anchored at T and open at its start.
import { extname } from "node:path";
import { expect, it } from "vitest";
import type { History } from "../../../src/export/index.js";
import {
  type MergedContent,
  mergeFacts,
} from "../../../src/extract/merge/index.js";
import { computeMetrics } from "../../../src/extract/metrics.js";
import {
  comparePaths,
  type DefKind,
  type FileKind,
  type ImportKind,
  LANG_BY_EXT,
  pagerank,
} from "../../../src/model/index.js";
import {
  type CallSiteRow,
  type CallTargetRow,
  type ComponentRow,
  type DefinitionRow,
  type DefMetricRow,
  type ExternalRow,
  type FileMetricRow,
  type FileRow,
  type ImportRow,
  openStore,
  type RefRow,
} from "../../../src/store/index.js";
import { emptyContent, miniStore } from "../../helpers/mini-store.js";
import {
  astGrep,
  callFact,
  importFact,
  lines,
  mergeInput,
  outlineDef,
  P,
  spot,
} from "./merge-input.js";

const T = 1_780_000_000; // the built commit's committer time in these tests
const DAY = 86_400;
const WEEK = 604_800;

const sha = (n: number): string => n.toString(16).padStart(40, "0");

type Target = [def: string, label: "bound" | "scoped"];

// A repo sketched by its paths, in the shape the merge gives it. Files take ids from 1 in path
// order. Each code, test and test-support file has the language of its extension, its module
// row, and the component of its first directory ("./" at the top). A definition is named
// "<path>#<qualname>", and a file's definitions follow its module row in the order given. An
// import's target is a path, "npm:<name>" for a package, or "?<specifier>" when nothing
// resolves it; its line is its place in the list unless one is given.
interface Sketch {
  files: Record<string, FileKind>;
  defs?: Array<[def: string, kind: DefKind]>;
  imports?: Array<[from: string, to: string, kind?: ImportKind, line?: number]>;
  calls?: Array<[file: string, line: number, callee: string, target?: Target]>;
  refs?: Array<[file: string, line: number, def: string]>;
}

interface Sketched {
  content: MergedContent;
  file(path: string): number; // a file's id
  def(name: string): number; // a definition's id
}

const ON_MAP: ReadonlySet<FileKind> = new Set(["code", "test", "test-support"]);

const componentOf = (path: string): string => {
  const slash = path.indexOf("/");
  return slash === -1 ? "./" : path.slice(0, slash + 1);
};

function sketch(s: Sketch): Sketched {
  const paths = Object.keys(s.files).sort(comparePaths);
  const fileIds = new Map(paths.map((path, i) => [path, i + 1]));
  const file = (path: string): number => {
    const id = fileIds.get(path);
    if (id === undefined) throw new Error(`no file ${path}`);
    return id;
  };
  const kindOf = (path: string): FileKind => s.files[path] as FileKind;
  const mapped = paths.filter((path) => ON_MAP.has(kindOf(path)));
  const componentPaths = [...new Set(mapped.map(componentOf))].sort(
    comparePaths,
  );
  const componentIds = new Map(componentPaths.map((path, i) => [path, i + 1]));
  const files: FileRow[] = paths.map((path) => {
    const on = ON_MAP.has(kindOf(path));
    return {
      id: file(path),
      path,
      lang: on ? (LANG_BY_EXT[extname(path)] ?? null) : null,
      kind: kindOf(path),
      component_id: on ? (componentIds.get(componentOf(path)) ?? null) : null,
      lines: 10,
      bytes: 100,
      blob_sha: sha(file(path)),
      mode: "100644",
      link_target: null,
      entry: 0,
      has_source: 0,
    };
  });
  const components: ComponentRow[] = componentPaths.map((path, i) => {
    const inside = files.filter((f) => f.component_id === i + 1);
    const code = inside.filter((f) => f.kind === "code").length;
    return {
      id: i + 1,
      path,
      kind: "folder",
      parent_id: null,
      files: code,
      tests: inside.length - code,
      lines: 10 * inside.length,
    };
  });

  const definitions: DefinitionRow[] = [];
  const defIds = new Map<string, number>();
  for (const path of mapped) {
    const own: Array<[string, DefKind | "module"]> = [
      ["<module>", "module"],
      ...(s.defs ?? [])
        .filter(([name]) => name.startsWith(`${path}#`))
        .map(([name, kind]): [string, DefKind] => [
          name.slice(path.length + 1),
          kind,
        ]),
    ];
    own.forEach(([qualname, kind], k) => {
      const id = definitions.length + 1;
      const module = kind === "module";
      definitions.push({
        id,
        file_id: file(path),
        qualname,
        ordinal: 1,
        name: qualname.slice(qualname.lastIndexOf(".") + 1),
        kind,
        start_line: k + 1,
        start_col: 1,
        end_line: module ? 11 : k + 1,
        end_col: module ? 1 : 20,
        exported: 0,
        parent_id: null,
        scip_symbol: null,
        signature: null,
        producer: module ? "hakutaku" : "ast-grep",
      });
      defIds.set(`${path}#${qualname}`, id);
    });
  }
  const def = (name: string): number => {
    const id = defIds.get(name);
    if (id === undefined) throw new Error(`no definition ${name}`);
    return id;
  };
  for (const [name] of s.defs ?? []) def(name);

  const sketchedImports = s.imports ?? [];
  const packages = [
    ...new Set(
      sketchedImports.map(([, to]) => to).filter((to) => to.startsWith("npm:")),
    ),
  ].sort(comparePaths);
  const externals: ExternalRow[] = packages.map((to, i) => ({
    id: i + 1,
    ecosystem: "npm",
    name: to.slice("npm:".length),
    files: new Set(sketchedImports.filter((r) => r[1] === to).map((r) => r[0]))
      .size,
  }));
  const imports = sketchedImports.map(
    ([from, to, kind = "static", line], k): ImportRow => {
      const pkg = packages.indexOf(to);
      const unresolved = to.startsWith("?");
      const lang = files[file(from) - 1]?.lang;
      return {
        id: 0,
        src_file_id: file(from),
        dst_file_id: pkg !== -1 || unresolved ? null : file(to),
        dst_external_id: pkg === -1 ? null : pkg + 1,
        kind,
        line: line ?? k + 1,
        specifier:
          pkg !== -1 ? to.slice("npm:".length) : unresolved ? to.slice(1) : to,
        resolved: unresolved ? 0 : 1,
        producer:
          lang === "python"
            ? "grimp"
            : lang === "shell"
              ? "ast-grep"
              : "dependency-cruiser",
      };
    },
  );
  imports.sort(
    (a, b) =>
      a.src_file_id - b.src_file_id ||
      a.line - b.line ||
      comparePaths(a.specifier, b.specifier) ||
      comparePaths(a.kind, b.kind),
  );
  imports.forEach((row, i) => {
    row.id = i + 1;
  });

  // a site's column is its place among the sites on its line
  const placed = new Map<string, number>();
  const sites = (s.calls ?? []).map(([path, line, callee, target]) => {
    const key = `${path}:${line}`;
    const col = (placed.get(key) ?? 0) + 1;
    placed.set(key, col);
    return { path, line, col, callee, target };
  });
  sites.sort(
    (a, b) => file(a.path) - file(b.path) || a.line - b.line || a.col - b.col,
  );
  const call_sites = sites.map(
    (c, i): CallSiteRow => ({
      id: i + 1,
      file_id: file(c.path),
      line: c.line,
      col: c.col,
      enclosing_def_id: def(`${c.path}#<module>`),
      callee_name: c.callee,
      receiver_text: null,
      producer: "ast-grep",
    }),
  );
  const call_targets = sites.flatMap((c, i): CallTargetRow[] =>
    c.target === undefined
      ? []
      : [
          {
            site_id: i + 1,
            def_id: def(c.target[0]),
            label: c.target[1],
            collision: 0,
          },
        ],
  );
  const refs = (s.refs ?? []).map(
    ([path, line, target]): RefRow => ({
      id: 0,
      file_id: file(path),
      line,
      col: 1,
      enclosing_def_id: def(`${path}#<module>`),
      def_id: def(target),
      role: "read",
      producer: "scip-typescript",
    }),
  );
  refs.sort(
    (a, b) =>
      a.file_id - b.file_id ||
      a.line - b.line ||
      a.col - b.col ||
      a.def_id - b.def_id,
  );
  refs.forEach((row, i) => {
    row.id = i + 1;
  });

  return {
    content: {
      components,
      files,
      sources: [],
      definitions,
      externals,
      imports,
      call_sites,
      call_targets,
      refs,
      entry_points: [],
      rule_findings: [],
      text_index: [],
    },
    file,
    def,
  };
}

type Commit = [
  time: number,
  files: string[],
  renames?: Array<[from: string, to: string]>,
];

// A History of the commits given, newest first as export writes it: each commit's sha is its
// place among the arguments, and its files are in path order.
function commits(...list: Commit[]): History {
  return {
    commit: sha(1),
    commitTime: T,
    windowSeconds: 15724800,
    commits: list
      .map(([time, files, renames = []], i) => ({
        sha: sha(i + 1),
        time,
        files: [...files].sort(comparePaths),
        renames: renames.map(([from, to]) => ({ from, to })),
      }))
      .sort((a, b) => b.time - a.time),
  };
}

const A = "web/a.ts";
const B = "web/b.ts";

// One commit per time, each touching web/a.ts and web/b.ts.
const history = (times: number[]): History =>
  commits(...times.map((time): Commit => [time, [A, B]]));

const { content } = sketch({ files: { [A]: "code", [B]: "code" } });

// A file_metrics row: a file in no cycle, of no rank, churn or core, that nothing touched.
const fileRow = (
  file_id: number,
  fields: Partial<FileMetricRow>,
): FileMetricRow => ({
  file_id,
  pagerank: null,
  dependents_rank: null,
  fan_in: 0,
  fan_out: 0,
  churn_90d: 0,
  hotspot: null,
  cycle_id: null,
  core: 0,
  last_change: null,
  ...fields,
});

const defRow = (
  def_id: number,
  used_by_files: number,
  used_by_files_bound: number,
  mentioned_by_tests: 0 | 1,
): DefMetricRow => ({
  def_id,
  used_by_files,
  used_by_files_bound,
  mentioned_by_tests,
});

it("ranks only production files, and fan-in counts tests", () => {
  // a -> b -> c in production, b importing c only as a type; the test imports b and its
  // support file, which imports c
  const s = sketch({
    files: {
      "web/a.ts": "code",
      "web/b.ts": "code",
      "web/c.ts": "code",
      "web/b.test.ts": "test",
      "web/testing/fake.ts": "test-support",
    },
    imports: [
      ["web/a.ts", "web/b.ts"],
      ["web/b.ts", "web/c.ts", "type-only"],
      ["web/b.test.ts", "web/b.ts"],
      ["web/b.test.ts", "web/testing/fake.ts"],
      ["web/testing/fake.ts", "web/c.ts"],
    ],
  });
  const m = computeMetrics(s.content, commits(), T, null);
  // PageRank of the chain a -> b -> c alone, with d = 0.85: a = 1 / (3 + 2d + d^2),
  // b = (1 + d) a, c = (1 + d + d^2) a. b and c carry half of it, and nothing changed.
  const a = 1 / 5.4225;
  expect(m.file_metrics).toEqual([
    fileRow(s.file("web/a.ts"), {
      pagerank: expect.closeTo(a, 9),
      dependents_rank: 3,
      fan_out: 1,
      hotspot: 0,
    }),
    fileRow(s.file("web/b.test.ts"), { fan_out: 2 }),
    fileRow(s.file("web/b.ts"), {
      pagerank: expect.closeTo(1.85 * a, 9),
      dependents_rank: 2,
      fan_in: 2,
      fan_out: 1,
      hotspot: 0,
      core: 1,
    }),
    fileRow(s.file("web/c.ts"), {
      pagerank: expect.closeTo(2.5725 * a, 9),
      dependents_rank: 1,
      fan_in: 2,
      hotspot: 0,
      core: 1,
    }),
    fileRow(s.file("web/testing/fake.ts"), { fan_in: 1, fan_out: 1 }),
  ]);
});

it("counts fan-in and fan-out as distinct repo files of any kind", () => {
  // three imports of b make one edge; a config file counts, a package and an unresolved
  // import do not; the doc and the config file get no row
  const s = sketch({
    files: {
      "README.md": "doc",
      "web/a.test.ts": "test",
      "web/a.ts": "code",
      "web/b.ts": "code",
      "web/data.json": "config",
    },
    imports: [
      ["web/a.ts", "web/b.ts", "static"],
      ["web/a.ts", "web/b.ts", "type-only"],
      ["web/a.ts", "web/b.ts", "dynamic"],
      ["web/a.ts", "web/data.json"],
      ["web/a.ts", "npm:react"],
      ["web/a.ts", "?./gone"],
      ["web/a.test.ts", "web/a.ts"],
      ["web/a.test.ts", "web/b.ts"],
    ],
  });
  const m = computeMetrics(s.content, commits(), T, null);
  // PageRank of a -> b alone: a = 1 / (2 + d), b = (1 + d) / (2 + d)
  expect(m.file_metrics).toEqual([
    fileRow(s.file("web/a.test.ts"), { fan_out: 2 }),
    fileRow(s.file("web/a.ts"), {
      pagerank: expect.closeTo(1 / 2.85, 9),
      dependents_rank: 2,
      fan_in: 1,
      fan_out: 2,
      hotspot: 0,
    }),
    fileRow(s.file("web/b.ts"), {
      pagerank: expect.closeTo(1.85 / 2.85, 9),
      dependents_rank: 1,
      fan_in: 2,
      hotspot: 0,
      core: 1,
    }),
  ]);
});

it("counts a self-import as an importer, a ranked edge and a one-file cycle", () => {
  // b imports itself, as a type at line 2 and at run time at lines 3 and 5
  const s = sketch({
    files: { [A]: "code", [B]: "code" },
    imports: [
      [A, B, "static", 1],
      [B, B, "type-only", 2],
      [B, B, "static", 3],
      [B, B, "dynamic", 5],
    ],
  });
  const m = computeMetrics(s.content, commits(), T, null);
  // PageRank over a -> b and b -> b: a keeps only the base 0.15 / 2, b holds the rest
  expect(m.file_metrics).toEqual([
    fileRow(s.file(A), {
      pagerank: expect.closeTo(0.075, 9),
      dependents_rank: 2,
      fan_out: 1,
      hotspot: 0,
    }),
    fileRow(s.file(B), {
      pagerank: expect.closeTo(0.925, 9),
      dependents_rank: 1,
      fan_in: 2,
      fan_out: 1,
      hotspot: 0,
      cycle_id: 1,
      core: 1,
    }),
  ]);
  expect(m.cycles).toEqual([
    { cycle_id: 1, ord: 0, file_id: s.file(B), line: 3 },
  ]);
});

it("counts churn inside (t - 90 days, t] only", () => {
  // a commit at T - 7776000 is out; one at T - 7775999 is in, and so is one at T
  const s = sketch({
    files: {
      "docs/notes.md": "doc",
      [A]: "code",
      [B]: "code",
      "web/c.test.ts": "test",
    },
  });
  const h = commits(
    [T, [A, "web/c.test.ts", "docs/notes.md"]],
    [T - 7775999, [A, B]],
    [T - 7776000, [A, B]],
  );
  const m = computeMetrics(s.content, h, T, null);
  // no import: each production file ranks 0.5, by path; a's churn is the larger, so its
  // hotspot is 1 and b's sqrt(1/2)
  expect(m.file_metrics).toEqual([
    fileRow(s.file(A), {
      pagerank: 0.5,
      dependents_rank: 1,
      churn_90d: 2,
      hotspot: 1,
      core: 1,
      last_change: T,
    }),
    fileRow(s.file(B), {
      pagerank: 0.5,
      dependents_rank: 2,
      churn_90d: 1,
      hotspot: 0.71,
      last_change: T - 7775999,
    }),
    fileRow(s.file("web/c.test.ts"), { churn_90d: 1, last_change: T }),
  ]);
});

it("finds cycles without type-only imports, with the closing chain's lines", () => {
  const s = sketch({
    files: {
      "web/a.test.ts": "test",
      "web/catalog.ts": "code",
      "web/orbit.ts": "code",
      "web/planets.ts": "code",
      "web/units.ts": "code",
      "web/x.ts": "code",
      "web/y.ts": "code",
      "web/z.ts": "code",
    },
    imports: [
      // catalog <-> planets: planets imports catalog as a type at line 1, at run time at 2
      ["web/catalog.ts", "web/planets.ts", "static", 3],
      ["web/catalog.ts", "web/planets.ts", "dynamic", 7],
      ["web/planets.ts", "web/catalog.ts", "type-only", 1],
      ["web/planets.ts", "web/catalog.ts", "static", 2],
      // orbit -> units, closed only by a type-only import: no cycle
      ["web/orbit.ts", "web/units.ts", "static", 1],
      ["web/units.ts", "web/orbit.ts", "type-only", 1],
      // orbit <-> a.test.ts goes through a test: no cycle
      ["web/orbit.ts", "web/a.test.ts", "static", 2],
      ["web/a.test.ts", "web/orbit.ts", "static", 1],
      // x, y and z are one set; its shortest chain through x is x -> y -> x
      ["web/x.ts", "web/y.ts", "static", 4],
      ["web/y.ts", "web/x.ts", "static", 5],
      ["web/y.ts", "web/z.ts", "static", 6],
      ["web/z.ts", "web/y.ts", "static", 2],
    ],
  });
  const m = computeMetrics(s.content, commits(), T, null);
  expect(m.cycles).toEqual([
    { cycle_id: 1, ord: 0, file_id: s.file("web/catalog.ts"), line: 3 },
    { cycle_id: 1, ord: 1, file_id: s.file("web/planets.ts"), line: 2 },
    { cycle_id: 2, ord: 0, file_id: s.file("web/x.ts"), line: 4 },
    { cycle_id: 2, ord: 1, file_id: s.file("web/y.ts"), line: 5 },
  ]);
  expect(m.file_metrics.map((r) => [r.file_id, r.cycle_id])).toEqual([
    [s.file("web/a.test.ts"), null],
    [s.file("web/catalog.ts"), 1],
    [s.file("web/orbit.ts"), null],
    [s.file("web/planets.ts"), 1],
    [s.file("web/units.ts"), null],
    [s.file("web/x.ts"), 2],
    [s.file("web/y.ts"), 2],
    [s.file("web/z.ts"), 2],
  ]);
});

it("counts files the two cycle finders disagree on", () => {
  // both find a <-> b; only Tarjan finds c <-> d; dependency-cruiser alone reports e and f,
  // which no import cycle of the store holds
  const s = sketch({
    files: {
      "web/a.ts": "code",
      "web/b.ts": "code",
      "web/c.ts": "code",
      "web/d.ts": "code",
      "web/e.ts": "code",
      "web/f.ts": "code",
    },
    imports: [
      ["web/a.ts", "web/b.ts"],
      ["web/b.ts", "web/a.ts"],
      ["web/c.ts", "web/d.ts"],
      ["web/d.ts", "web/c.ts"],
      ["web/e.ts", "web/f.ts"],
    ],
  });
  const reported = new Set(["web/a.ts", "web/b.ts", "web/e.ts", "web/f.ts"]);
  expect(
    computeMetrics(s.content, commits(), T, reported).cycleDifferences,
  ).toBe(4);
  const agreed = new Set(["web/a.ts", "web/b.ts", "web/c.ts", "web/d.ts"]);
  expect(computeMetrics(s.content, commits(), T, agreed).cycleDifferences).toBe(
    0,
  );
  // without dependency-cruiser's answer there is nothing to compare
  expect(computeMetrics(s.content, commits(), T, null).cycleDifferences).toBe(
    0,
  );
});

it("leaves Python and shell cycles, and cycles that only a type-only import or a test closes, out of the difference", () => {
  // dependency-cruiser reads no Python or shell, and reports body <-> star and
  // u <-> u.test.ts, which the production run-time cycles leave out
  const s = sketch({
    files: {
      "scripts/a.sh": "code",
      "scripts/b.sh": "code",
      "sim/p.py": "code",
      "sim/q.py": "code",
      "web/body.ts": "code",
      "web/star.ts": "code",
      "web/u.test.ts": "test",
      "web/u.ts": "code",
    },
    imports: [
      ["scripts/a.sh", "scripts/b.sh", "source"],
      ["scripts/b.sh", "scripts/a.sh", "source"],
      ["sim/p.py", "sim/q.py"],
      ["sim/q.py", "sim/p.py"],
      ["web/body.ts", "web/star.ts"],
      ["web/star.ts", "web/body.ts", "type-only"],
      ["web/u.ts", "web/u.test.ts"],
      ["web/u.test.ts", "web/u.ts"],
    ],
  });
  const reported = new Set([
    "web/body.ts",
    "web/star.ts",
    "web/u.test.ts",
    "web/u.ts",
  ]);
  const m = computeMetrics(s.content, commits(), T, reported);
  expect(m.cycleDifferences).toBe(0);
  // Tarjan's two cycles are the shell and the Python ones
  expect(m.cycles.map((r) => [r.cycle_id, r.file_id])).toEqual([
    [1, s.file("scripts/a.sh")],
    [1, s.file("scripts/b.sh")],
    [2, s.file("sim/p.py")],
    [2, s.file("sim/q.py")],
  ]);
});

it("keeps co-change partners from commits touching 2 to 30 files, at least 2 shared, top 8", () => {
  // h shares commits with p01..p10 by twos, and all of them share a 30-file commit (a doc and
  // a deleted path beside it count for nothing). A 31-file commit is ignored, and the f files,
  // sharing one commit each, are no one's partners. Five partners tie at 2 for h's 6th to 8th
  // places: p01, p07 and p08 stay, and p09 and p10, met first, are cut by path. The kept rows
  // go by partner, not by shared commits.
  const two = (n: number): string => String(n).padStart(2, "0");
  const p = (n: number): string => `web/p${two(n)}.ts`;
  const f = (n: number): string => `web/f${two(n)}.ts`;
  const upTo = (n: number): number[] =>
    Array.from({ length: n }, (_, i) => i + 1);
  const H = "web/h.ts";
  const files: Record<string, FileKind> = { "README.md": "doc", [H]: "code" };
  for (const n of upTo(20)) files[f(n)] = "code";
  for (const n of upTo(10)) files[p(n)] = "code";
  const s = sketch({ files });
  // with the 30-file commit, h shares 5 with p02, 4 with p03 and p04, 3 with p05 and p06,
  // and 2 with p01 and p07..p10
  const pairs = [10, 9, 1, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8];
  const h = commits(
    ...pairs.map((n, k): Commit => [T - k * DAY, [H, p(n)]]),
    [
      T - 20 * DAY,
      [H, ...upTo(10).map(p), ...upTo(19).map(f), "README.md", "web/gone.ts"],
    ],
    [T - 21 * DAY, [H, ...upTo(10).map(p), ...upTo(20).map(f)]],
  );
  const m = computeMetrics(s.content, h, T, null);
  const shared = [2, 5, 4, 4, 3, 3, 2, 2, 2, 2];
  expect(m.cochange).toEqual([
    ...upTo(8).map((n) => ({
      file_id: s.file(H),
      partner_file_id: s.file(p(n)),
      commits: shared[n - 1],
    })),
    ...upTo(10).map((n) => ({
      file_id: s.file(p(n)),
      partner_file_id: s.file(H),
      commits: shared[n - 1],
    })),
  ]);
});

it("counts co-change and renames inside (t - 180 days, t] only, each rename once", () => {
  // a commit at T - 15552000 is out, one at T - 15551999 is in. The renames go by old path,
  // new path, then commit, and in each of the three a later key disagrees with the order the
  // keys before it give.
  const h = commits(
    [T, [A, B], [["web/old-a.ts", B]]],
    [T - 15551999, [A, B, "wiki/y.md"], [["docs/x.md", "wiki/y.md"]]],
    [T - 15552000, [A, B], [["web/z.ts", B]]],
    [T - 100, [A], [["web/old-a.ts", A]]],
    [T - 200, ["wiki/y.md"], [["docs/x.md", "wiki/y.md"]]],
  );
  const m = computeMetrics(content, h, T, null);
  expect(m.cochange).toEqual([
    { file_id: 1, partner_file_id: 2, commits: 2 },
    { file_id: 2, partner_file_id: 1, commits: 2 },
  ]);
  const renames = [
    { old_path: "docs/x.md", new_path: "wiki/y.md", commit_sha: sha(2) },
    { old_path: "docs/x.md", new_path: "wiki/y.md", commit_sha: sha(5) },
    { old_path: "web/old-a.ts", new_path: A, commit_sha: sha(4) },
    { old_path: "web/old-a.ts", new_path: B, commit_sha: sha(1) },
  ];
  expect(m.renames).toEqual(renames);
  // a commit listed twice gives its renames once
  const twice = { ...h, commits: [...h.commits, ...h.commits] };
  expect(computeMetrics(content, twice, T, null).renames).toEqual(renames);
});

it("writes 26 timeline rows with their bucket edges", () => {
  const m = computeMetrics(
    content,
    history([T - 604800, T - 604799, T]),
    T,
    null,
  );
  expect(m.timeline).toHaveLength(26);
  expect(m.timeline[25]).toEqual({ week_start: T - 604800, commits: 2 });
  expect(m.timeline[24]).toEqual({ week_start: T - 2 * 604800, commits: 1 });
  expect(m.timeline.slice(0, 24)).toEqual(
    Array.from({ length: 24 }, (_, k) => ({
      week_start: T - (26 - k) * WEEK,
      commits: 0,
    })),
  );
  // the oldest week is (T - 26 weeks, T - 25 weeks]; a merge, which touches no file, counts,
  // and a commit after T counts nowhere
  const oldest = computeMetrics(
    content,
    commits(
      [T + 1, [A]],
      [T - 26 * WEEK, [A, B]],
      [T - 26 * WEEK + 1, []],
      [T - 25 * WEEK, [A]],
    ),
    T,
    null,
  );
  expect(oldest.timeline.map((r) => r.commits)).toEqual([
    2,
    ...Array(25).fill(0),
  ]);
  expect(oldest.timeline[0]).toEqual({ week_start: T - 26 * WEEK, commits: 2 });
});

it("counts used-by files and the bound subset, never the defining file", () => {
  const s = sketch({
    files: {
      "web/api.ts": "code",
      "web/camera.ts": "code",
      "web/kepler.test.ts": "test",
      "web/kepler.ts": "code",
      "web/planets.ts": "code",
      "web/render.ts": "code",
    },
    defs: [
      ["web/kepler.ts#solveKepler", "function"],
      ["web/kepler.ts#Orbit", "class"],
      ["web/kepler.ts#Orbit.position", "method"],
      ["web/planets.ts#drawPlanets", "function"],
    ],
    calls: [
      // two bound sites in planets count it once; render's is scoped
      [
        "web/planets.ts",
        3,
        "position",
        ["web/kepler.ts#Orbit.position", "bound"],
      ],
      [
        "web/planets.ts",
        4,
        "position",
        ["web/kepler.ts#Orbit.position", "bound"],
      ],
      [
        "web/render.ts",
        2,
        "position",
        ["web/kepler.ts#Orbit.position", "scoped"],
      ],
      // the defining file and a test count for no use
      [
        "web/kepler.ts",
        9,
        "solveKepler",
        ["web/kepler.ts#solveKepler", "bound"],
      ],
      [
        "web/kepler.test.ts",
        2,
        "solveKepler",
        ["web/kepler.ts#solveKepler", "bound"],
      ],
      [
        "web/api.ts",
        5,
        "drawPlanets",
        ["web/planets.ts#drawPlanets", "scoped"],
      ],
      [
        "web/render.ts",
        6,
        "drawPlanets",
        ["web/planets.ts#drawPlanets", "scoped"],
      ],
    ],
    refs: [
      // a reference counts as a bound use: camera's import of Orbit, and render's read
      ["web/camera.ts", 1, "web/kepler.ts#Orbit"],
      ["web/render.ts", 7, "web/planets.ts#drawPlanets"],
      ["web/kepler.ts", 12, "web/kepler.ts#Orbit"],
    ],
  });
  const m = computeMetrics(s.content, commits(), T, null, {
    tiers: { "scip-typescript": "ran" },
    imports: [],
  });
  expect(m.def_metrics).toEqual([
    defRow(s.def("web/kepler.ts#solveKepler"), 0, 0, 1),
    defRow(s.def("web/kepler.ts#Orbit"), 1, 1, 0),
    defRow(s.def("web/kepler.ts#Orbit.position"), 2, 1, 0),
    defRow(s.def("web/planets.ts#drawPlanets"), 2, 1, 0),
  ]);
});

it("mentions a definition from a test or test-support file's call targets and references", () => {
  // scip-typescript ran, so a call site without a target mentions nothing
  const s = sketch({
    files: {
      "web/kepler.test.ts": "test",
      "web/kepler.ts": "code",
      "web/sky.ts": "code",
      "web/testing/fake-clock.ts": "test-support",
    },
    defs: [
      ["web/kepler.test.ts#makeOrbit", "function"],
      ["web/kepler.ts#solveKepler", "function"],
      ["web/kepler.ts#Orbit", "class"],
      ["web/kepler.ts#G", "constant"],
      ["web/kepler.ts#unused", "function"],
    ],
    imports: [
      ["web/kepler.test.ts", "web/kepler.ts"],
      ["web/testing/fake-clock.ts", "web/kepler.ts"],
      ["web/sky.ts", "web/kepler.ts"],
    ],
    calls: [
      [
        "web/kepler.test.ts",
        3,
        "solveKepler",
        ["web/kepler.ts#solveKepler", "bound"],
      ],
      ["web/kepler.test.ts", 4, "Orbit", ["web/kepler.ts#Orbit", "scoped"]],
      // a test's own helper, called in the test
      [
        "web/kepler.test.ts",
        5,
        "makeOrbit",
        ["web/kepler.test.ts#makeOrbit", "bound"],
      ],
      ["web/kepler.test.ts", 6, "unused"],
      ["web/sky.ts", 2, "unused", ["web/kepler.ts#unused", "bound"]],
    ],
    refs: [["web/testing/fake-clock.ts", 1, "web/kepler.ts#G"]],
  });
  const m = computeMetrics(s.content, commits(), T, null, {
    tiers: { "scip-typescript": "ran" },
    imports: [{ file: "web/kepler.test.ts", names: ["unused"] }],
  });
  expect(m.def_metrics).toEqual([
    defRow(s.def("web/kepler.test.ts#makeOrbit"), 0, 0, 1),
    defRow(s.def("web/kepler.ts#solveKepler"), 0, 0, 1),
    defRow(s.def("web/kepler.ts#Orbit"), 0, 0, 1),
    defRow(s.def("web/kepler.ts#G"), 0, 0, 1),
    defRow(s.def("web/kepler.ts#unused"), 1, 1, 0),
  ]);
});

it("mentions a definition from a test by name and import when no compiler ran", () => {
  // no site has a target; a test mentions what it names, by a call or an imported binding,
  // in a file it imports, but not in a script it runs by path
  const s = sketch({
    files: {
      "scripts/lib.sh": "code",
      "scripts/sync.sh": "code",
      "sim/src/obs/orbit.py": "code",
      "sim/tests/test_orbit.py": "test",
      "test/run.sh": "test",
      "web/constants.ts": "code",
      "web/kepler.test.ts": "test",
      "web/kepler.ts": "code",
      "web/legacy.js": "code",
      "web/units.ts": "code",
    },
    defs: [
      ["scripts/lib.sh#helper", "function"],
      ["scripts/sync.sh#main", "function"],
      ["sim/src/obs/orbit.py#propagate", "function"],
      ["sim/src/obs/orbit.py#G", "constant"],
      ["web/constants.ts#G", "constant"],
      ["web/constants.ts#C", "constant"],
      ["web/kepler.ts#solveKepler", "function"],
      ["web/kepler.ts#G", "constant"],
      ["web/legacy.js#oldSolve", "function"],
      ["web/units.ts#toRadians", "function"],
    ],
    imports: [
      ["test/run.sh", "scripts/lib.sh", "source"],
      ["test/run.sh", "scripts/sync.sh", "exec"],
      ["sim/tests/test_orbit.py", "sim/src/obs/orbit.py"],
      ["web/kepler.test.ts", "web/kepler.ts"],
      ["web/kepler.test.ts", "web/constants.ts"],
      ["web/kepler.test.ts", "web/legacy.js"],
      ["web/kepler.ts", "web/units.ts"],
    ],
    calls: [
      ["test/run.sh", 3, "helper"],
      ["test/run.sh", 4, "main"],
      ["web/kepler.test.ts", 4, "solveKepler"],
      ["web/kepler.test.ts", 5, "oldSolve"],
      // units.ts is not one of the test's imports, and a production file's call mentions
      // nothing
      ["web/kepler.test.ts", 6, "toRadians"],
      ["web/kepler.ts", 3, "toRadians"],
    ],
  });
  // G is bound from constants.ts; the name alone also mentions kepler.ts's G, which the test
  // imports too. A production file's binding mentions nothing.
  const imports = [
    { file: "sim/tests/test_orbit.py", names: ["propagate"] },
    { file: "web/kepler.test.ts", names: ["G"] },
    { file: "web/kepler.ts", names: ["toRadians"] },
  ];
  // the definitions in id order
  const named = [
    "scripts/lib.sh#helper",
    "scripts/sync.sh#main",
    "sim/src/obs/orbit.py#propagate",
    "sim/src/obs/orbit.py#G",
    "web/constants.ts#G",
    "web/constants.ts#C",
    "web/kepler.ts#solveKepler",
    "web/kepler.ts#G",
    "web/legacy.js#oldSolve",
    "web/units.ts#toRadians",
  ];
  const mentioned = (given?: Parameters<typeof computeMetrics>[4]) =>
    computeMetrics(s.content, commits(), T, null, given).def_metrics.map(
      (r) => [r.def_id, r.mentioned_by_tests],
    );
  const expected = (...flags: Array<0 | 1>) =>
    named.map((name, k) => [s.def(name), flags[k]]);
  expect(mentioned({ tiers: {}, imports })).toEqual(
    expected(1, 0, 1, 0, 1, 0, 1, 1, 1, 0),
  );
  // once scip-typescript ran, the names mention no TS or JS definition
  expect(mentioned({ tiers: { "scip-typescript": "ran" }, imports })).toEqual(
    expected(1, 0, 1, 0, 0, 0, 0, 0, 0, 0),
  );
  // nor, once scip-python ran too, a Python one; shell has no compiler tier
  expect(
    mentioned({
      tiers: { "scip-typescript": "ran", "scip-python": "ran" },
      imports,
    }),
  ).toEqual(expected(1, 0, 0, 0, 0, 0, 0, 0, 0, 0));
  // without the fifth argument, no compiler tier ran and no import binds a name
  expect(mentioned()).toEqual(expected(1, 0, 0, 0, 0, 0, 1, 0, 1, 0));
  expect(mentioned()).toEqual(mentioned({ tiers: {}, imports: [] }));
});

it("sets last_change to the newest touching commit's time, and null when no commit touches the file", () => {
  // b is a rename's new path; d.test.ts changed before the 90 days, inside the history
  const s = sketch({
    files: {
      [A]: "code",
      [B]: "code",
      "web/c.ts": "code",
      "web/d.test.ts": "test",
    },
  });
  const h = commits(
    [T - 50, [A, B], [["web/old.ts", B]]],
    [T - 100, [A]],
    [T - 10_000_000, ["web/d.test.ts"]],
  );
  const expected = [
    [s.file(A), T - 50],
    [s.file(B), T - 50],
    [s.file("web/c.ts"), null],
    [s.file("web/d.test.ts"), T - 10_000_000],
  ];
  const lastChange = (given: History) =>
    computeMetrics(s.content, given, T, null).file_metrics.map((r) => [
      r.file_id,
      r.last_change,
    ]);
  expect(lastChange(h)).toEqual(expected);
  // whatever order the history lists its commits in
  expect(lastChange({ ...h, commits: [...h.commits].reverse() })).toEqual(
    expected,
  );
});

it("computes metrics over a one-commit history", () => {
  // the one commit touches both files: churn 1 each, and one shared commit makes no partners
  const m = computeMetrics(content, history([T]), T, null);
  expect(m.file_metrics).toEqual([
    fileRow(1, {
      pagerank: 0.5,
      dependents_rank: 1,
      churn_90d: 1,
      hotspot: 1,
      core: 1,
      last_change: T,
    }),
    fileRow(2, {
      pagerank: 0.5,
      dependents_rank: 2,
      churn_90d: 1,
      hotspot: 1,
      last_change: T,
    }),
  ]);
  expect(m.cochange).toEqual([]);
  expect(m.timeline).toHaveLength(26);
  expect(m.timeline.map((r) => r.commits)).toEqual([...Array(25).fill(0), 1]);
  expect(m.cycles).toEqual([]);
  expect(m.renames).toEqual([]);
});

it("computes metrics over an empty tree", () => {
  // one empty commit, as `git commit --allow-empty` makes on an empty repo
  const m = computeMetrics(
    sketch({ files: {} }).content,
    commits([T, []]),
    T,
    new Set(),
  );
  expect(m).toEqual({
    file_metrics: [],
    def_metrics: [],
    cochange: [],
    cycles: [],
    timeline: Array.from({ length: 26 }, (_, k) => ({
      week_start: T - (26 - k) * WEEK,
      commits: k === 25 ? 1 : 0,
    })),
    renames: [],
    cycleDifferences: 0,
  });
});

it("takes the hotspots and the core set from the production files and their components", () => {
  // core.ts alone carries half of the rank, and view.ts joins it as web/'s top file. app.ts
  // changed most; the test's five changes count for no hotspot. app.ts imports core.ts twice,
  // which is one edge.
  const CORE = "lib/core.ts";
  const UTIL = "lib/util.ts";
  const APP = "web/app.ts";
  const VIEW = "web/view.ts";
  const TEST = "web/app.test.ts";
  const s = sketch({
    files: {
      [CORE]: "code",
      [UTIL]: "code",
      [TEST]: "test",
      [APP]: "code",
      [VIEW]: "code",
    },
    imports: [
      [APP, CORE],
      [APP, CORE, "dynamic"],
      [APP, VIEW],
      [VIEW, CORE],
      [UTIL, CORE],
      [TEST, APP],
    ],
  });
  const h = commits(
    [T - DAY, [APP, TEST]],
    [T - 2 * DAY, [APP, TEST, CORE]],
    [T - 3 * DAY, [APP, TEST, VIEW]],
    [T - 4 * DAY, [TEST]],
    [T - 5 * DAY, [TEST]],
  );
  const m = computeMetrics(s.content, h, T, null);
  // the production files in path order: core.ts, util.ts, app.ts, view.ts
  const rank = pagerank(4, [
    [2, 0],
    [2, 3],
    [3, 0],
    [1, 0],
  ]);
  expect(m.file_metrics).toEqual([
    fileRow(s.file(CORE), {
      pagerank: rank[0],
      dependents_rank: 1,
      fan_in: 3,
      churn_90d: 1,
      hotspot: 1,
      core: 1,
      last_change: T - 2 * DAY,
    }),
    fileRow(s.file(UTIL), {
      pagerank: rank[1],
      dependents_rank: 3,
      fan_out: 1,
      hotspot: 0,
    }),
    fileRow(s.file(TEST), { fan_out: 1, churn_90d: 5, last_change: T - DAY }),
    fileRow(s.file(APP), {
      pagerank: rank[2],
      dependents_rank: 4,
      fan_in: 1,
      fan_out: 2,
      churn_90d: 3,
      hotspot: 0.93,
      last_change: T - DAY,
    }),
    fileRow(s.file(VIEW), {
      pagerank: rank[3],
      dependents_rank: 2,
      fan_in: 1,
      fan_out: 1,
      churn_90d: 1,
      hotspot: 0.64,
      core: 1,
      last_change: T - 3 * DAY,
    }),
  ]);
});

it("gives the same metrics whatever order the imports, call sites, targets and references come in", () => {
  // catalog imports planets at lines 3 and 7, so the reversed rows meet the later line first
  const s = sketch({
    files: {
      "web/catalog.ts": "code",
      "web/planets.test.ts": "test",
      "web/planets.ts": "code",
    },
    defs: [
      ["web/catalog.ts#Catalog", "class"],
      ["web/planets.ts#drawPlanets", "function"],
    ],
    imports: [
      ["web/catalog.ts", "web/planets.ts", "static", 3],
      ["web/catalog.ts", "web/planets.ts", "dynamic", 7],
      ["web/planets.ts", "web/catalog.ts", "static", 2],
      ["web/planets.test.ts", "web/planets.ts"],
      ["web/planets.test.ts", "web/catalog.ts"],
    ],
    calls: [
      [
        "web/catalog.ts",
        4,
        "drawPlanets",
        ["web/planets.ts#drawPlanets", "bound"],
      ],
      [
        "web/planets.test.ts",
        2,
        "drawPlanets",
        ["web/planets.ts#drawPlanets", "scoped"],
      ],
      ["web/planets.test.ts", 3, "Catalog"],
    ],
    refs: [
      ["web/planets.ts", 1, "web/catalog.ts#Catalog"],
      ["web/planets.test.ts", 1, "web/catalog.ts#Catalog"],
    ],
  });
  const h = commits(
    [T, ["web/catalog.ts", "web/planets.ts"]],
    [T - DAY, ["web/catalog.ts", "web/planets.test.ts", "web/planets.ts"]],
  );
  const reported = new Set(["web/catalog.ts", "web/planets.ts"]);
  const mentions = {
    tiers: {},
    imports: [{ file: "web/planets.test.ts", names: ["Catalog"] }],
  };
  const forward = computeMetrics(s.content, h, T, reported, mentions);
  expect(forward.cycles).toEqual([
    { cycle_id: 1, ord: 0, file_id: s.file("web/catalog.ts"), line: 3 },
    { cycle_id: 1, ord: 1, file_id: s.file("web/planets.ts"), line: 2 },
  ]);
  const c = s.content;
  const reversed: MergedContent = {
    ...c,
    imports: [...c.imports].reverse(),
    call_sites: [...c.call_sites].reverse(),
    call_targets: [...c.call_targets].reverse(),
    refs: [...c.refs].reverse(),
  };
  expect(computeMetrics(reversed, h, T, reported, mentions)).toEqual(forward);
});

it("writes metric rows the store's writer takes, over the merge's own rows", () => {
  const CATALOG = "web/sky/catalog.ts";
  const PLANETS = "web/sky/planets.ts";
  const TEST = "web/sky/planets.test.ts";
  const catalog = lines(
    'import { planets } from "./planets";',
    "export const catalog = 1;",
  );
  const planets = lines(
    'import { catalog } from "./catalog";',
    "export function planets() {",
    "  return catalog;",
    "}",
  );
  const test = lines('import { planets } from "./planets";', "planets();");
  const input = mergeInput(
    { [CATALOG]: catalog, [PLANETS]: planets, [TEST]: test },
    {
      facts: {
        astGrep: astGrep({
          defs: [
            outlineDef(
              CATALOG,
              "catalog",
              "constant",
              P(2, 8),
              P(2, 26),
              [spot(catalog, 2, "catalog")],
              "export const catalog = 1;",
              true,
            ),
            outlineDef(
              PLANETS,
              "planets",
              "function",
              P(2, 8),
              P(4, 2),
              [spot(planets, 2, "planets")],
              "export function planets() {",
              true,
            ),
          ],
          calls: [callFact(TEST, P(2, 1), "planets")],
          imports: [
            importFact(
              CATALOG,
              spot(catalog, 1, '"./planets"'),
              "./planets",
              "static",
              ["planets"],
            ),
            importFact(
              PLANETS,
              spot(planets, 1, '"./catalog"'),
              "./catalog",
              "static",
              ["catalog"],
            ),
            importFact(
              TEST,
              spot(test, 1, '"./planets"'),
              "./planets",
              "static",
              ["planets"],
            ),
          ],
        }),
      },
    },
  );
  const merged = mergeFacts(input).content;
  const { cycleDifferences, ...tables } = computeMetrics(
    merged,
    commits(
      [T, [CATALOG, PLANETS, TEST], [["web/sky/list.ts", CATALOG]]],
      [T - DAY, [CATALOG, PLANETS]],
    ),
    T,
    new Set([CATALOG, PLANETS]),
    { tiers: {}, imports: input.astGrep?.imports ?? [] },
  );
  expect(cycleDifferences).toBe(0);
  const names = [
    "file_metrics",
    "def_metrics",
    "cochange",
    "cycles",
    "timeline",
    "renames",
  ] as const;
  // every metric table holds rows, so the writer checks each one's order and references
  for (const name of names) expect(tables[name].length).toBeGreaterThan(0);

  const store = openStore(
    miniStore({ ...emptyContent(), ...merged, ...tables }),
  );
  if ("code" in store) throw new Error(store.reason);
  try {
    for (const name of names) {
      const { n } = store.db
        .prepare(`SELECT count(*) AS n FROM ${name}`)
        .get() as { n: number };
      expect([name, n]).toEqual([name, tables[name].length]);
    }
  } finally {
    store.close();
  }
});
