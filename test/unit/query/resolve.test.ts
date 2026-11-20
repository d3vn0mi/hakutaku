import { describe, expect, it } from "vitest";
import { comparePaths, type DefKind } from "../../../src/model/index.js";
import {
  KIND_NAME,
  matchLevel,
  type Resolved,
  resolveTarget,
  wrongKind,
} from "../../../src/query/index.js";
import {
  openStore,
  type Store,
  type StoreContent,
} from "../../../src/store/index.js";
import type { ToolError } from "../../../src/tools/errors.js";
import { emptyContent, miniStore } from "../../helpers/mini-store.js";
import { openTiny } from "../../helpers/tiny.js";

// Appends n code files a00.ts … and, in each, one function named run, in the store's row orders.
function withRuns(c: StoreContent, n: number): StoreContent {
  for (let i = 0; i < n; i++) {
    const id = c.files.length + 1;
    c.files.push({
      id,
      path: `a${String(i).padStart(2, "0")}.ts`,
      lang: "typescript",
      kind: "code",
      component_id: null,
      lines: 1,
      bytes: 30,
      blob_sha: "c".repeat(40),
      mode: "100644",
      link_target: null,
      entry: 0,
      has_source: 0,
    });
    c.definitions.push({
      id: c.definitions.length + 1,
      file_id: id,
      qualname: "run",
      ordinal: 1,
      name: "run",
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
    });
  }
  return c;
}

// A store of repo "x": code files, definitions as [path, qualname, kind, line], folder
// components and renames, with ids in the store's row orders.
function storeOf(spec: {
  files: readonly string[];
  defs?: readonly (readonly [string, string, DefKind, number])[];
  components?: readonly string[];
  renames?: readonly (readonly [string, string])[];
}): Store {
  const c = emptyContent("x");
  const paths = [...spec.files].sort(comparePaths);
  c.components = [...(spec.components ?? [])]
    .sort(comparePaths)
    .map((path, i) => ({
      id: i + 1,
      path,
      kind: "folder",
      parent_id: null,
      files: 0,
      tests: 0,
      lines: 0,
    }));
  c.files = paths.map((path, i) => ({
    id: i + 1,
    path,
    lang: "typescript",
    kind: "code",
    component_id: null,
    lines: 10,
    bytes: 300,
    blob_sha: "c".repeat(40),
    mode: "100644",
    link_target: null,
    entry: 0,
    has_source: 0,
  }));
  c.definitions = (spec.defs ?? [])
    .map(([path, qualname, kind, line]) => ({
      file: paths.indexOf(path) + 1,
      qualname,
      kind,
      line,
    }))
    .sort(
      (a, b) =>
        a.file - b.file ||
        a.line - b.line ||
        comparePaths(a.qualname, b.qualname),
    )
    .map((d, i) => ({
      id: i + 1,
      file_id: d.file,
      qualname: d.qualname,
      ordinal: 1,
      name: d.qualname.slice(d.qualname.lastIndexOf(".") + 1),
      kind: d.kind,
      start_line: d.line,
      start_col: 1,
      end_line: d.line,
      end_col: 2,
      exported: 1,
      parent_id: null,
      scip_symbol: null,
      signature: null,
      producer: "ast-grep",
    }));
  c.renames = [...(spec.renames ?? [])]
    .sort((a, b) => comparePaths(a[0], b[0]) || comparePaths(a[1], b[1]))
    .map(([old_path, new_path]) => ({
      old_path,
      new_path,
      commit_sha: "b".repeat(40),
    }));
  return openStore(miniStore(c)) as Store;
}

const err = (x: Resolved | ToolError): ToolError => x as ToolError;
const ids = (x: Resolved | ToolError): string[] =>
  (err(x).candidates ?? []).map((c) => c.id);

const s = openTiny();
const r = (t: string, f = "target") => resolveTarget(s, "tiny", t, f);

