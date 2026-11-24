import { expect, it } from "vitest";
import {
  pythonModuleIndex,
  pythonShadowedModules,
} from "../../../src/manifests/index.js";

it("indexes Python modules under their roots", () =>
  expect(
    Object.fromEntries(
      pythonModuleIndex(
        [
          "sim/src/observatory/__init__.py",
          "sim/src/observatory/ephemeris/cli.py",
          "tools/skyctl.py",
        ],
        ["sim/src"],
        ["tools/skyctl.py"],
      ),
    ),
  ).toEqual({
    observatory: "sim/src/observatory/__init__.py",
    "observatory.ephemeris.cli": "sim/src/observatory/ephemeris/cli.py",
    skyctl: "tools/skyctl.py",
  }));

it("names a file from its deepest root, and gives a name two files claim to the earlier root", () => {
  const paths = [
    "observatory/__init__.py",
    "sim/src/observatory/__init__.py",
    "sim/src/observatory/orbit.py",
  ];
  expect(
    Object.fromEntries(pythonModuleIndex(paths, [".", "sim/src"], [])),
  ).toEqual({
    observatory: "observatory/__init__.py",
    "observatory.orbit": "sim/src/observatory/orbit.py",
  });
  expect(
    Object.fromEntries(pythonModuleIndex(paths, ["sim/src", "."], [])),
  ).toEqual({
    observatory: "sim/src/observatory/__init__.py",
    "observatory.orbit": "sim/src/observatory/orbit.py",
  });
});

it("skips stubs and names that are not Python identifiers, and lets a package win over a module", () =>
  expect(
    Object.fromEntries(
      pythonModuleIndex(
        [
          "sim/src/observatory.py",
          "sim/src/observatory/__init__.py",
          "sim/src/observatory/sky-map.py",
          "sim/src/observatory/orbit.test.py",
          "sim/src/observatory/orbit.pyi",
          "sim/src/2mass/__init__.py",
          "sim/src/étoile.py",
          "sim/src/__init__.py",
          "tools/orbit.py",
        ],
        ["sim/src"],
        [],
      ),
    ),
  ).toEqual({
    observatory: "sim/src/observatory/__init__.py",
    étoile: "sim/src/étoile.py",
  }));

it("adds tracked single-file modules by their stem, after the roots", () =>
  expect(
    Object.fromEntries(
      pythonModuleIndex(
        [
          "tools/skyctl.py",
          "tools/observatory.py",
          "sim/src/observatory/__init__.py",
        ],
        ["sim/src"],
        ["tools/skyctl.py", "tools/observatory.py", "tools/missing.py"],
      ),
    ),
  ).toEqual({
    observatory: "sim/src/observatory/__init__.py",
    skyctl: "tools/skyctl.py",
  }));

it("lists names in path order", () =>
  expect([
    ...pythonModuleIndex(
      ["b.py", "a/__init__.py", "a/z.py", "_c.py"],
      ["."],
      [],
    ).keys(),
  ]).toEqual(["_c", "a", "a.z", "b"]));

it("lists each file a claimed name leaves unnamed, with the file that holds the name", () =>
  expect(
    pythonShadowedModules(
      [
        // three roots claim config; the earliest holds it, whatever order the files come in
        "tests/_utils/config/__init__.py",
        "sim/config.py",
        "sim/src/config.py",
        // within one root, the package wins over the module of the same name
        "sim/src/observatory.py",
        "sim/src/observatory/__init__.py",
        // a declared single-file module whose stem a root names is not shadowed by a root
        "tools/config.py",
      ],
      ["sim/src", "sim", "tests/_utils"],
      ["tools/config.py"],
    ),
  ).toEqual([
    {
      path: "sim/config.py",
      name: "config",
      heldBy: "sim/src/config.py",
      by: "root",
    },
    {
      path: "sim/src/observatory.py",
      name: "observatory",
      heldBy: "sim/src/observatory/__init__.py",
      by: "package",
    },
    {
      path: "tests/_utils/config/__init__.py",
      name: "config",
      heldBy: "sim/src/config.py",
      by: "root",
    },
  ]));
