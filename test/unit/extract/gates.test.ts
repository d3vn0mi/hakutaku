import { expect, it } from "vitest";
import {
  type GateInput,
  runGates,
  storedTexts,
} from "../../../src/extract/gates.js";
import type { MergedContent } from "../../../src/extract/merge/index.js";
import type { FileRow, GateResult } from "../../../src/store/index.js";

const join = (...parts: string[]) => parts.join("");

type File = Pick<FileRow, "path" | "kind" | "lang">;

const code = (path: string, lang: string): File => ({
  path,
  kind: "code",
  lang,
});
const py = (path: string): File => code(path, "python");
const ts = (path: string): File => code(path, "typescript");

// A build whose every gate passes: no files, no imports, no SCIP, nothing stored.
function input(over: Partial<GateInput> = {}): GateInput {
  return {
    files: [],
    regularPaths: [],
    metadataOnly: [],
    python: { roots: [], singleFileModules: [] },
    indexed: new Map(),
    scip: null,
    relative: { total: 0, unresolved: 0 },
    maxUnresolvedRelativeImports: 0.005,
    currentUnresolved: null,
    denylistExtra: [],
    redactions: 0,
    texts: [],
    ...over,
  };
}

// Files given as rows, each also a regular file of the tree.
const withFiles = (files: File[], over: Partial<GateInput> = {}): GateInput =>
  input({ files, regularPaths: files.map((f) => f.path), ...over });

const gate = (results: GateResult[], name: GateResult["gate"]): GateResult => {
  const found = results.find((g) => g.gate === name);
  if (found === undefined) throw new Error(`no ${name} gate`);
  return found;
};

it("runs the five gates in their order, all passing on an empty build", () => {
  expect(runGates(input())).toEqual([
    {
      gate: "files-indexed",
      ok: true,
      detail: "no TypeScript, JavaScript or Python files",
    },
    {
      gate: "unresolved-imports",
      ok: true,
      detail: "0 of 0 relative imports unresolved (0.00%); limit 0.50%",
    },
    {
      gate: "scip-duplicates",
      ok: true,
      detail: "scip-typescript did not run",
    },
    { gate: "denylist", ok: true, detail: "0 denylisted paths" },
    { gate: "redaction", ok: true, detail: "ran; 0 redactions; re-scan clean" },
  ]);
});

it("fails files-indexed for a Python package outside every root, naming it", () => {
  const results = runGates(
    withFiles(
      [
        py("sim/src/observatory/__init__.py"),
        py("sim/src/observatory/orbit.py"),
        py("tools/sky/__init__.py"),
        py("tools/sky/chart.py"),
      ],
      { python: { roots: ["sim/src"], singleFileModules: [] } },
    ),
  );
  expect(gate(results, "files-indexed")).toEqual({
    gate: "files-indexed",
    ok: false,
    detail: "python 2/4: missing tools/sky/__init__.py, tools/sky/chart.py",
  });
});

it("lists each language with files, in path order, when every file is indexed", () => {
  const files = [
    py("sim/src/observatory/__init__.py"),
    py("sim/src/observatory/orbit.py"),
    code("web/scripts/build.mjs", "javascript"),
    ts("web/src/orbit.ts"),
    ts("web/src/sky.tsx"),
  ];
  const results = runGates(
    withFiles(files, {
      python: { roots: ["sim/src"], singleFileModules: [] },
      indexed: new Map([
        ["javascript", new Set(["web/scripts/build.mjs"])],
        ["typescript", new Set(["web/src/orbit.ts", "web/src/sky.tsx"])],
      ]),
      scip: {
        documents: new Set([
          "web/scripts/build.mjs",
          "web/src/orbit.ts",
          "web/src/sky.tsx",
        ]),
        duplicates: [],
      },
    }),
  );
  expect(gate(results, "files-indexed")).toEqual({
    gate: "files-indexed",
    ok: true,
    detail: "javascript 1/1, python 2/2, typescript 2/2",
  });
});

it("expects the TS and JS files TypeScript's include lists, each in indexed and among SCIP's documents", () => {
  const files: File[] = [
    ts("web/src/orbit.ts"),
    ts("web/src/sky.ts"),
    ts("web/src/units.ts"),
    // never read by an engine: a dot directory, node_modules, a dot file, a .min.js, a
    // metadata-only file, a test fixture that is not code
    ts(".storybook/main.ts"),
    code("web/node_modules/kepler/index.js", "javascript"),
    ts("web/src/.eslintrc.ts"),
    code("web/vendor/sky.min.js", "javascript"),
    ts("web/src/generated.ts"),
    { path: "web/src/blob.ts", kind: "other", lang: null },
  ];
  const results = runGates(
    withFiles(files, {
      metadataOnly: ["web/src/generated.ts"],
      indexed: new Map([
        ["typescript", new Set(["web/src/orbit.ts", "web/src/units.ts"])],
      ]),
      scip: {
        documents: new Set(["web/src/orbit.ts", "web/src/sky.ts"]),
        duplicates: [],
      },
    }),
  );
  expect(gate(results, "files-indexed")).toEqual({
    gate: "files-indexed",
    ok: false,
    detail: "typescript 1/3: missing web/src/sky.ts, web/src/units.ts",
  });
});

