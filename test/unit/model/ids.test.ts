import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { formatId, parseId } from "../../../src/model/ids.js";
import { def, dir, ext, file, R } from "./refs.js";

it("writes every id form", () => {
  expect(formatId(file("web/src/orbits/kepler.ts"))).toBe(
    "observatory:web/src/orbits/kepler.ts",
  );
  expect(formatId(def("web/a.ts", "f", 2))).toBe("observatory:web/a.ts#f(2)");
  expect(formatId(ext("npm", "@types/node"))).toBe(
    "observatory:npm:@types/node",
  );
  expect(formatId(file("a%b#c:d.ts"))).toBe("observatory:a%25b%23c%3Ad.ts");
  expect(formatId(file("tab\there.ts"))).toBe("observatory:tab%09here.ts");
});
it("reads them back", () => {
  expect(parseId("observatory:npm:@types/node")).toEqual(
    ext("npm", "@types/node"),
  );
  expect(parseId("observatory:web/a.ts#f(2)")).toEqual(def("web/a.ts", "f", 2));
  expect(parseId("observatory:web/src/orbits/")).toEqual(
    dir("web/src/orbits/"),
  );
  expect(parseId("observatory:")).toEqual({ kind: "repo", repo: R });
});
it.each([
  "no-colon",
  "Bad Repo:x.ts",
  "observatory:web/a%2.ts",
  "observatory:web/a.ts#f(1)",
  "observatory:cargo:serde",
])("answers null for %s", (id) => expect(parseId(id)).toBeNull());
it("keeps the viewer's codec browser-safe", () => {
  for (const f of ["types", "ids", "tokens", "order"])
    expect(readFileSync(`src/model/${f}.ts`, "utf8")).not.toMatch(
      /from "node:|\bBuffer\b/,
    );
});

// Further forms: the root component, and IDs formatId never writes, so that
// one ID names one node.
it("names the root component ./", () => {
  expect(formatId(dir("./"))).toBe("observatory:./");
  expect(parseId("observatory:./")).toEqual(dir("./"));
});
it.each([
  "observatory:web/a%3a.ts", // a lower-case escape
  "observatory:web/%41.ts", // an escape of a character that needs none
  "observatory:tab\there.ts", // a raw control character
  "observatory:web/a.ts#f(02)", // an ordinal with a leading zero
  "observatory:web/a.ts#f(0)", // an ordinal below 2
  "observatory:web/a.ts#", // no qualified name
  "observatory:web/#f", // a definition in a directory
  "observatory:web//a.ts", // an empty segment
  "observatory:web/../a.ts", // a ".." segment
  "observatory:npm:", // no name
])("answers null for %j, which formatId never writes", (id) =>
  expect(parseId(id)).toBeNull(),
);