it("resolves a full ID", () =>
  expect(r("tiny:lib/orbit.ts#Orbit.position")).toMatchObject({
    kind: "definition",
    defId: 11,
    fileId: 9,
  }));
it("resolves a percent-encoded path", () =>
  expect(r("tiny:lib/odd %231%3A%25.ts")).toMatchObject({
    kind: "file",
    fileId: 7,
  }));
it("resolves path#qualname and ordinals", () => {
  expect(r("py/pkg/util.py#helper(2)")).toMatchObject({ defId: 15 });
  expect(r("tiny:py/pkg/util.py#helper(2)")).toMatchObject({ defId: 15 });
  expect(r("py/pkg/util.py#helper")).toMatchObject({ defId: 14 });
  expect(r("lib/orbit.ts#position")).toMatchObject({ defId: 11 }); // by short name, one match in the file
});
it("module scope resolves to the file", () => {
  expect(r("lib/orbit.test.ts#<module>")).toMatchObject({
    kind: "file",
    fileId: 8,
  });
  expect(r("tiny:lib/orbit.test.ts#<module>")).toMatchObject({
    kind: "file",
    fileId: 8,
  });
});
it("resolves bare names, components, externals and the repo", () => {
  expect(r("solve")).toMatchObject({ kind: "definition", defId: 9 });
  expect(r("lib")).toMatchObject({ kind: "directory", componentId: 2 });
  expect(r("lib/")).toMatchObject({ kind: "directory", componentId: 2 });
  expect(r("tiny:npm:react")).toMatchObject({
    kind: "external",
    externalId: 2,
  });
  expect(r("tiny:")).toMatchObject({ kind: "repo" });
});
it("answers ambiguous with candidates by rank", () => {
  expect(r("position", "symbol")).toEqual({
    code: "ambiguous",
    message: "2 definitions are named position",
    candidates: [
      { id: "tiny:lib/orbit.ts#Orbit.position", kind: "method", line: 12 },
      { id: "tiny:lib/camera.ts#Camera.position", kind: "method", line: 2 },
    ],
    hint: "pass one candidate id as symbol",
  });
  expect(r("main")).toMatchObject({
    code: "ambiguous",
    candidates: [
      { id: "tiny:app/main.ts#main" },
      { id: "tiny:scripts/sync-#main" },
    ],
  });
  expect(r("helper")).toMatchObject({
    code: "ambiguous",
    candidates: [
      { id: "tiny:py/pkg/util.py#helper" },
      { id: "tiny:py/pkg/util.py#helper(2)" },
    ],
  });
});
it("caps candidates at 20 and keeps the full count", () => {
  const c = emptyContent("many"); // + 25 code files a00.ts … a24.ts, each defining function `run` (rows built in the test)
  const m = openStore(miniStore(withRuns(c, 25))) as Store;
  const e = resolveTarget(m, "many", "run", "symbol") as ToolError;
  expect(e.code).toBe("ambiguous");
  expect(e.candidates).toHaveLength(20);
  expect(e.message).toBe("25 definitions are named run");
  expect(e.hint).toBe(
    "pass one candidate id as symbol; code_find lists all 25",
  );
});
it("refuses another repo's ID", () => {
  expect(r("other:lib/orbit.ts")).toEqual({
    code: "invalid_argument",
    message: "target is an ID of another repo (other)",
    field: "target",
    hint: "pass an ID of tiny, a repo-relative path, or a name",
  });
  expect(r("npm:react")).toMatchObject({ code: "invalid_argument" }); // the ID form needs the repo: tiny:npm:react
});
it("offers renames and the same qualname elsewhere", () => {
  expect(r("lib/kepler.ts")).toMatchObject({
    code: "not_found",
    candidates: [{ id: "tiny:lib/orbit.ts", kind: "file" }],
  });
  expect(r("tiny:lib/kepler.ts#solve")).toMatchObject({
    code: "not_found",
    candidates: [{ id: "tiny:lib/orbit.ts#solve", kind: "function", line: 3 }],
  });
});
it("is exact: case differences are candidates, never matches", () => {
  expect(r("Solve")).toMatchObject({
    code: "not_found",
    candidates: [{ id: "tiny:lib/orbit.ts#solve" }],
  });
  expect(r("lib/Orbit.ts")).toMatchObject({
    code: "not_found",
    candidates: [{ id: "tiny:lib/orbit.ts" }],
  });
});
it("refuses denylisted paths", () => {
  for (const t of [".env", "lib/.env.local", "tiny:secrets/x.txt"])
    expect(r(t)).toMatchObject({ code: "denied_file" });
});
it("never resolves paths, URLs or globs from outside the store", () => {
  for (const t of [
    "/etc/passwd",
    "../../etc/passwd",
    "file:///etc/passwd",
    "https://example.com/x",
    "lib/*.ts",
    "~/.ssh/id_rsa",
  ])
    expect(["not_found", "invalid_argument", "denied_file"]).toContain(
      (r(t) as ToolError).code,
    );
});

