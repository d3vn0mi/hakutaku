// Every hostile case is run by a suite: each case of cases.json whose stage is export or
// extract is named, once, by the test file of its stage, so that a new case cannot go
// untested. The query and viewer cases are left to the suites of the MCP server and the viewer,
// by name. Every case states its positive control.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { HostileCase } from "../helpers/hostile.js";

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

// The cases other suites run.
const ELSEWHERE: readonly string[] = ["injected-comment", "markup-names"];

const STAGES = ["export", "extract"] as const;
type Stage = (typeof STAGES)[number];

// The case ids a test file names: every test whose title starts "<case id>: ", its it( at the
// start of a line, as the formatter lays out each test. A comment, a skipped test (it.skip) or
// a describe names nothing.
function namedCases(source: string): string[] {
  return [...source.matchAll(/^\s*it\(\s*"([a-z0-9][a-z0-9-]*): /gm)].map(
    (m) => m[1] ?? "",
  );
}

// What is wrong with the cases and the names the stage files give, one line per problem.
function caseProblems(
  cases: ReadonlyArray<{ id: string; stage: string; control?: unknown }>,
  named: Readonly<Record<Stage, readonly string[]>>,
  elsewhere: readonly string[],
): string[] {
  const problems: string[] = [];
  const stageOf = new Map(cases.map((c) => [c.id, c.stage]));
  for (const c of cases) {
    if (typeof c.control !== "string" || c.control.trim() === "") {
      problems.push(`${c.id}: no control`);
    }
    if (elsewhere.includes(c.id)) continue;
    if (!(STAGES as readonly string[]).includes(c.stage)) {
      problems.push(`${c.id}: no suite here runs the stage ${c.stage}`);
      continue;
    }
    const times = named[c.stage as Stage].filter((id) => id === c.id).length;
    if (times !== 1) {
      problems.push(`${c.id}: named ${times} times by ${c.stage}.test.ts`);
    }
  }
  for (const stage of STAGES) {
    for (const id of new Set(named[stage])) {
      const stageOfId = stageOf.get(id);
      if (stageOfId === undefined) {
        problems.push(`${id}: named by ${stage}.test.ts, but not a case`);
      } else if (elsewhere.includes(id)) {
        problems.push(`${id}: named by ${stage}.test.ts, but run elsewhere`);
      } else if (stageOfId !== stage) {
        problems.push(
          `${id}: named by ${stage}.test.ts, but its stage is ${stageOfId}`,
        );
      }
    }
  }
  return problems;
}

it("names every export and extract case in the test file of its stage, once each, and gives every case a control", () => {
  const cases: HostileCase[] = JSON.parse(
    read("../../fixtures/hostile/cases.json"),
  );
  const named = {
    export: namedCases(read("./export.test.ts")),
    extract: namedCases(read("./extract.test.ts")),
  };
  expect(caseProblems(cases, named, ELSEWHERE)).toEqual([]);
  // the files name what cases.json holds, not an empty list matched with an empty list
  expect([...named.export, ...named.extract].sort()).toEqual(
    cases
      .filter((c) => !ELSEWHERE.includes(c.id))
      .map((c) => c.id)
      .sort(),
  );
});

it("reads the case ids from test titles, as the formatter lays them out", () => {
  const source = [
    'it("sgconfig: keeps one line", async () => {});',
    "it(",
    '  "dotdot-path: refuses the path",',
    "  async () => {},",
    ");",
    'it("a plain title: with a colon", () => {});',
    '// it("git-config: in a comment", ...)',
    'it.skip("smudge-filter: skipped", () => {});',
    'describe("python-shadow: not a test", () => {});',
    '  it("symlink-host: indented", () => {});',
  ].join("\n");
  expect(namedCases(source)).toEqual([
    "sgconfig",
    "dotdot-path",
    "symlink-host",
  ]);
});

it("names each problem: a case untested or tested twice, a stage with no suite, an unknown or misplaced name, a missing control", () => {
  const control = "a control";
  const cases = [
    { id: "a", stage: "export", control },
    { id: "b", stage: "export", control },
    { id: "c", stage: "extract", control },
    { id: "d", stage: "extract" },
    { id: "e", stage: "query", control },
    { id: "f", stage: "viewer", control },
    { id: "g", stage: "export", control: " " },
  ];
  expect(
    caseProblems(
      cases,
      { export: ["a", "c", "f", "g"], extract: ["c", "d", "d", "x"] },
      ["f"],
    ),
  ).toEqual([
    "b: named 0 times by export.test.ts",
    "d: no control",
    "d: named 2 times by extract.test.ts",
    "e: no suite here runs the stage query",
    "g: no control",
    "c: named by export.test.ts, but its stage is extract",
    "f: named by export.test.ts, but run elsewhere",
    "x: named by extract.test.ts, but not a case",
  ]);
  expect(
    caseProblems(cases.slice(0, 3), { export: ["a", "b"], extract: ["c"] }, []),
  ).toEqual([]);
});
