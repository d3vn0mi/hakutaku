import { expect, it } from "vitest";
import type { Severity } from "../../../src/model/index.js";
import {
  cycleSeverityOf,
  type QueryCtx,
  type QueryOut,
  queryRules,
} from "../../../src/query/index.js";
import { openStore, type Store } from "../../../src/store/index.js";
import type { RulesAnswer } from "../../../src/tools/types.js";
import { emptyContent, miniStore } from "../../helpers/mini-store.js";
import { openTiny, TINY_CTX } from "../../helpers/tiny.js";

const answer = (out: QueryOut<RulesAnswer>): RulesAnswer => {
  if (!out.ok) throw new Error(`an error: ${JSON.stringify(out.error)}`);
  return out.answer;
};

const r = (store: Store, q: QueryCtx = TINY_CTX) =>
  queryRules(store, { repo: q.repo, limit: 100 }, q);

it("lists violations and cycles in one ordered list", () => {
  const a = answer(r(openTiny()));
  expect(JSON.stringify(a)).toBe(
    JSON.stringify({
      builtCommit: "0123456789ab",
      stale: false,
      findings: [
        {
          kind: "violation",
          id: "tiny:lib/loader.ts",
          severity: "error",
          rule: "lib-not-app",
          from: "tiny:lib/loader.ts",
          to: "tiny:app/main.ts",
          chain: [
            { from: "tiny:lib/loader.ts", to: "tiny:app/main.ts", line: 1 },
          ],
        },
        {
          kind: "cycle",
          id: "tiny:lib/consts.ts",
          severity: "warn",
          files: ["tiny:lib/consts.ts", "tiny:lib/units.ts"],
          chain: [
            { from: "tiny:lib/consts.ts", to: "tiny:lib/units.ts", line: 1 },
            { from: "tiny:lib/units.ts", to: "tiny:lib/consts.ts", line: 1 },
          ],
        },
      ],
    }),
  );
});

it("takes the cycles' severity from the store", () => {
  const a = answer(r(openTiny({ cycleSeverity: "error" })));
  expect(a.findings.map((f) => [f.kind, f.severity])).toEqual([
    ["cycle", "error"],
    ["violation", "error"],
  ]);
});

it("reads the cycle severity in one place, and warn when the store gives none", () => {
  expect(cycleSeverityOf(openTiny({ cycleSeverity: "info" }))).toBe("info");
  expect(cycleSeverityOf(openTiny())).toBe("warn");
  expect(cycleSeverityOf({ meta: { coverage: {} } } as unknown as Store)).toBe(
    "warn",
  );
});

// The rules store. Cycle 1 is the set {a.ts, b.ts, e.ts}, closed by the chain a.ts -> b.ts ->
// a.ts; cycle 2 is {c.ts, d.ts, z.ts}, closed by c.ts -> z.ts -> d.ts -> c.ts; cycle 3 is x.ts,
// which imports itself. The rule findings tie in every way the order breaks, and two of them
// come from a#.ts and a$.ts, and three others go to them, whose paths and IDs sort the other way
// round. The rows are in the writer's order, (rule, from path, to path), so the row id, which
// follows the paths, can never stand in for the ID, rule or to comparisons.
const R_CTX: QueryCtx = Object.freeze({
  repo: "r",
  builtCommit: "fedcba987654",
  stale: true,
  snippets: true,
});

function rulesStore(cycleSeverity: Severity = "warn"): Store {
  const c = emptyContent("r");
  const [meta] = c.meta;
  if (meta === undefined) throw new Error("emptyContent has no meta row");
  c.meta = [{ ...meta, coverage: { ...meta.coverage, cycleSeverity } }];
  const paths = [
    "a#.ts",
    "a$.ts",
    "a.ts",
    "b.ts",
    "c.ts",
    "d.ts",
    "e.ts",
    "x.ts",
    "z.ts",
  ];
  const file = (path: string) => paths.indexOf(path) + 1;
  c.files = paths.map((path, i) => ({
    id: i + 1,
    path,
    lang: "typescript",
    kind: "code",
    component_id: null,
    lines: 9,
    bytes: 90,
    blob_sha: "c".repeat(40),
    mode: "100644",
    link_target: null,
    entry: 0,
    has_source: 0,
  }));
  const cycleOf = new Map([
    ["a.ts", 1],
    ["b.ts", 1],
    ["e.ts", 1],
    ["c.ts", 2],
    ["d.ts", 2],
    ["z.ts", 2],
    ["x.ts", 3],
  ]);
  c.file_metrics = paths.map((path, i) => ({
    file_id: i + 1,
    pagerank: 0.1,
    dependents_rank: i + 1,
    fan_in: 1,
    fan_out: 1,
    churn_90d: 0,
    hotspot: 0,
    cycle_id: cycleOf.get(path) ?? null,
    core: 0,
    last_change: null,
  }));
  // cycle, place along its chain, file, the line that imports the next file
  const cycles: [number, number, string, number][] = [
    [1, 0, "a.ts", 1],
    [1, 1, "b.ts", 2],
    [2, 0, "c.ts", 5],
    [2, 1, "z.ts", 6],
    [2, 2, "d.ts", 7],
    [3, 0, "x.ts", 3],
  ];
  c.cycles = cycles.map(([cycle_id, ord, path, line]) => ({
    cycle_id,
    ord,
    file_id: file(path),
    line,
  }));
  // rule, severity, from, to, chain as [from, to, line]
  const findings: [
    string,
    Severity,
    string,
    string,
    [string, string, number][],
  ][] = [
    ["a-rule", "warn", "b.ts", "a#.ts", [["b.ts", "a#.ts", 1]]],
    ["a-rule", "warn", "b.ts", "a$.ts", [["b.ts", "a$.ts", 2]]],
    ["b-rule", "warn", "b.ts", "a$.ts", [["b.ts", "a$.ts", 1]]],
    [
      "b-rule",
      "error",
      "c.ts",
      "a.ts",
      [
        ["c.ts", "d.ts", 3],
        ["d.ts", "a.ts", 4],
      ],
    ],
    ["c-rule", "info", "a.ts", "b.ts", [["a.ts", "b.ts", 9]]],
    ["d-rule", "info", "a#.ts", "b.ts", [["a#.ts", "b.ts", 1]]],
    ["d-rule", "info", "a$.ts", "b.ts", [["a$.ts", "b.ts", 1]]],
  ];
  c.rule_findings = findings.map(([rule, severity, from, to, chain], i) => ({
    id: i + 1,
    rule,
    severity,
    from_file_id: file(from),
    to_file_id: file(to),
    chain: chain.map(([f, t, line]) => ({ from: f, to: t, line })),
    producer: "dependency-cruiser",
  }));
  const store = openStore(miniStore(c));
  if ("code" in store) throw new Error(`the rules store: ${store.reason}`);
  return store;
}