describe("what a resolved target carries", () => {
  it("gives the node's ref", () => {
    expect(r("lib")).toEqual({
      kind: "directory",
      componentId: 2,
      ref: { kind: "directory", repo: "tiny", path: "lib/" },
    });
    expect(r("solve")).toEqual({
      kind: "definition",
      defId: 9,
      fileId: 9,
      ref: {
        kind: "definition",
        repo: "tiny",
        path: "lib/orbit.ts",
        qualname: "solve",
        ordinal: 1,
      },
    });
    expect(r("tiny:")).toEqual({
      kind: "repo",
      ref: { kind: "repo", repo: "tiny" },
    });
    expect(r("tiny:node:fs")).toEqual({
      kind: "external",
      externalId: 1,
      ref: { kind: "external", repo: "tiny", ecosystem: "node", name: "fs" },
    });
  });
  it("resolves module scope to its file, with or without a module row", () => {
    const file = {
      kind: "file",
      fileId: 9,
      ref: { kind: "file", repo: "tiny", path: "lib/orbit.ts" },
    };
    expect(r("lib/orbit.ts#<module>")).toEqual(file);
    expect(r("tiny:lib/orbit.ts#<module>")).toEqual(file);
    expect(r("tiny:lib/orbit.test.ts#<module>")).toMatchObject({
      ref: { kind: "file", path: "lib/orbit.test.ts" },
    });
  });
  it("matches a bare name against qualnames, names, file names and component paths", () => {
    expect(r("Orbit.position")).toMatchObject({ defId: 11 });
    expect(r("README.md")).toMatchObject({ kind: "file", fileId: 1 });
    expect(r("orbit.ts")).toMatchObject({ kind: "file", fileId: 9 });
    expect(r("sync-")).toMatchObject({ kind: "file", fileId: 15 });
    expect(r("app/main.ts")).toMatchObject({ kind: "file", fileId: 2 });
    expect(r("py/pkg")).toMatchObject({ code: "not_found" }); // a folder that is no component
  });
});

