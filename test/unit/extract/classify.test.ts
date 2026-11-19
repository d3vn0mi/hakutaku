import { expect, it } from "vitest";
import {
  CONFIG_EXT,
  CONFIG_NAMES,
  classifyFile,
  computeComponents,
  DOC_EXT,
  DOC_NAMES,
  markTestSupport,
  TEST_PATTERNS,
} from "../../../src/extract/classify.js";
import type { FileKind } from "../../../src/model/index.js";
import { DEFAULT_PROFILE } from "../../../src/profile/index.js";

const P = DEFAULT_PROFILE;
const text = new TextEncoder().encode("x");
// Rows of one kind, 10 lines each; files(...paths) makes production code rows.
const rows = (kind: FileKind, ...paths: string[]) =>
  paths.map((path) => ({ path, kind, lines: 10 }));
const files = (...paths: string[]) => rows("code", ...paths);
const config = { kind: "config", lang: null };
const doc = { kind: "doc", lang: null };
const other = { kind: "other", lang: null };

it.each<[string, string, string | null]>([
  ["web/src/orbits/kepler.ts", "code", "typescript"],
  ["web/src/orbits/kepler.test.ts", "test", "typescript"],
  ["sim/tests/test_orbit.py", "test", "python"],
  ["sim/tests/conftest.py", "test", "python"],
  ["web/fixtures/sky.ts", "test", "typescript"],
  [".github/workflows/sky.yml", "config", null],
  ["sim/requirements-dev.txt", "config", null],
  ["README.md", "doc", null],
  ["LICENSE", "doc", null],
  ["docs/sky.png", "other", null],
])("classifies %s as %s", (path, kind, lang) =>
  expect(classifyFile(path, text, P)).toEqual({ kind, lang }),
);
it("classifies a binary .ts file as other", () =>
  expect(
    classifyFile("media/clip.ts", new Uint8Array([0x47, 0, 1]), P),
  ).toEqual({ kind: "other", lang: null }));
it("applies the profile's extra test patterns", () => {
  expect(
    classifyFile("web/src/qa/check.ts", text, {
      ...P,
      tests: { extraPatterns: ["web/src/qa/**"] },
    }).kind,
  ).toBe("test");
  // and only they make it a test: without them it is production code
  expect(classifyFile("web/src/qa/check.ts", text, P).kind).toBe("code");
});
it("marks test support until nothing changes, and spares entries and files nobody imports", () => {
  const kinds = new Map<string, FileKind>([
    ["t.test.ts", "test"],
    ["fake-clock.ts", "code"],
    ["tick.ts", "code"],
    ["cli.ts", "code"],
    ["lonely.ts", "code"],
  ]);
  const importers = new Map([
    ["fake-clock.ts", new Set(["t.test.ts"])],
    ["tick.ts", new Set(["fake-clock.ts"])],
    ["cli.ts", new Set(["t.test.ts"])],
  ]);
  markTestSupport(kinds, importers, new Set(["cli.ts"]));
  expect(Object.fromEntries(kinds)).toEqual({
    "t.test.ts": "test",
    "fake-clock.ts": "test-support",
    "tick.ts": "test-support",
    "cli.ts": "code",
    "lonely.ts": "code",
  });
  // the same files listed deepest first, so that one pass in list order cannot finish
  const reversed = new Map(
    [...kinds].reverse().map(([p]): [string, FileKind] => [p, "code"]),
  );
  reversed.set("t.test.ts", "test");
  markTestSupport(
    reversed,
    new Map([...importers].reverse()),
    new Set(["cli.ts"]),
  );
  expect(Object.fromEntries(reversed)).toEqual(Object.fromEntries(kinds));
});
it("finds package roots, top-level Python packages, folders and the root component", () => {
  const plan = computeComponents(
    files(
      "web/src/a.ts",
      "sim/src/observatory/x.py",
      "scripts/sync.sh",
      "setup.py",
    ),
    new Set(["web/"]),
    ["sim/src"],
    [],
  );
  expect(Object.fromEntries(plan.of)).toEqual({
    "web/src/a.ts": "web/",
    "sim/src/observatory/x.py": "sim/src/observatory/",
    "scripts/sync.sh": "scripts/",
    "setup.py": "./",
  });
  expect(plan.components).toEqual([
    { path: "./", kind: "folder", parent: null },
    { path: "scripts/", kind: "folder", parent: null },
    { path: "sim/src/observatory/", kind: "python-package", parent: null },
    { path: "web/", kind: "package", parent: null },
  ]);
});
it("splits a component that holds more than 40% of the production files", () => {
  const plan = computeComponents(
    files("web/a/1.ts", "web/a/2.ts", "web/b/3.ts", "web/4.ts", "sim/5.py"),
    new Set(["web/"]),
    [],
    [],
  );
  expect(plan.components).toContainEqual({
    path: "web/a/",
    kind: "split",
    parent: "web/",
  });
  expect(plan.of.get("web/4.ts")).toBe("web/");
  // web/ holds 4 of the 5 production files and splits; sim/ holds 1 and does not
  expect(plan.components).toEqual([
    { path: "sim/", kind: "folder", parent: null },
    { path: "web/", kind: "package", parent: null },
    { path: "web/a/", kind: "split", parent: "web/" },
    { path: "web/b/", kind: "split", parent: "web/" },
  ]);
  expect(Object.fromEntries(plan.of)).toEqual({
    "web/a/1.ts": "web/a/",
    "web/a/2.ts": "web/a/",
    "web/b/3.ts": "web/b/",
    "web/4.ts": "web/",
    "sim/5.py": "sim/",
  });
});
it("lets profile roots win", () => {
  const plan = computeComponents(
    files("web/src/orbits/kepler.ts"),
    new Set(["web/"]),
    [],
    ["web/src/*"],
  );
  expect(plan.of.get("web/src/orbits/kepler.ts")).toBe("web/src/orbits/");
  // over the package root web/, which then holds no file and is no component
  expect(plan.components).toEqual([
    { path: "web/src/orbits/", kind: "profile", parent: null },
  ]);
});

