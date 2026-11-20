import { describe, expect, it } from "vitest";
import {
  comparePaths,
  type EntryKind,
  type FileKind,
} from "../../../src/model/index.js";
import {
  type QueryCtx,
  type QueryOut,
  queryOverview,
} from "../../../src/query/index.js";
import { openStore, type Store } from "../../../src/store/index.js";
import type { ToolError } from "../../../src/tools/errors.js";
import type {
  OverviewComponentAnswer,
  OverviewRepoAnswer,
} from "../../../src/tools/types.js";
import { emptyContent, miniStore } from "../../helpers/mini-store.js";
import { openTiny, TINY_CTX } from "../../helpers/tiny.js";

type Overview = OverviewRepoAnswer | OverviewComponentAnswer;

const answer = (out: QueryOut<Overview>): Overview => {
  if (!out.ok) throw new Error(`an error: ${JSON.stringify(out.error)}`);
  return out.answer;
};
const error = (out: QueryOut<Overview>): ToolError => {
  if (out.ok) throw new Error(`an answer: ${JSON.stringify(out.answer)}`);
  return out.error;
};
const asRepo = (out: QueryOut<Overview>): OverviewRepoAnswer =>
  answer(out) as OverviewRepoAnswer;
const asComponent = (out: QueryOut<Overview>): OverviewComponentAnswer =>
  answer(out) as OverviewComponentAnswer;

it("describes the repo", () => {
  const a = asRepo(queryOverview(openTiny(), { repo: "tiny" }, TINY_CTX));
  expect(Object.keys(a)).toEqual([
    "id",
    "kind",
    "builtCommit",
    "stale",
    "files",
    "tests",
    "lines",
    "languages",
    "coreSet",
    "components",
    "dependsOn",
    "entryPoints",
    "hotspots",
    "cycles",
    "view",
  ]);
  expect(a).toMatchObject({
    id: "tiny:",
    kind: "repo",
    files: 12,
    tests: 1,
    lines: 71,
    view: "#",
  });
  expect(JSON.stringify(a.languages)).toBe(
    '{"python":2,"shell":1,"typescript":10}',
  );
  expect(a.coreSet).toEqual({
    files: 3,
    ofFiles: 12,
    share: 0.5,
    top: [
      { id: "tiny:lib/orbit.ts", dependentsRank: 1, importedBy: 3 },
      { id: "tiny:lib/units.ts", dependentsRank: 2, importedBy: 2 },
      { id: "tiny:lib/consts.ts", dependentsRank: 3, importedBy: 1 },
    ],
  });
  expect(a.components.top.map((c) => c.id)).toEqual([
    "tiny:lib/",
    "tiny:app/",
    "tiny:py/",
    "tiny:scripts/",
  ]);
  expect(a.components.top[0]).toEqual({
    id: "tiny:lib/",
    files: 8,
    tests: 1,
    coreFiles: 3,
    entryPoints: 0,
  });
  expect(a.dependsOn).toEqual({
    total: 2,
    top: [
      { from: "tiny:app/", to: "tiny:lib/", imports: 2 },
      { from: "tiny:lib/", to: "tiny:app/", imports: 1 },
    ],
  });
  expect(a.entryPoints).toEqual({
    total: 2,
    top: [
      {
        id: "tiny:app/main.ts",
        kind: "bin",
        via: "tiny:package.json",
        line: 3,
      },
      {
        id: "tiny:scripts/sync-",
        kind: "executable",
        via: "tiny:scripts/sync-",
        line: 1,
      },
    ],
  });
  expect(a.hotspots).toEqual({
    total: 2,
    top: [
      { id: "tiny:lib/orbit.ts", hotspot: 1, commits90d: 5 },
      { id: "tiny:lib/render.ts", hotspot: 0.36, commits90d: 2 },
    ],
  });
  expect(a.cycles).toEqual({
    total: 1,
    top: [["tiny:lib/consts.ts", "tiny:lib/units.ts"]],
  });
});