describe("when a target is not in the store", () => {
  it("names the field and the target, and hints where to look", () => {
    expect(r("lib/nope.ts")).toEqual({
      code: "not_found",
      message: "target lib/nope.ts is not in the store",
      field: "target",
      hint: "code_find searches by name",
    });
    for (const t of ["tiny:nope/", "lib/nope/"])
      expect(r(t)).toEqual({
        code: "not_found",
        message: `target ${t} is not in the store`,
        field: "target",
        hint: "code_overview lists the components",
      });
    expect(r("tiny:npm:vue", "file")).toEqual({
      code: "not_found",
      message: "file tiny:npm:vue is not in the store",
      field: "file",
      hint: "code_deps with direction out lists a file's imports and their IDs",
    });
    expect(r("lib/kepler.ts")).toMatchObject({
      field: "target",
      hint: "pass one candidate id as target",
    });
  });
  it("words a denied target by the path it checked", () => {
    expect(r(".env")).toEqual({
      code: "denied_file",
      message: ".env is denylisted and was never stored",
    });
    expect(err(r("tiny:secrets/x.txt")).message).toBe(
      "secrets/x.txt is denylisted and was never stored",
    );
    expect(err(r("tiny:secrets/x.txt#f")).message).toBe(
      "secrets/x.txt is denylisted and was never stored",
    );
    expect(err(r("secrets/x.txt#f")).message).toBe(
      "secrets/x.txt is denylisted and was never stored",
    );
  });
  it("echoes at most 120 characters of the target", () => {
    expect(err(r("q".repeat(4000))).message).toBe(
      `target ${"q".repeat(119)}… is not in the store`,
    );
    const deep = `${"d/".repeat(100)}.env`;
    expect(err(r(deep)).message).toBe(
      `${deep.slice(0, 119)}… is denylisted and was never stored`,
    );
  });
  it("lists near misses by match level, then rank, path and line", () => {
    expect(err(r("orbi")).candidates).toEqual([
      { id: "tiny:lib/orbit.ts", kind: "file" },
      { id: "tiny:lib/orbit.ts#Orbit", kind: "class", line: 10 },
      { id: "tiny:lib/orbit.ts#Orbit.position", kind: "method", line: 12 },
      { id: "tiny:lib/orbit.test.ts", kind: "test-file" },
    ]);
    expect(ids(r("Position"))).toEqual([
      "tiny:lib/orbit.ts#Orbit.position",
      "tiny:lib/camera.ts#Camera.position",
    ]);
    expect(ids(r("lib/body"))).toEqual(["tiny:lib/body.ts"]);
  });
  it("offers a definition its file's near names, then its qualname elsewhere", () => {
    expect(err(r("tiny:lib/orbit.ts#position")).candidates).toEqual([
      { id: "tiny:lib/orbit.ts#Orbit.position", kind: "method", line: 12 },
    ]);
    expect(ids(r("lib/orbit.ts#position(2)"))).toEqual([
      "tiny:lib/orbit.ts#Orbit.position",
    ]);
    expect(ids(r("tiny:lib/camera.ts#Orbit.position"))).toEqual([
      "tiny:lib/orbit.ts#Orbit.position",
    ]);
    expect(ids(r("py/pkg/util.py#helper(3)"))).toEqual([
      "tiny:py/pkg/util.py#helper",
      "tiny:py/pkg/util.py#helper(2)",
    ]);
    expect(ids(r("tiny:lib/kepler.ts#<module>"))).toEqual([
      "tiny:lib/orbit.ts",
    ]);
    // the file's own main first, though app/main.ts ranks higher
    expect(ids(r("tiny:scripts/sync-#main(2)"))).toEqual([
      "tiny:scripts/sync-#main",
      "tiny:app/main.ts#main",
    ]);
  });
  it("follows renames through at most 10 steps", () => {
    const chain = Array.from({ length: 12 }, (_, i) => `r/p${i}.ts`);
    const x = storeOf({
      files: ["r/p11.ts", "s/c.ts"],
      renames: [
        ...chain.slice(0, -1).map((p, i) => [p, chain[i + 1]] as const),
        ["s/a.ts", "s/b.ts"],
        ["s/b.ts", "s/c.ts"],
        ["s/b.ts", "s/a.ts"],
      ],
    });
    const rx = (t: string) => resolveTarget(x, "x", t, "target");
    expect(ids(rx("s/a.ts"))).toEqual(["x:s/c.ts"]);
    expect(ids(rx("r/p1.ts"))).toEqual(["x:r/p11.ts"]); // 10 steps
    expect(ids(rx("r/p0.ts"))).toEqual([]); // 11 steps
  });
  it("keeps renames when near misses fill the candidates", () => {
    const dirs = Array.from({ length: 25 }, (_, i) => `d${i}/k.ts`);
    const x = storeOf({
      files: [...dirs, "z/moved.ts"],
      renames: [["gone/k.ts", "z/moved.ts"]],
    });
    const found = ids(resolveTarget(x, "x", "gone/k.ts", "file"));
    expect(found).toHaveLength(20);
    expect(found.slice(0, 3)).toEqual(["x:d0/k.ts", "x:d1/k.ts", "x:d10/k.ts"]);
    expect(found.at(-1)).toBe("x:z/moved.ts");
  });
});