// Beyond the plan's list: the lists themselves, and the order of the rules.
it("lists the default test patterns, and the config and doc extensions and names, frozen", () => {
  expect(TEST_PATTERNS).toEqual([
    "*.test.*",
    "*.spec.*",
    "test_*.py",
    "*_test.py",
    "conftest.py",
    "__tests__/**",
    "tests/**",
    "test/**",
    "fixtures/**",
  ]);
  expect(CONFIG_EXT).toEqual([
    ".json",
    ".jsonc",
    ".json5",
    ".yml",
    ".yaml",
    ".toml",
    ".ini",
    ".cfg",
    ".conf",
    ".properties",
    ".xml",
    ".service",
    ".timer",
    ".path",
    ".socket",
    ".mount",
    ".target",
  ]);
  expect(CONFIG_NAMES).toEqual([
    "Dockerfile",
    "Procfile",
    "Makefile",
    ".gitignore",
    ".gitattributes",
    ".editorconfig",
    ".nvmrc",
    ".node-version",
    ".python-version",
    "requirements*.txt",
  ]);
  expect(DOC_EXT).toEqual([".md", ".mdx", ".rst", ".txt", ".adoc"]);
  expect(DOC_NAMES).toEqual([
    "README",
    "LICENSE",
    "LICENCE",
    "NOTICE",
    "COPYING",
    "CHANGELOG",
    "AUTHORS",
  ]);
  for (const list of [
    TEST_PATTERNS,
    CONFIG_EXT,
    CONFIG_NAMES,
    DOC_EXT,
    DOC_NAMES,
  ])
    expect(Object.isFrozen(list)).toBe(true);
});
it("classifies every config extension and name as config, Dockerfile.* included", () => {
  for (const ext of CONFIG_EXT)
    expect(classifyFile(`deploy/sky${ext}`, text, P)).toEqual(config);
  const names = [
    ...CONFIG_NAMES.filter((name) => !name.includes("*")),
    "requirements.txt",
    "requirements-dev.txt",
    "Dockerfile.dev",
  ];
  for (const name of names)
    for (const path of [name, `sim/${name}`])
      expect(classifyFile(path, text, P)).toEqual(config);
});
it("classifies every doc extension, and every doc name with or without an extension, as doc", () => {
  for (const ext of DOC_EXT)
    expect(classifyFile(`docs/sky${ext}`, text, P)).toEqual(doc);
  for (const name of DOC_NAMES)
    for (const path of [name, `${name}.in`, `web/${name}`])
      expect(classifyFile(path, text, P)).toEqual(doc);
  // the name must be the whole file name less its last extension
  for (const path of ["LICENSE-MIT", "web/README.md.orig", "web/MY-NOTICE"])
    expect(classifyFile(path, text, P)).toEqual(other);
});
it("lets config win over doc, and code win over config and doc names", () => {
  expect(classifyFile("sim/requirements.txt", text, P)).toEqual(config);
  expect(classifyFile("web/NOTICE.json", text, P)).toEqual(config);
  expect(classifyFile("tools/README.py", text, P)).toEqual({
    kind: "code",
    lang: "python",
  });
  expect(classifyFile("sim/Dockerfile.sh", text, P)).toEqual({
    kind: "code",
    lang: "shell",
  });
});
it("applies the default test patterns at any depth, to code files only", () => {
  for (const [path, lang] of [
    ["web/src/__tests__/orbit.ts", "typescript"],
    ["web/test/orbit.ts", "typescript"],
    ["sim/a/tests/b/orbit.py", "python"],
    ["web/src/orbit.spec.tsx", "typescript"],
    ["sim/orbit_test.py", "python"],
    ["sim/src/test_orbit.py", "python"],
    ["sim/src/conftest.py", "python"],
    ["fixtures/sky.mjs", "javascript"],
    ["test/run.sh", "shell"],
  ])
    expect(classifyFile(path, text, P)).toEqual({ kind: "test", lang });
  for (const path of [
    "web/src/testing/fake-clock.ts",
    "web/src/latest/orbit.ts",
    "web/src/tests.ts",
    "web/src/contest.ts",
    "web/src/test_orbit.ts",
  ])
    expect(classifyFile(path, text, P).kind).toBe("code");
  expect(classifyFile("sim/tests/data.json", text, P)).toEqual(config);
  expect(classifyFile("web/__tests__/README.md", text, P)).toEqual(doc);
  expect(classifyFile("web/fixtures/sky.png", text, P)).toEqual(other);
});
it("reads extensions and names in their exact case", () => {
  for (const path of [
    "web/src/Kepler.TS",
    "sim/orbit.Py",
    "docs/SKY.MD",
    "deploy/sky.YML",
    "readme",
    "makefile",
  ])
    expect(classifyFile(path, text, P)).toEqual(other);
  expect(classifyFile("Readme.md", text, P)).toEqual(doc);
  expect(classifyFile("README.MD", text, P)).toEqual(doc);
});
it("looks for a NUL byte in the first 8,000 bytes only, whatever the file's name", () => {
  const nulAt = (at: number, length: number): Uint8Array => {
    const head = new Uint8Array(length).fill(0x20);
    head[at] = 0;
    return head;
  };
  expect(classifyFile("web/a.ts", nulAt(7999, 9000), P)).toEqual(other);
  expect(classifyFile("web/a.ts", nulAt(8000, 9000), P)).toEqual({
    kind: "code",
    lang: "typescript",
  });
  for (const path of ["README.md", "sim/tests/test_orbit.py", "Makefile"])
    expect(classifyFile(path, nulAt(3, 20), P)).toEqual(other);
});
it("classifies an empty file, a file without an extension and a dotfile by name alone", () => {
  expect(classifyFile("web/empty.ts", new Uint8Array(0), P)).toEqual({
    kind: "code",
    lang: "typescript",
  });
  for (const path of ["scripts/deploy", ".bashrc", "web/.sh"])
    expect(classifyFile(path, text, P)).toEqual(other);
  expect(classifyFile(".eslintrc.json", text, P)).toEqual(config);
  expect(classifyFile("web/.nvmrc", text, P)).toEqual(config);
});