it("describes a component by path, with or without its slash, or by its ID", () => {
  const want = {
    id: "tiny:lib/",
    kind: "component",
    builtCommit: "0123456789ab",
    stale: false,
    files: 8,
    tests: 1,
    core: [
      { id: "tiny:lib/orbit.ts", importedBy: 3 },
      { id: "tiny:lib/units.ts", importedBy: 2 },
      { id: "tiny:lib/consts.ts", importedBy: 1 },
      { id: "tiny:lib/render.ts", importedBy: 1 },
      { id: "tiny:lib/body.ts", importedBy: 1 },
      { id: "tiny:lib/camera.ts", importedBy: 1 },
    ],
    entryPoints: [],
    view: "#lib~",
  };
  // the ID form is how the viewer's Agent tab calls it
  for (const c of ["lib", "lib/", "tiny:lib/"])
    expect(
      JSON.stringify(
        answer(
          queryOverview(openTiny(), { repo: "tiny", component: c }, TINY_CTX),
        ),
      ),
    ).toBe(JSON.stringify(want));
  expect(
    error(
      queryOverview(
        openTiny(),
        { repo: "tiny", component: "lib/orbit.ts" },
        TINY_CTX,
      ),
    ),
  ).toMatchObject({
    code: "invalid_argument",
    field: "component",
    hint: "code_explain explains files and definitions",
  });
});

describe("a component", () => {
  const s = openTiny();
  const c = (component: string) =>
    queryOverview(s, { repo: "tiny", component }, TINY_CTX);

  it("lists its entry points as file IDs", () => {
    expect(asComponent(c("app"))).toMatchObject({
      id: "tiny:app/",
      files: 1,
      tests: 0,
      core: [{ id: "tiny:app/main.ts", importedBy: 1 }],
      entryPoints: ["tiny:app/main.ts"],
      view: "#app~",
    });
    expect(asComponent(c("tiny:scripts/")).entryPoints).toEqual([
      "tiny:scripts/sync-",
    ]);
  });

  it("refuses what is not a component, and passes on what resolution answers", () => {
    const takes = "code_overview takes a component";
    expect(error(c("lib/orbit.ts#solve"))).toEqual({
      code: "invalid_argument",
      message: `component is a definition; ${takes}`,
      field: "component",
      hint: "code_explain explains files and definitions",
    });
    expect(error(c("tiny:"))).toEqual({
      code: "invalid_argument",
      message: `component is a repo; ${takes}`,
      field: "component",
      hint: "code_overview without component describes the repo",
    });
    expect(error(c("tiny:npm:react"))).toEqual({
      code: "invalid_argument",
      message: `component is a library; ${takes}`,
      field: "component",
      hint: "code_references lists a library's importers",
    });
    expect(error(c("tiny:nope/"))).toMatchObject({
      code: "not_found",
      field: "component",
      hint: "code_overview lists the components",
    });
    expect(error(c("main")).code).toBe("ambiguous");
  });
});

// A store of repo "y" for the repo answer's caps and orders: 14 components, a/ holding only a
// test, and c00/ … c12/ one production file m.ts each, ranked 2, 1, then 3 … 13; c00/ also
// holds the entry points e0.ts … e6.ts, ranked 26 down to 20.
const Y_CTX: QueryCtx = Object.freeze({
  repo: "y",
  builtCommit: "fedcba987654",
  stale: false,
  snippets: true,
});
const range = (n: number) => Array.from({ length: n }, (_, k) => k);
const cNN = (n: number) => `c${String(n).padStart(2, "0")}/`;
const HOT = [0.35, 1, 0.9, 0.9, 0.5, 0.5, 0.4, 0.4, 0.36, 0.34, 0, 0, 0];