it("expects no config or doc file to be indexed, whatever its language", () => {
  const files: File[] = [
    ts("web/src/orbit.ts"),
    py("sim/src/observatory/__init__.py"),
    { path: "web/vite.config.ts", kind: "config", lang: "typescript" },
    { path: "web/eslint.config.mjs", kind: "config", lang: "javascript" },
    { path: "sim/src/observatory/conf.py", kind: "config", lang: "python" },
    { path: "docs/example.ts", kind: "doc", lang: "typescript" },
  ];
  const results = runGates(
    withFiles(files, {
      python: { roots: ["sim/src"], singleFileModules: [] },
      indexed: new Map([["typescript", new Set(["web/src/orbit.ts"])]]),
    }),
  );
  expect(gate(results, "files-indexed")).toEqual({
    gate: "files-indexed",
    ok: true,
    detail: "python 1/1, typescript 1/1",
  });
});

it("expects the Python files an import statement can name, and the declared single-file modules", () => {
  const files: File[] = [
    // a package under the root: expected and named
    py("sim/src/observatory/__init__.py"),
    py("sim/src/observatory/orbit.py"),
    // not nameable by any import statement, so never expected
    py("sim/src/observatory/migrations/__init__.py"),
    py("sim/src/observatory/migrations/0001_initial.py"),
    py("sim/src/observatory/sky-chart.py"),
    py("tools/sky-tool/__init__.py"),
    py("tools/sky-tool/run.py"),
    py("sim/src/observatory/orbit.pyi"),
    // the repo top is never a package
    py("__init__.py"),
    py("setup.py"),
    // a loose script outside any package, under the root but not declared
    py("scripts/rebuild.py"),
    py("sim/src/orbit_tools.py"),
    // declared single-file modules: one named, one whose name the root's orbit_tools takes
    py("sim/ephemeris.py"),
    py("sim/orbit_tools.py"),
  ];
  const results = runGates(
    withFiles(files, {
      python: {
        roots: ["sim/src"],
        singleFileModules: ["sim/ephemeris.py", "sim/orbit_tools.py"],
      },
    }),
  );
  // expected: the package's __init__.py, orbit.py and migrations/__init__.py, and the two
  // declared modules
  expect(gate(results, "files-indexed")).toEqual({
    gate: "files-indexed",
    ok: false,
    detail: "python 4/5: missing sim/orbit_tools.py",
  });
});

it("passes 0.5% and fails above it, with the exact wording", () => {
  const at = (unresolved: number): GateResult =>
    gate(
      runGates(input({ relative: { total: 400, unresolved } })),
      "unresolved-imports",
    );
  expect(at(2)).toEqual({
    gate: "unresolved-imports",
    ok: true,
    detail: "2 of 400 relative imports unresolved (0.50%); limit 0.50%",
  });
  expect(at(3)).toEqual({
    gate: "unresolved-imports",
    ok: false,
    detail: "3 of 400 relative imports unresolved (0.75%); limit 0.50%",
  });
});

it("fails when unresolved imports grow from the current store", () => {
  const at = (currentUnresolved: number | null): GateResult =>
    gate(
      runGates(
        input({ relative: { total: 1000, unresolved: 4 }, currentUnresolved }),
      ),
      "unresolved-imports",
    );
  expect(at(2)).toEqual({
    gate: "unresolved-imports",
    ok: false,
    detail: "4 unresolved relative imports, up from 2 in the current store",
  });
  const passing = {
    gate: "unresolved-imports",
    ok: true,
    detail: "4 of 1000 relative imports unresolved (0.40%); limit 0.50%",
  };
  expect(at(4)).toEqual(passing);
  expect(at(null)).toEqual(passing);
  // over the share and grown: the share is named
  expect(
    gate(
      runGates(
        input({
          relative: { total: 100, unresolved: 4 },
          currentUnresolved: 2,
          maxUnresolvedRelativeImports: 0,
        }),
      ),
      "unresolved-imports",
    ),
  ).toEqual({
    gate: "unresolved-imports",
    ok: false,
    detail: "4 of 100 relative imports unresolved (4.00%); limit 0.00%",
  });
});