// Beyond the plan's list: test support.
it("leaves a file that imports itself, and a cycle only tests reach, as code", () => {
  const kinds = new Map<string, FileKind>([
    ["t.test.ts", "test"],
    ["a.ts", "code"],
    ["b.ts", "code"],
    ["self.ts", "code"],
  ]);
  markTestSupport(
    kinds,
    new Map([
      ["a.ts", new Set(["t.test.ts", "b.ts"])],
      ["b.ts", new Set(["a.ts"])],
      ["self.ts", new Set(["t.test.ts", "self.ts"])],
    ]),
    new Set(),
  );
  expect(Object.fromEntries(kinds)).toEqual({
    "t.test.ts": "test",
    "a.ts": "code",
    "b.ts": "code",
    "self.ts": "code",
  });
});
it("changes only code files, and counts an importer without a kind as production", () => {
  const kinds = new Map<string, FileKind>([
    ["t.test.ts", "test"],
    ["u.test.ts", "test"],
    ["sky.json", "config"],
    ["notes.md", "doc"],
    ["blob.ts", "other"],
    ["helper.ts", "code"],
  ]);
  const only = new Set(["t.test.ts"]);
  markTestSupport(
    kinds,
    new Map([
      ["u.test.ts", only],
      ["sky.json", only],
      ["notes.md", only],
      ["blob.ts", only],
      ["helper.ts", new Set(["t.test.ts", "ghost.ts"])],
    ]),
    new Set(),
  );
  expect(Object.fromEntries(kinds)).toEqual({
    "t.test.ts": "test",
    "u.test.ts": "test",
    "sky.json": "config",
    "notes.md": "doc",
    "blob.ts": "other",
    "helper.ts": "code",
  });
});
it("keeps what an entry imports production, even when only tests import the entry", () => {
  const kinds = new Map<string, FileKind>([
    ["t.test.ts", "test"],
    ["cli.ts", "code"],
    ["args.ts", "code"],
    ["shared.ts", "code"],
  ]);
  markTestSupport(
    kinds,
    new Map([
      ["cli.ts", new Set(["t.test.ts"])],
      ["args.ts", new Set(["cli.ts"])],
      ["shared.ts", new Set(["t.test.ts", "cli.ts"])],
    ]),
    new Set(["cli.ts"]),
  );
  expect(Object.fromEntries(kinds)).toEqual({
    "t.test.ts": "test",
    "cli.ts": "code",
    "args.ts": "code",
    "shared.ts": "code",
  });
});
it("marks a chain of 100,000 files listed deepest first, in linear time", () => {
  const n = 100_000;
  const kinds = new Map<string, FileKind>();
  const importers = new Map<string, Set<string>>();
  for (let i = n - 1; i >= 0; i--) {
    kinds.set(`h${i}.ts`, "code");
    importers.set(
      `h${i}.ts`,
      new Set([i === 0 ? "t.test.ts" : `h${i - 1}.ts`]),
    );
  }
  kinds.set("t.test.ts", "test");
  markTestSupport(kinds, importers, new Set());
  expect([...kinds.values()].filter((k) => k === "test-support")).toHaveLength(
    n,
  );
});

