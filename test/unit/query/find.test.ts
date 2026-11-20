import { expect, it } from "vitest";
import { type QueryOut, queryFind } from "../../../src/query/index.js";
import type { Store } from "../../../src/store/index.js";
import type { Checked, FindAnswer } from "../../../src/tools/types.js";
import { openTiny, TINY_CTX } from "../../helpers/tiny.js";

const answer = (out: QueryOut<FindAnswer>): FindAnswer => {
  if (!out.ok) throw new Error(`an error: ${JSON.stringify(out.error)}`);
  return out.answer;
};

type Args = Partial<Checked<"code_find">> & { name: string };

const s = openTiny();
const f = (a: Args, store: Store = s) =>
  answer(queryFind(store, { repo: "tiny", limit: 20, ...a }, TINY_CTX));

it("puts exact matches first, then labelled near misses", () => {
  expect(f({ name: "position" }).matches.map((m) => [m.id, m.match])).toEqual([
    ["tiny:lib/orbit.ts#Orbit.position", "exact"],
    ["tiny:lib/camera.ts#Camera.position", "exact"],
  ]);
  expect(f({ name: "orbit" }).matches.map((m) => [m.id, m.match])).toEqual([
    ["tiny:lib/orbit.ts#Orbit", "case"],
    ["tiny:lib/orbit.ts", "prefix"],
    ["tiny:lib/orbit.ts#Orbit.position", "prefix"],
    ["tiny:lib/orbit.test.ts", "prefix"],
  ]);
});

it("shapes definition and file matches", () => {
  const m = f({ name: "position" }).matches[0];
  expect(m).toEqual({
    id: "tiny:lib/orbit.ts#Orbit.position",
    kind: "method",
    match: "exact",
    line: 12,
    container: "tiny:lib/orbit.ts#Orbit",
    exported: true,
    usedByFiles: 1,
  });
  expect(f({ name: "orbit", kind: "file" }).matches).toEqual([
    { id: "tiny:lib/orbit.ts", kind: "file", match: "prefix" },
    { id: "tiny:lib/orbit.test.ts", kind: "test-file", match: "prefix" },
  ]);
  expect(f({ name: "<module>" }).matches).toEqual([]);
  expect(Object.keys(f({ name: "x" }))).toEqual([
    "query",
    "builtCommit",
    "stale",
    "matches",
  ]);
});

it("filters by kind, and contains a top-level definition in its file", () => {
  expect(f({ name: "orbit", kind: "class" }).matches).toEqual([
    {
      id: "tiny:lib/orbit.ts#Orbit",
      kind: "class",
      match: "case",
      line: 10,
      container: "tiny:lib/orbit.ts",
      exported: true,
      usedByFiles: 1,
    },
  ]);
  expect(f({ name: "orbit", kind: "method" }).matches.map((m) => m.id)).toEqual(
    ["tiny:lib/orbit.ts#Orbit.position"],
  );
  expect(f({ name: "readme" }).matches).toEqual([
    { id: "tiny:README.md", kind: "file", match: "prefix" },
  ]);
});

it("orders by level before rank, then by line within a file", () => {
  expect(f({ name: "main" }).matches.map((m) => [m.id, m.match])).toEqual([
    ["tiny:app/main.ts#main", "exact"],
    ["tiny:scripts/sync-#main", "exact"],
    ["tiny:app/main.ts", "prefix"],
  ]);
  expect(f({ name: "helper" }).matches.map((m) => [m.id, m.line])).toEqual([
    ["tiny:py/pkg/util.py#helper", 1],
    ["tiny:py/pkg/util.py#helper(2)", 4],
  ]);
  expect(f({ name: "Orb" }).query).toBe("Orb");
});
