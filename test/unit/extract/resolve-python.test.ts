// hakutaku's Python resolver, over hand-made module indexes of the shape pythonModuleIndex
// builds: no snapshot and no engine.
import { expect, it } from "vitest";
import {
  type PythonResolution,
  resolvePythonImport,
} from "../../../src/extract/resolve/python.js";

const modules = new Map([
  ["observatory", "sim/src/observatory/__init__.py"],
  ["observatory.ephemeris.cli", "sim/src/observatory/ephemeris/cli.py"],
  ["observatory.ephemeris", "sim/src/observatory/ephemeris/__init__.py"],
  ["observatory.catalog.stars", "sim/src/observatory/catalog/stars.py"],
]);
it.each<[string, string, PythonResolution]>([
  [
    "sim/tests/test_cli.py",
    "observatory.ephemeris.cli",
    { file: "sim/src/observatory/ephemeris/cli.py" },
  ],
  [
    "sim/src/observatory/ephemeris/cli.py",
    ".",
    { file: "sim/src/observatory/ephemeris/__init__.py" },
  ],
  [
    "sim/src/observatory/ephemeris/cli.py",
    "..catalog.stars",
    { file: "sim/src/observatory/catalog/stars.py" },
  ],
  [
    "sim/src/observatory/ephemeris/cli.py",
    "json",
    { ecosystem: "python", name: "json" },
  ],
  [
    "sim/src/observatory/ephemeris/cli.py",
    "numpy.linalg",
    { ecosystem: "pypi", name: "numpy" },
  ],
  ["sim/src/observatory/ephemeris/cli.py", "..missing", null],
])("resolves %s → %s", (from, mod, want) =>
  expect(resolvePythonImport(from, mod, modules)).toEqual(want),
);

// The same index with a single-file module and a package named like a standard-library module.
const more = new Map([
  ...modules,
  ["logging", "sim/src/logging/__init__.py"],
  ["skyctl", "tools/skyctl.py"],
]);
it.each<[string, string, string, PythonResolution]>([
  [
    "an __init__.py's package is its own",
    "sim/src/observatory/ephemeris/__init__.py",
    ".",
    { file: "sim/src/observatory/ephemeris/__init__.py" },
  ],
  [
    "each further dot goes up one package",
    "sim/src/observatory/ephemeris/__init__.py",
    "..",
    { file: "sim/src/observatory/__init__.py" },
  ],
  [
    "a module's package is its parent's",
    "sim/src/observatory/ephemeris/cli.py",
    ".cli",
    { file: "sim/src/observatory/ephemeris/cli.py" },
  ],
  [
    "a relative module names one module exactly, never a prefix of it",
    "sim/src/observatory/ephemeris/cli.py",
    ".cli.parse",
    null,
  ],
  [
    "a relative module that climbs past the top package matches nothing, even a top-level module",
    "sim/src/observatory/ephemeris/cli.py",
    "...observatory",
    null,
  ],
  [
    "a relative module from a file the index does not name matches nothing",
    "sim/tests/test_cli.py",
    ".conftest",
    null,
  ],
  [
    "a relative module from a top-level module matches nothing",
    "tools/skyctl.py",
    ".",
    null,
  ],
  [
    "an absolute module takes its longest prefix in the index",
    "sim/tests/test_cli.py",
    "observatory.ephemeris.cli.main",
    { file: "sim/src/observatory/ephemeris/cli.py" },
  ],
  [
    "a prefix ends at a dot, never inside a name",
    "sim/tests/test_cli.py",
    "observatory.ephemerisx.cli",
    { file: "sim/src/observatory/__init__.py" },
  ],
  [
    "the index comes before the standard library",
    "sim/tests/test_cli.py",
    "logging.handlers",
    { file: "sim/src/logging/__init__.py" },
  ],
  [
    "a single-file module is found by its name",
    "sim/tests/test_cli.py",
    "skyctl",
    { file: "tools/skyctl.py" },
  ],
  [
    "a standard-library submodule is its top-level module",
    "sim/tests/test_cli.py",
    "os.path",
    { ecosystem: "python", name: "os" },
  ],
  [
    "__future__ is in the standard library",
    "sim/tests/test_cli.py",
    "__future__",
    { ecosystem: "python", name: "__future__" },
  ],
  [
    "a top-level name in neither is a PyPI package",
    "sim/tests/test_cli.py",
    "astropy",
    { ecosystem: "pypi", name: "astropy" },
  ],
  ["an empty module names nothing", "sim/tests/test_cli.py", "", null],
  [
    "an empty part names nothing",
    "sim/tests/test_cli.py",
    "observatory..cli",
    null,
  ],
  [
    "a trailing dot names nothing",
    "sim/src/observatory/ephemeris/cli.py",
    "..catalog.",
    null,
  ],
])("%s", (_rule, from, mod, want) =>
  expect(resolvePythonImport(from, mod, more)).toEqual(want),
);

it("takes a file's dotted name when the index names it twice, as a single-file module and under a root", () => {
  const twice = new Map([
    ["skyctl", "tools/skyctl.py"],
    ["tools.helpers", "tools/helpers.py"],
    ["tools.skyctl", "tools/skyctl.py"],
  ]);
  expect(resolvePythonImport("tools/skyctl.py", ".helpers", twice)).toEqual({
    file: "tools/helpers.py",
  });
});