function capsStore(): Store {
  const c = emptyContent("y");
  const files: {
    path: string;
    kind: FileKind;
    rank: number | null;
    hotspot: number | null;
    entry: 0 | 1;
    core: 0 | 1;
    churn: number;
  }[] = [
    {
      path: "a/t.test.ts",
      kind: "test",
      rank: null,
      hotspot: null,
      entry: 0,
      core: 0,
      churn: 0,
    },
    ...range(13).map((n) => ({
      path: `${cNN(n)}m.ts`,
      kind: "code" as const,
      rank: n === 0 ? 2 : n === 1 ? 1 : n + 1,
      hotspot: HOT[n] ?? 0,
      entry: n === 0 ? (0 as const) : (1 as const),
      core: 1 as const,
      churn: 10 + n,
    })),
    ...range(7).map((k) => ({
      path: `c00/e${k}.ts`,
      kind: "code" as const,
      rank: 26 - k,
      hotspot: 0,
      entry: 1 as const,
      core: 0 as const,
      churn: 0,
    })),
    {
      path: "package.json",
      kind: "config",
      rank: null,
      hotspot: null,
      entry: 0,
      core: 0,
      churn: 0,
    },
  ];
  files.sort((a, b) => comparePaths(a.path, b.path));
  const id = (path: string) => files.findIndex((f) => f.path === path) + 1;
  const components = ["a/", ...range(13).map(cNN)];
  const componentOf = (path: string) =>
    components.indexOf(path.slice(0, path.indexOf("/") + 1)) + 1;
  const inComponent = (path: string, kind: FileKind) =>
    files.filter((f) => f.kind === kind && f.path.startsWith(path)).length;
  c.components = components.map((path, i) => ({
    id: i + 1,
    path,
    kind: "folder",
    parent_id: null,
    files: inComponent(path, "code"),
    tests: inComponent(path, "test"),
    lines: inComponent(path, "code") + inComponent(path, "test"),
  }));
  c.files = files.map((f, i) => ({
    id: i + 1,
    path: f.path,
    lang: f.kind === "config" ? null : "typescript",
    kind: f.kind,
    component_id: f.kind === "config" ? null : componentOf(f.path),
    lines: 1,
    bytes: 30,
    blob_sha: "c".repeat(40),
    mode: "100644",
    link_target: null,
    entry: f.entry,
    has_source: 0,
  }));
  // cycles 1 … 6 pair c00/ and c01/, …, c10/ and c11/; cycle 7 pairs e0.ts and e1.ts
  const cycles = [
    ...range(6).map((k) => [`${cNN(2 * k)}m.ts`, `${cNN(2 * k + 1)}m.ts`]),
    ["c00/e0.ts", "c00/e1.ts"],
  ];
  const cycleOf = (path: string) =>
    cycles.findIndex((pair) => pair.includes(path)) + 1 || null;
  c.file_metrics = files.flatMap((f, i) =>
    f.kind === "config"
      ? []
      : [
          {
            file_id: i + 1,
            pagerank: f.rank === null ? null : 0.01,
            dependents_rank: f.rank,
            fan_in: 1,
            fan_out: 1,
            churn_90d: f.churn,
            hotspot: f.hotspot,
            cycle_id: cycleOf(f.path),
            core: f.core,
            last_change: null,
          },
        ],
  );
  c.cycles = cycles.flatMap((pair, k) =>
    pair.map((path, ord) => ({
      cycle_id: k + 1,
      ord,
      file_id: id(path),
      line: 1,
    })),
  );
  const main = id("c01/m.ts");
  c.definitions = [
    {
      id: 1,
      file_id: main,
      qualname: "main",
      ordinal: 1,
      name: "main",
      kind: "function",
      start_line: 1,
      start_col: 1,
      end_line: 1,
      end_col: 2,
      exported: 1,
      parent_id: null,
      scip_symbol: null,
      signature: null,
      producer: "ast-grep",
    },
  ];
  c.def_metrics = [
    {
      def_id: 1,
      used_by_files: 0,
      used_by_files_bound: 0,
      mentioned_by_tests: 0,
    },
  ];
  c.externals = [{ id: 1, ecosystem: "npm", name: "left-pad", files: 1 }];
  const m = (n: number) => id(`${cNN(n)}m.ts`);
  // source, imported file, imported library, line
  const imports: [number, number | null, number | null, number][] = [
    ...range(12).map((n): [number, number, null, number] => [
      m(n),
      m(n + 1),
      null,
      1,
    ]),
    [m(0), m(1), null, 2], // c00/ imports c01/ twice
    [m(1), m(0), null, 2],
    [id("a/t.test.ts"), m(0), null, 1], // from a test
    [id("c00/e0.ts"), m(0), null, 1], // inside one component
    [m(2), id("a/t.test.ts"), null, 2], // to a test
    [m(5), null, 1, 2], // to a library
  ];
  imports.sort((a, b) => a[0] - b[0] || a[3] - b[3]);
  c.imports = imports.map(([src, dst, ext, line], i) => ({
    id: i + 1,
    src_file_id: src,
    dst_file_id: dst,
    dst_external_id: ext,
    kind: "static",
    line,
    specifier: "./x",
    resolved: 1,
    producer: "dependency-cruiser",
  }));
  const pkg = id("package.json");
  // file, definition, kind, manifest file, manifest line, name
  const entries: [number, number | null, EntryKind, number, number, string][] =
    [
      [main, null, "bin", pkg, 9, "b9"],
      [main, null, "bin", pkg, 3, "b3"],
      [main, 1, "console-script", pkg, 4, "main"],
      [main, null, "dev-script", pkg, 6, "test"],
      ...range(11).map(
        (k): [number, null, EntryKind, number, number, string] => [
          m(k + 2),
          null,
          "bin",
          pkg,
          k + 12,
          `b${k + 2}`,
        ],
      ),
      ...range(7).map(
        (k): [number, null, EntryKind, number, number, string] => [
          id(`c00/e${k}.ts`),
          null,
          "executable",
          id(`c00/e${k}.ts`),
          1,
          `c00/e${k}.ts`,
        ],
      ),
    ];
  entries.sort(
    (a, b) =>
      a[0] - b[0] ||
      comparePaths(a[2], b[2]) ||
      a[3] - b[3] ||
      a[4] - b[4] ||
      comparePaths(a[5], b[5]),
  );
  c.entry_points = entries.map(([file, def, kind, manifest, line, name]) => ({
    file_id: file,
    def_id: def,
    kind,
    manifest_file_id: manifest,
    manifest_line: line,
    name,
  }));
  const store = openStore(miniStore(c));
  if ("code" in store) throw new Error(`the caps store: ${store.reason}`);
  return store;
}

