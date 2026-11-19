import { expect, it } from "vitest";
import { fromToken, toToken, viewOf } from "../../../src/model/tokens.js";
import type { NodeRef } from "../../../src/model/types.js";
import { def, dir, ext, file, R } from "./refs.js";

// every pair in §5.5's tables
it.each<[NodeRef, string]>([
  [file("web/src/orbits/kepler.ts"), "web~src~orbits~kepler.ts"],
  [
    def("web/src/orbits/kepler.ts", "Orbit.position"),
    "web~src~orbits~kepler.ts--Orbit.position",
  ],
  [dir("web/src/orbits/"), "web~src~orbits~"],
  [ext("npm", "react"), "npm:react"],
  [{ kind: "repo", repo: R }, ""],
  [def("scripts/sync-", "main"), "scripts~sync%2D--main"],
  [file("web/a--b/c.ts"), "web~a%2D-b~c.ts"],
  [file("notes~old/x.md"), "notes%7Eold~x.md"],
  [dir("tools/foo-/"), "tools~foo-~"],
  [ext("npm", "@types/node"), "npm:%40types~node"],
  [
    def("web/src/orbits/kepler.test.ts", "<module>"),
    "web~src~orbits~kepler.test.ts--%3Cmodule%3E",
  ],
  [def("web/a.ts", "f", 2), "web~a.ts--f%282%29"],
  [dir("./"), ".~"],
])("toToken and fromToken agree on %j", (ref, token) => {
  expect(toToken(ref)).toBe(token);
  expect(fromToken(R, token)).toEqual(ref);
});
it("splits a token before decoding it", () =>
  expect(fromToken(R, "scripts~sync%2D--main")).toEqual(
    def("scripts/sync-", "main"),
  ));
it("prefixes view with #", () =>
  expect(viewOf(file("web/src/orbits/kepler.ts"))).toBe(
    "#web~src~orbits~kepler.ts",
  ));
it("answers null for a malformed escape", () =>
  expect(fromToken(R, "web~a%2.ts")).toBeNull());

// Beyond the tables: an unknown ecosystem, and tokens toToken never writes, so that
// one token names one node.
it("answers null for an unknown ecosystem", () =>
  expect(fromToken(R, "cargo:serde")).toBeNull());
it.each([
  "web~a%2d.ts", // a lower-case escape
  "web~%41.ts", // an escape of a character that needs none
  "web~a b.ts", // a raw character that needs an escape
  "web/a.ts", // a raw "/"
  "web~a-", // a raw "-" that ends a part
  "web~a%FF.ts", // bytes that are not UTF-8
  "web~a.ts--f%281%29", // an ordinal of 1
  "web~a.ts--", // no qualified name
  "web~--f", // a definition in a directory
  "npm:", // no name
])("answers null for %j, which toToken never writes", (token) =>
  expect(fromToken(R, token)).toBeNull(),
);