// A plugin-style repo, whose top is itself a package, as a host application imports a plugin:
// its module index has the one root ".", and the tree adds the files the index never names.
const plugin = new Map([
  ["helpers", "helpers.py"],
  ["orbit", "orbit/__init__.py"],
  ["sky", "sky/__init__.py"],
  ["sky.chart", "sky/chart.py"],
  ["sky.plain.notes", "sky/plain/notes.py"],
  ["sky.stars", "sky/stars/__init__.py"],
  ["sky.stars.catalog", "sky/stars/catalog.py"],
]);
const pluginTree = new Set([
  ...plugin.values(),
  "README.md",
  "__init__.py",
  "orbit.py",
  "sky-tool/__init__.py",
  "sky-tool/run.py",
  "sky/0001_initial.py",
  "stubs.pyi",
]);
it.each<[string, string, string, PythonResolution]>([
  [
    "the repo top's __init__.py reads the repo top as its package",
    "__init__.py",
    ".sky",
    { file: "sky/__init__.py" },
  ],
  [
    "a dotted name goes down from the repo top",
    "__init__.py",
    ".sky.chart",
    { file: "sky/chart.py" },
  ],
  [
    "a dot alone names the repo top's own __init__.py",
    "__init__.py",
    ".",
    { file: "__init__.py" },
  ],
  ["a climb past the repo top matches nothing", "__init__.py", "..", null],
  [
    "a climb past the repo top matches nothing, even onto a module of that name",
    "__init__.py",
    "..sky",
    null,
  ],
  [
    "a top-level module's package is the repo top",
    "helpers.py",
    ".sky.stars",
    { file: "sky/stars/__init__.py" },
  ],
  [
    "a module's climb past its root's top package lands in the repo top",
    "sky/chart.py",
    "..helpers",
    { file: "helpers.py" },
  ],
  [
    "each further dot goes up one package, to the repo top's __init__.py",
    "sky/stars/catalog.py",
    "...",
    { file: "__init__.py" },
  ],
  [
    "a package comes before a module of the same name",
    "__init__.py",
    ".orbit",
    { file: "orbit/__init__.py" },
  ],
  [
    "it names one module exactly, never a prefix of it",
    "__init__.py",
    ".sky.missing",
    null,
  ],
  ["a stub is never a module", "__init__.py", ".stubs", null],
  [
    "a name part that is not an identifier names nothing",
    "__init__.py",
    ".sky-tool",
    null,
  ],
  [
    "a directory without an __init__.py breaks the package chain to the repo top",
    "sky/plain/notes.py",
    "...helpers",
    null,
  ],
  [
    "a directory not named by an identifier breaks the chain too",
    "sky-tool/run.py",
    "..helpers",
    null,
  ],
  [
    "a file whose name is not an identifier is no module of the chain",
    "sky/0001_initial.py",
    "..helpers",
    null,
  ],
  ["a stub is no module of the chain either", "stubs.pyi", ".helpers", null],
])("%s", (_rule, from, mod, want) =>
  expect(resolvePythonImport(from, mod, plugin, pluginTree)).toEqual(want),
);

it("reads the repo top as a package only when it holds an __init__.py, and only when given the tree", () => {
  const noTop = new Set([...pluginTree].filter((p) => p !== "__init__.py"));
  expect(resolvePythonImport("helpers.py", ".sky", plugin, noTop)).toBeNull();
  expect(resolvePythonImport("sky/chart.py", "..helpers", plugin, noTop)).toBe(
    null,
  );
  // a relative import inside one root's packages reads the same either way
  expect(resolvePythonImport("sky/chart.py", ".stars", plugin, noTop)).toEqual({
    file: "sky/stars/__init__.py",
  });
  expect(resolvePythonImport("__init__.py", ".sky", plugin)).toBeNull();
  expect(resolvePythonImport("sky/chart.py", "..helpers", plugin)).toBeNull();
});

it("keeps a deeper root's top package its own when no __init__.py joins it to the repo top", () => {
  const vendored = new Map([
    ["helpers", "helpers.py"],
    ["lib", "vendor/lib/__init__.py"],
    ["lib.parse", "vendor/lib/parse.py"],
  ]);
  const tree = new Set([...vendored.values(), "__init__.py"]);
  expect(
    resolvePythonImport("vendor/lib/parse.py", "..helpers", vendored, tree),
  ).toBeNull();
  // the repo top's __init__.py names the vendored package by its path from the repo top
  expect(
    resolvePythonImport("__init__.py", ".vendor.lib.parse", vendored, tree),
  ).toEqual({ file: "vendor/lib/parse.py" });
});

it("reads an index built after an earlier call with another index", () => {
  const first = new Map([["sky", "a/sky/__init__.py"]]);
  const second = new Map([["sky", "b/sky/__init__.py"]]);
  expect(resolvePythonImport("a/sky/__init__.py", ".", first)).toEqual({
    file: "a/sky/__init__.py",
  });
  // the file names no module of the second index, so its package is unknown there
  expect(resolvePythonImport("a/sky/__init__.py", ".", second)).toBeNull();
  expect(resolvePythonImport("b/sky/__init__.py", ".", second)).toEqual({
    file: "b/sky/__init__.py",
  });
});