describe("the repo answer's caps and orders", () => {
  const ys = capsStore();
  const a = asRepo(queryOverview(ys, { repo: "y" }, Y_CTX));
  // by rank: c01/m.ts, c00/m.ts, then c02/m.ts … c12/m.ts
  const byRank = [1, 0, ...range(11).map((k) => k + 2)];

  it("counts files, tests and lines over code and tests only", () =>
    expect(a).toMatchObject({
      id: "y:",
      files: 20,
      tests: 1,
      lines: 21,
      languages: { typescript: 21 },
    }));

  it("lists 12 core files by rank", () =>
    expect(a.coreSet).toEqual({
      files: 13,
      ofFiles: 20,
      share: 0.5,
      top: byRank.slice(0, 12).map((n, i) => ({
        id: `y:${cNN(n)}m.ts`,
        dependentsRank: i + 1,
        importedBy: 1,
      })),
    }));

  it("lists 12 components by their best rank, nulls last", () => {
    expect(a.components.total).toBe(14);
    expect(a.components.top.map((x) => x.id)).toEqual(
      byRank.slice(0, 12).map((n) => `y:${cNN(n)}`),
    );
    expect(a.components.top[1]).toEqual({
      id: "y:c00/",
      files: 8,
      tests: 0,
      coreFiles: 1,
      entryPoints: 7,
    });
  });

  it("counts imports between components, production only, 12 by count and path", () =>
    expect(a.dependsOn).toEqual({
      total: 13,
      top: [
        { from: "y:c00/", to: "y:c01/", imports: 2 },
        { from: "y:c01/", to: "y:c00/", imports: 1 },
        ...range(10).map((k) => ({
          from: `y:${cNN(k + 1)}`,
          to: `y:${cNN(k + 2)}`,
          imports: 1,
        })),
      ],
    }));

  it("lists 12 entry points by rank, path, kind and line, without dev scripts", () =>
    expect(a.entryPoints).toEqual({
      total: 21,
      top: [
        { id: "y:c01/m.ts", kind: "bin", via: "y:package.json", line: 3 },
        { id: "y:c01/m.ts", kind: "bin", via: "y:package.json", line: 9 },
        {
          id: "y:c01/m.ts#main",
          kind: "console-script",
          via: "y:package.json",
          line: 4,
        },
        ...range(9).map((k) => ({
          id: `y:${cNN(k + 2)}m.ts`,
          kind: "bin",
          via: "y:package.json",
          line: k + 12,
        })),
      ],
    }));

  it("lists 8 hotspots from 0.35, by score and then path", () =>
    expect(a.hotspots).toEqual({
      total: 9,
      top: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
        id: `y:${cNN(n)}m.ts`,
        hotspot: HOT[n],
        commits90d: 10 + n,
      })),
    }));

  it("lists the first 6 cycles by id, each in chain order", () =>
    expect(a.cycles).toEqual({
      total: 7,
      top: range(6).map((k) => [
        `y:${cNN(2 * k)}m.ts`,
        `y:${cNN(2 * k + 1)}m.ts`,
      ]),
    }));

  it("lists a component's 6 core files and 6 entry points by rank", () =>
    expect(
      asComponent(queryOverview(ys, { repo: "y", component: "c00" }, Y_CTX)),
    ).toEqual({
      id: "y:c00/",
      kind: "component",
      builtCommit: "fedcba987654",
      stale: false,
      files: 8,
      tests: 0,
      core: [
        { id: "y:c00/m.ts", importedBy: 1 },
        ...[6, 5, 4, 3, 2].map((k) => ({
          id: `y:c00/e${k}.ts`,
          importedBy: 1,
        })),
      ],
      entryPoints: [6, 5, 4, 3, 2, 1].map((k) => `y:c00/e${k}.ts`),
      view: "#c00~",
    }));
});
