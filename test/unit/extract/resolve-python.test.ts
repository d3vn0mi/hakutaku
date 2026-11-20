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