describe("ambiguity", () => {
  const x = storeOf({
    files: ["m.ts", "app/x.ts"],
    components: ["app/"],
    defs: [
      ["m.ts", "A", "class", 1],
      ["m.ts", "A.run", "method", 2],
      ["m.ts", "B", "class", 4],
      ["m.ts", "B.run", "method", 5],
      ["app/x.ts", "app", "constant", 3],
    ],
  });
  const rx = (t: string) => resolveTarget(x, "x", t, "target");
  it("answers several definitions of one name in a file as ambiguous", () => {
    expect(rx("m.ts#run")).toEqual({
      code: "ambiguous",
      message: "2 definitions in m.ts are named run",
      candidates: [
        { id: "x:m.ts#A.run", kind: "method", line: 2 },
        { id: "x:m.ts#B.run", kind: "method", line: 5 },
      ],
      hint: "pass one candidate id as target",
    });
    expect(rx("m.ts#B.run")).toMatchObject({ kind: "definition", defId: 5 });
  });
  it("counts files among the matches of a bare name", () => {
    const y = storeOf({ files: ["b/index.ts", "a/index.ts"] });
    expect(resolveTarget(y, "x", "index.ts", "file")).toEqual({
      code: "ambiguous",
      message: "2 files and definitions match index.ts",
      candidates: [
        { id: "x:a/index.ts", kind: "file" },
        { id: "x:b/index.ts", kind: "file" },
      ],
      hint: "pass one candidate id as file",
    });
  });
  it("names the component a bare name also matches", () =>
    expect(rx("app")).toEqual({
      code: "ambiguous",
      message: "2 components, files and definitions match app",
      candidates: [{ id: "x:app/x.ts#app", kind: "constant", line: 3 }],
      hint: "pass one candidate id as target, or app/ for the component",
    }));
});

describe("matchLevel", () => {
  it("takes the best level over the names", () => {
    expect(matchLevel("Orbit", ["lib/orbit.ts", "Orbit"])).toBe("exact");
    expect(matchLevel("orbit", ["Orbit.position", "Orbit"])).toBe("case");
    expect(matchLevel("orbit", ["lib/orbit.ts", "orbit.ts"])).toBe("prefix");
    expect(matchLevel("bit", ["lib/orbit.ts", "orbit.ts"])).toBe("substring");
    expect(matchLevel("comet", ["lib/orbit.ts", "orbit.ts"])).toBeNull();
    expect(matchLevel("x", [])).toBeNull();
  });
  it("folds case with toLowerCase only", () => {
    const dottedI = String.fromCharCode(0x130); // its lower case is i and U+0307
    expect(matchLevel("STRASSE", ["stra\xdfe"])).toBeNull();
    expect(matchLevel(dottedI, [`i${String.fromCharCode(0x307)}`])).toBe(
      "case",
    );
  });
});

describe("wrongKind", () => {
  it("names what the target is and what the tool takes", () => {
    expect(
      wrongKind(
        "target",
        r("tiny:npm:react") as Resolved,
        "code_explain",
        "a code file or a definition",
        "code_references lists a library's importers",
      ),
    ).toEqual({
      code: "invalid_argument",
      message:
        "target is a library; code_explain takes a code file or a definition",
      field: "target",
      hint: "code_references lists a library's importers",
    });
    expect(KIND_NAME).toEqual({
      repo: "repo",
      directory: "component",
      file: "file",
      definition: "definition",
      external: "library",
    });
  });
});