// Beyond the plan's list: components.
it("takes the nearest package root or top-level Python package, and a package root when a directory is both", () => {
  const plan = computeComponents(
    files(
      "sim/src/observatory/ephemeris/cli.py",
      "sim/tools/rebuild.py",
      "sim/src/observatory/vendor/lib/x.py",
      "lib/core/y.py",
    ),
    new Set(["sim/", "sim/src/observatory/vendor/", "lib/core/"]),
    ["sim/src", "lib"],
    [],
  );
  expect(Object.fromEntries(plan.of)).toEqual({
    "lib/core/y.py": "lib/core/",
    "sim/src/observatory/ephemeris/cli.py": "sim/src/observatory/",
    "sim/src/observatory/vendor/lib/x.py": "sim/src/observatory/vendor/",
    "sim/tools/rebuild.py": "sim/",
  });
  expect(plan.components).toEqual([
    { path: "lib/core/", kind: "package", parent: null },
    { path: "sim/", kind: "package", parent: null },
    { path: "sim/src/observatory/", kind: "python-package", parent: null },
    { path: "sim/src/observatory/vendor/", kind: "package", parent: null },
  ]);
});
it("takes a directory directly under a Python root as a package only when it holds Python, the top root included", () => {
  const top = computeComponents(
    [
      ...files(
        "pkg/mod.py",
        "pkg/static/app.ts",
        "ns/inner/deep.py",
        "web/a.ts",
        "tool.py",
        "blob/y.ts",
      ),
      ...rows("other", "blob/x.py"),
    ],
    new Set(),
    ["."],
    [],
  );
  expect(Object.fromEntries(top.of)).toEqual({
    "pkg/mod.py": "pkg/",
    "pkg/static/app.ts": "pkg/",
    "ns/inner/deep.py": "ns/",
    "web/a.ts": "web/",
    "tool.py": "./",
    "blob/y.ts": "blob/",
  });
  expect(top.components).toEqual([
    { path: "./", kind: "folder", parent: null },
    { path: "blob/", kind: "folder", parent: null },
    { path: "ns/", kind: "python-package", parent: null },
    { path: "pkg/", kind: "python-package", parent: null },
    { path: "web/", kind: "folder", parent: null },
  ]);
  // a module directly in a root is in no package
  const nested = computeComponents(
    files(
      "sim/src/conftest.py",
      "sim/src/observatory/x.py",
      "a/1.ts",
      "b/2.ts",
      "c/3.ts",
    ),
    new Set(),
    ["sim/src"],
    [],
  );
  expect(nested.of.get("sim/src/conftest.py")).toBe("sim/");
  expect(nested.components).toContainEqual({
    path: "sim/",
    kind: "folder",
    parent: null,
  });
  expect(nested.of.get("sim/src/observatory/x.py")).toBe(
    "sim/src/observatory/",
  );
});
it("never takes the repo top as a package root", () => {
  const plan = computeComponents(
    files("web/a.ts", "sim/b.py", "c.ts"),
    new Set(["./", ""]),
    [],
    [],
  );
  expect(plan.components).toEqual([
    { path: "./", kind: "folder", parent: null },
    { path: "sim/", kind: "folder", parent: null },
    { path: "web/", kind: "folder", parent: null },
  ]);
});
it("gives a component only to code, test and test-support files", () => {
  const plan = computeComponents(
    [
      ...files("web/a.ts", "sim/b.py", "lib/c.ts"),
      ...rows("test", "web/a.test.ts"),
      ...rows("test-support", "web/fake.ts"),
      ...rows("config", "deploy/x.json"),
      ...rows("doc", "docs/y.md"),
      ...rows("other", "media/z.png"),
    ],
    new Set(),
    [],
    [],
  );
  expect(Object.fromEntries(plan.of)).toEqual({
    "web/a.ts": "web/",
    "web/a.test.ts": "web/",
    "web/fake.ts": "web/",
    "sim/b.py": "sim/",
    "lib/c.ts": "lib/",
  });
  expect(plan.components.map((c) => c.path)).toEqual(["lib/", "sim/", "web/"]);
});
it("takes the deepest profile root, testing directories only and never the file", () => {
  const plan = computeComponents(
    files(
      "web/src/orbits/kepler.ts",
      "web/src/orbits/frames/icrs.ts",
      "kepler.ts",
      "web/scripts/build.mjs",
      "lib/a.ts",
      "tools/kepler.ts",
    ),
    new Set(),
    [],
    ["web/src/*", "web/src/orbits/*", "kepler.ts", "scripts"],
  );
  expect(Object.fromEntries(plan.of)).toEqual({
    "web/src/orbits/kepler.ts": "web/src/orbits/",
    "web/src/orbits/frames/icrs.ts": "web/src/orbits/frames/",
    "kepler.ts": "./",
    // a root without "/" matches that directory name at any depth
    "web/scripts/build.mjs": "web/scripts/",
    "lib/a.ts": "lib/",
    // the root kepler.ts matches this file's name, never a directory above it
    "tools/kepler.ts": "tools/",
  });
  expect(plan.components).toEqual([
    { path: "./", kind: "folder", parent: null },
    { path: "lib/", kind: "folder", parent: null },
    { path: "tools/", kind: "folder", parent: null },
    { path: "web/scripts/", kind: "profile", parent: null },
    { path: "web/src/orbits/", kind: "profile", parent: null },
    { path: "web/src/orbits/frames/", kind: "profile", parent: null },
  ]);
});
it("splits only above 40% of the production files, and tests take no share", () => {
  // exactly 40%: web/ and sim/ each hold 2 of 5
  const even = computeComponents(
    files("web/a/1.ts", "web/b/2.ts", "sim/3.py", "sim/4.py", "lib/5.ts"),
    new Set(),
    [],
    [],
  );
  expect(even.components.map((c) => c.path)).toEqual(["lib/", "sim/", "web/"]);
  // 3 of 7 is above 40%
  const above = computeComponents(
    files(
      "web/a/1.ts",
      "web/b/2.ts",
      "web/c/3.ts",
      "sim/4.py",
      "sim/5.py",
      "lib/6.ts",
      "docs/7.ts",
    ),
    new Set(),
    [],
    [],
  );
  expect(above.components.map((c) => c.path)).toEqual([
    "docs/",
    "lib/",
    "sim/",
    "web/",
    "web/a/",
    "web/b/",
    "web/c/",
  ]);
  // qa/ holds most files, but none of them is production code
  const tests = computeComponents(
    [
      ...rows("test", "qa/a/1.test.ts", "qa/b/2.test.ts", "qa/c/3.test.ts"),
      ...rows("test-support", "qa/d/4.ts", "qa/e/5.ts"),
      ...files("web/1.ts", "sim/2.py", "lib/3.ts"),
    ],
    new Set(),
    [],
    [],
  );
  expect(tests.components.map((c) => c.path)).toEqual([
    "lib/",
    "qa/",
    "sim/",
    "web/",
  ]);
});
it("splits once, one level down, into each subdirectory holding the component's files, tests included, and keeps an emptied parent", () => {
  const plan = computeComponents(
    [
      ...files(
        "web/src/a/1.ts",
        "web/src/a/2.ts",
        "web/src/b/3.ts",
        "web/src/4.ts",
        "sim/5.py",
      ),
      ...rows("test", "web/tests/sky.test.ts"),
      ...rows("doc", "web/docs/guide.md"),
    ],
    new Set(["web/"]),
    [],
    [],
  );
  // web/src/ holds 4 of 5 production files after the split, and is not split again
  expect(plan.components).toEqual([
    { path: "sim/", kind: "folder", parent: null },
    { path: "web/", kind: "package", parent: null },
    { path: "web/src/", kind: "split", parent: "web/" },
    { path: "web/tests/", kind: "split", parent: "web/" },
  ]);
  expect(Object.fromEntries(plan.of)).toEqual({
    "web/src/a/1.ts": "web/src/",
    "web/src/a/2.ts": "web/src/",
    "web/src/b/3.ts": "web/src/",
    "web/src/4.ts": "web/src/",
    "web/tests/sky.test.ts": "web/tests/",
    "sim/5.py": "sim/",
  });
});
it("splits every component above 40%, a profile one too, and the root component into nothing", () => {
  const two = computeComponents(
    files(
      "a/x/1.ts",
      "a/y/2.ts",
      "a/3.ts",
      "b/x/4.ts",
      "b/y/5.ts",
      "b/6.ts",
      "7.ts",
    ),
    new Set(),
    [],
    [],
  );
  expect(two.components).toEqual([
    { path: "./", kind: "folder", parent: null },
    { path: "a/", kind: "folder", parent: null },
    { path: "a/x/", kind: "split", parent: "a/" },
    { path: "a/y/", kind: "split", parent: "a/" },
    { path: "b/", kind: "folder", parent: null },
    { path: "b/x/", kind: "split", parent: "b/" },
    { path: "b/y/", kind: "split", parent: "b/" },
  ]);
  expect(two.of.get("a/3.ts")).toBe("a/");
  expect(two.of.get("b/6.ts")).toBe("b/");
  const profile = computeComponents(
    files("app/x/1.ts", "app/y/2.ts", "app/3.ts", "lib/4.ts"),
    new Set(),
    [],
    ["app"],
  );
  expect(profile.components).toEqual([
    { path: "app/", kind: "profile", parent: null },
    { path: "app/x/", kind: "split", parent: "app/" },
    { path: "app/y/", kind: "split", parent: "app/" },
    { path: "lib/", kind: "folder", parent: null },
  ]);
  // ./ holds 3 of 4, all directly inside it
  const root = computeComponents(
    files("1.ts", "2.ts", "3.ts", "lib/4.ts"),
    new Set(),
    [],
    [],
  );
  expect(root.components).toEqual([
    { path: "./", kind: "folder", parent: null },
    { path: "lib/", kind: "folder", parent: null },
  ]);
  expect(root.of.get("2.ts")).toBe("./");
});
it("names no split when no file is production code", () => {
  const plan = computeComponents(
    rows("test", "qa/a/1.test.ts", "qa/b/2.test.ts"),
    new Set(),
    [],
    [],
  );
  expect(plan.components).toEqual([
    { path: "qa/", kind: "folder", parent: null },
  ]);
});
it("lists components and files in path order by UTF-16 code units, whatever order the files come in", () => {
  const paths = [
    "-tools/x.ts",
    "a.ts",
    "Zeta/b.ts",
    "web/c.ts",
    "web/d.ts",
    "ä/e.ts",
    "%/f.ts",
    "a b/g.ts",
    "~/h.ts",
    "web/~x/i.ts",
  ];
  const plan = computeComponents(files(...paths.reverse()), new Set(), [], []);
  expect(plan.components.map((c) => c.path)).toEqual([
    "%/",
    "-tools/",
    "./",
    "Zeta/",
    "a b/",
    "web/",
    "~/",
    "ä/",
  ]);
  expect([...plan.of.keys()]).toEqual([
    "%/f.ts",
    "-tools/x.ts",
    "Zeta/b.ts",
    "a b/g.ts",
    "a.ts",
    "web/c.ts",
    "web/d.ts",
    "web/~x/i.ts",
    "~/h.ts",
    "ä/e.ts",
  ]);
});