it("lists a cycle's whole strongly connected set in path order, beside the chain that closes it", () => {
  const a = answer(r(rulesStore(), R_CTX));
  const cycles = a.findings.filter((f) => f.kind === "cycle");
  expect(JSON.stringify(cycles)).toBe(
    JSON.stringify([
      {
        kind: "cycle",
        id: "r:a.ts",
        severity: "warn",
        files: ["r:a.ts", "r:b.ts", "r:e.ts"],
        chain: [
          { from: "r:a.ts", to: "r:b.ts", line: 1 },
          { from: "r:b.ts", to: "r:a.ts", line: 2 },
        ],
      },
      {
        kind: "cycle",
        id: "r:c.ts",
        severity: "warn",
        files: ["r:c.ts", "r:d.ts", "r:z.ts"],
        chain: [
          { from: "r:c.ts", to: "r:z.ts", line: 5 },
          { from: "r:z.ts", to: "r:d.ts", line: 6 },
          { from: "r:d.ts", to: "r:c.ts", line: 7 },
        ],
      },
      {
        kind: "cycle",
        id: "r:x.ts",
        severity: "warn",
        files: ["r:x.ts"],
        chain: [{ from: "r:x.ts", to: "r:x.ts", line: 3 }],
      },
    ]),
  );
});

it("turns a violation's chain into IDs, and gives each finding only its own fields", () => {
  const a = answer(r(rulesStore(), R_CTX));
  expect(Object.keys(a)).toEqual(["builtCommit", "stale", "findings"]);
  expect(a).toMatchObject({ builtCommit: "fedcba987654", stale: true });
  expect(JSON.stringify(a.findings[0])).toBe(
    JSON.stringify({
      kind: "violation",
      id: "r:c.ts",
      severity: "error",
      rule: "b-rule",
      from: "r:c.ts",
      to: "r:a.ts",
      chain: [
        { from: "r:c.ts", to: "r:d.ts", line: 3 },
        { from: "r:d.ts", to: "r:a.ts", line: 4 },
      ],
    }),
  );
  expect(
    a.findings.filter((f) => f.rule === "d-rule").map((f) => f.chain),
  ).toEqual([
    [{ from: "r:a$.ts", to: "r:b.ts", line: 1 }],
    [{ from: "r:a%23.ts", to: "r:b.ts", line: 1 }],
  ]);
});

it("orders by severity, cycles first, then id, then a violation's rule and to", () => {
  const order = (findings: RulesAnswer["findings"]) =>
    findings.map((f) => [f.severity, f.kind, f.id, f.rule ?? "", f.to ?? ""]);
  expect(order(answer(r(rulesStore(), R_CTX)).findings)).toEqual([
    ["error", "violation", "r:c.ts", "b-rule", "r:a.ts"],
    ["warn", "cycle", "r:a.ts", "", ""],
    ["warn", "cycle", "r:c.ts", "", ""],
    ["warn", "cycle", "r:x.ts", "", ""],
    ["warn", "violation", "r:b.ts", "a-rule", "r:a$.ts"],
    ["warn", "violation", "r:b.ts", "a-rule", "r:a%23.ts"],
    ["warn", "violation", "r:b.ts", "b-rule", "r:a$.ts"],
    ["info", "violation", "r:a$.ts", "d-rule", "r:b.ts"],
    ["info", "violation", "r:a%23.ts", "d-rule", "r:b.ts"],
    ["info", "violation", "r:a.ts", "c-rule", "r:b.ts"],
  ]);
  expect(
    order(answer(r(rulesStore("info"), R_CTX)).findings).map(
      ([severity, kind, id]) => `${severity} ${kind} ${id}`,
    ),
  ).toEqual([
    "error violation r:c.ts",
    "warn violation r:b.ts",
    "warn violation r:b.ts",
    "warn violation r:b.ts",
    "info cycle r:a.ts",
    "info cycle r:c.ts",
    "info cycle r:x.ts",
    "info violation r:a$.ts",
    "info violation r:a%23.ts",
    "info violation r:a.ts",
  ]);
});

it("answers an empty list for a repo with no cycle and no rule finding", () => {
  const store = openStore(miniStore(emptyContent("r")));
  if ("code" in store) throw new Error(store.reason);
  expect(answer(r(store, R_CTX))).toEqual({
    builtCommit: "fedcba987654",
    stale: true,
    findings: [],
  });
});