it("fails on a denylisted path and on a secret the re-scan finds", () => {
  const key = join("AKIA", "Q3EGRT7V2XKM5NPL");
  const files: File[] = [
    { path: "data/private/stars.csv", kind: "other", lang: null },
    { path: "sim/.env", kind: "config", lang: null },
    ts("web/src/api.ts"),
  ];
  const results = runGates(
    withFiles(files, {
      denylistExtra: ["data/private/**"],
      redactions: 3,
      texts: [
        {
          path: "web/src/api.ts",
          line: 1,
          text: `a\nb\nconst id = "${key}";\n`,
        },
        { path: "web/src/api.ts", line: 3, text: `const id = "${key}";` },
        { path: "web/src/sky.ts", line: 7, text: "drawSky(stars)" },
      ],
    }),
  );
  expect(gate(results, "denylist")).toEqual({
    gate: "denylist",
    ok: false,
    detail: "2 denylisted paths: data/private/stars.csv, sim/.env",
  });
  expect(gate(results, "redaction")).toEqual({
    gate: "redaction",
    ok: false,
    detail:
      "re-scan found 2: web/src/api.ts:3 aws-access-key-id, web/src/api.ts:3 aws-access-key-id",
  });
  // without them, both pass and the redactions are counted
  const clean = runGates(
    withFiles([ts("web/src/api.ts")], {
      redactions: 3,
      texts: [{ path: "web/src/api.ts", line: 1, text: "const id = 1;\n" }],
    }),
  );
  expect(gate(clean, "denylist").ok).toBe(true);
  expect(gate(clean, "redaction")).toEqual({
    gate: "redaction",
    ok: true,
    detail: "ran; 3 redactions; re-scan clean",
  });
});

it("names at most five paths in path order, then counts the rest", () => {
  // given in reverse, so only a sort names the first five
  const files = Array.from({ length: 7 }, (_, i) =>
    ts(`web/src/f${i}.ts`),
  ).reverse();
  const results = runGates(
    withFiles(
      [...files, { path: "secrets/a.txt", kind: "other", lang: null }],
      {
        texts: files.map((f) => ({
          path: f.path,
          line: 2,
          text: join("AKIA", "Q3EGRT7V2XKM5NPL"),
        })),
      },
    ),
  );
  expect(gate(results, "files-indexed").detail).toBe(
    "typescript 0/7: missing web/src/f0.ts, web/src/f1.ts, web/src/f2.ts, web/src/f3.ts, web/src/f4.ts",
  );
  expect(gate(results, "redaction").detail).toBe(
    "re-scan found 7: web/src/f0.ts:2 aws-access-key-id, web/src/f1.ts:2 aws-access-key-id, web/src/f2.ts:2 aws-access-key-id, web/src/f3.ts:2 aws-access-key-id, web/src/f4.ts:2 aws-access-key-id",
  );
  expect(gate(results, "denylist").detail).toBe(
    "1 denylisted paths: secrets/a.txt",
  );
});

it("reports scip-typescript did not run at quick detail", () => {
  const results = runGates(withFiles([ts("web/src/orbit.ts")]));
  expect(gate(results, "scip-duplicates")).toEqual({
    gate: "scip-duplicates",
    ok: true,
    detail: "scip-typescript did not run",
  });
  // where it ran: none, or the first duplicate in path order
  const ran = (duplicates: string[]): GateResult =>
    gate(
      runGates(input({ scip: { documents: new Set(), duplicates } })),
      "scip-duplicates",
    );
  expect(ran([])).toEqual({
    gate: "scip-duplicates",
    ok: true,
    detail: "0 duplicate symbols",
  });
  expect(
    ran([
      "scip-typescript npm . . src/`orbit.ts`/Orbit#",
      "scip-typescript npm . . src/`index.ts`/",
    ]),
  ).toEqual({
    gate: "scip-duplicates",
    ok: false,
    detail: "2 duplicate symbols, e.g. scip-typescript npm . . src/`index.ts`/",
  });
});

it("re-scans every stored text, external names and link targets among them, each where it is read", () => {
  const file = (id: number, path: string, link: string | null = null) => ({
    id,
    path,
    lang: null,
    kind: "code" as const,
    component_id: null,
    lines: 1,
    bytes: 1,
    blob_sha: "0".repeat(40),
    mode: link === null ? ("100644" as const) : ("120000" as const),
    link_target: link,
    entry: 0 as const,
    has_source: 0 as const,
  });
  const content = {
    files: [file(1, "keys/current", "../vault/sky"), file(2, "web/a.ts")],
    sources: [],
    definitions: [],
    call_sites: [],
    entry_points: [],
    text_index: [],
    externals: [{ id: 1, ecosystem: "npm", name: "orbit-kit", files: 1 }],
    imports: [
      {
        id: 1,
        src_file_id: 2,
        dst_file_id: null,
        dst_external_id: 1,
        kind: "static",
        line: 3,
        specifier: "orbit-kit/sub",
        resolved: 1,
        producer: "ast-grep",
      },
    ],
  } as unknown as MergedContent;
  expect([...storedTexts(content)]).toEqual([
    { path: "web/a.ts", line: 3, text: "orbit-kit/sub" },
    { path: "web/a.ts", line: 3, text: "orbit-kit" },
    { path: "keys/current", line: 1, text: "../vault/sky" },
  ]);
  // so a secret in either fails the gate rather than reaching the store unseen
  const leaked = runGates(
    input({
      texts: storedTexts({
        ...content,
        externals: [
          {
            id: 1,
            ecosystem: "npm",
            name: join("gh", "p_", "Q7x2M4p9K3l8N5r6".repeat(3)),
            files: 1,
          },
        ],
      } as MergedContent),
    }),
  );
  expect(gate(leaked, "redaction")).toMatchObject({
    ok: false,
    detail: "re-scan found 1: web/a.ts:3 github-token",
  });
});
