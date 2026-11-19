import { expect, it } from "vitest";
import { pythonModuleIndex } from "../../../src/manifests/index.js";

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
