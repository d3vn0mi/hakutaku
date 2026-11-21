// Rule findings: dependency-cruiser's violations for TS and JS, or, when it did not run,
// hakutaku's own reading of the forbidden rules over the TS and JS imports; hakutaku's reading
// over the Python imports; and grimp's layer violations. Each finding's chain is in repo paths.
import { expect, it } from "vitest";
import type { DepcruiseFacts } from "../../../src/extract/drivers/depcruise.js";
import type { GrimpFacts } from "../../../src/extract/drivers/grimp.js";
import { mergeFacts } from "../../../src/extract/merge/index.js";
import type { Rules } from "../../../src/profile/index.js";
import type { RuleFindingRow } from "../../../src/store/index.js";
import {
  astGrep,
  importFact,
  lines,
  mergeInput,
  P,
  SIM,
} from "./merge-input.js";

const PY = "sim/src/observatory";
const MODEL = `${PY}/core/model.py`;
const BRIDGE = `${PY}/core/bridge.py`;
const VIEW = `${PY}/ui/view.py`;
const B = "web/src/ui/b.ts";

const finding = (
  id: number,
  rule: string,
  severity: RuleFindingRow["severity"],
  from_file_id: number,
  to_file_id: number,
  chain: RuleFindingRow["chain"],
  producer: RuleFindingRow["producer"],
): RuleFindingRow => ({
  id,
  rule,
  severity,
  from_file_id,
  to_file_id,
  chain,
  producer,
});

it("evaluates forbidden rules over Python edges, and over TS edges when dependency-cruiser did not run", () => {
  const A = "web/src/core/a.ts";
  const C = "web/src/core/c.ts";
  const D = "web/src/core/d.ts";
  const FILES = {
    [`${PY}/__init__.py`]: "",
    [`${PY}/core/__init__.py`]: "",
    [MODEL]: lines(
      "from observatory.ui import view",
      "from observatory.ui.view import show",
    ),
    [`${PY}/ui/__init__.py`]: "",
    [VIEW]: lines("def show():", "    pass"),
    [A]: lines('import { b } from "../ui/b";'),
    [C]: lines('import { a } from "./a";'),
    [D]: lines('import { b } from "../ui/b";'),
    [B]: lines("export const b = 1;"),
  };
  // one rule for both languages: a path under core/ imports none under ui/. Listed twice,
  // it still gives each finding once
  const CORE_NOT_UI = {
    name: "core-not-ui",
    severity: "error" as const,
    from: { path: "/core/" },
    to: { path: "/ui/" },
  };
  const RULES: Rules = { schema: 1, forbidden: [CORE_NOT_UI, CORE_NOT_UI] };
  const facts = astGrep({
    imports: [
      // two imports of view.py: one finding, at the first line
      importFact(MODEL, P(1, 6), "observatory.ui", "static", ["view"]),
      importFact(MODEL, P(2, 6), "observatory.ui.view", "static", ["show"]),
      importFact(A, P(1, 19), "../ui/b", "static", ["b"]),
      importFact(C, P(1, 19), "./a", "static", ["a"]),
      importFact(D, P(1, 19), "../ui/b", "static", ["b"]),
    ],
  });
  const depcruise: DepcruiseFacts = {
    modules: new Set([A, B, C, D]),
    edges: [
      { from: A, specifier: "../ui/b", to: B, external: null, typeOnly: false },
      { from: C, specifier: "./a", to: A, external: null, typeOnly: false },
      { from: D, specifier: "../ui/b", to: B, external: null, typeOnly: false },
    ],
    violations: [{ rule: "core-not-ui", severity: "error", from: A, to: B }],
    circular: new Set(),
  };
  // Files: 1-2 the packages' __init__.py, 3 model.py, 4 ui/__init__.py, 5 view.py, 6 a.ts,
  // 7 c.ts, 8 d.ts, 9 b.ts
  const python = finding(
    1,
    "core-not-ui",
    "error",
    3,
    5,
    [{ from: MODEL, to: VIEW, line: 1 }],
    "hakutaku",
  );

  const read = mergeFacts({
    ...mergeInput(FILES, { profile: SIM, facts: { astGrep: facts } }),
    rules: RULES,
  });
  expect(read.content.rule_findings).toEqual([
    python,
    finding(
      2,
      "core-not-ui",
      "error",
      6,
      9,
      [{ from: A, to: B, line: 1 }],
      "hakutaku",
    ),
    finding(
      3,
      "core-not-ui",
      "error",
      8,
      9,
      [{ from: D, to: B, line: 1 }],
      "hakutaku",
    ),
  ]);

  // dependency-cruiser ran: its violations are the TS findings, and hakutaku reads Python
  // alone, so d.ts, which it did not report, gets none
  const cruised = mergeFacts({
    ...mergeInput(FILES, {
      profile: SIM,
      facts: { astGrep: facts, depcruise },
    }),
    rules: RULES,
  });
  expect(cruised.content.rule_findings).toEqual([
    python,
    finding(
      2,
      "core-not-ui",
      "error",
      6,
      9,
      [{ from: A, to: B, line: 1 }],
      "dependency-cruiser",
    ),
  ]);
});

it("takes grimp's layer violations with their chains in repo paths, and dependency-cruiser's only along an import the store holds", () => {
  const BLOB = "web/src/blob.ts";
  const FILES = {
    [`${PY}/__init__.py`]: "",
    [`${PY}/core/__init__.py`]: "",
    [BRIDGE]: lines("from observatory.ui import view"),
    [MODEL]: lines("import os", "from observatory.core import bridge"),
    [`${PY}/ui/__init__.py`]: "",
    [VIEW]: lines("def show():", "    pass"),
    // a NUL byte makes it other: the store keeps none of its imports
    [BLOB]: 'import { b } from "./ui/b";\0\n',
    [B]: lines("export const b = 1;"),
  };
  const RULES: Rules = {
    schema: 1,
    forbidden: [
      {
        name: "no-ui-imports",
        severity: "error",
        from: { path: "^web/" },
        to: { path: "^web/src/ui/" },
      },
    ],
    layers: [
      {
        name: "ui-over-core",
        severity: "warn",
        layers: ["observatory.ui", "observatory.core"],
      },
    ],
  };
  const grimp: GrimpFacts = {
    version: "3.18",
    modules: new Set([
      "observatory",
      "observatory.core",
      "observatory.core.bridge",
      "observatory.core.model",
      "observatory.ui",
      "observatory.ui.view",
    ]),
    imports: [
      {
        importer: "observatory.core.bridge",
        imported: "observatory.ui.view",
        line: 1,
      },
      {
        importer: "observatory.core.model",
        imported: "observatory.core.bridge",
        line: 2,
      },
    ],
    external: new Set(["os"]),
    layerViolations: [
      {
        name: "ui-over-core",
        severity: "warn",
        importer: "observatory.core.model",
        imported: "observatory.ui.view",
        chain: [
          {
            importer: "observatory.core.model",
            imported: "observatory.core.bridge",
            line: 2,
          },
          {
            importer: "observatory.core.bridge",
            imported: "observatory.ui.view",
            line: 1,
          },
        ],
      },
    ],
  };
  const depcruise: DepcruiseFacts = {
    modules: new Set([B, BLOB]),
    edges: [
      {
        from: BLOB,
        specifier: "./ui/b",
        to: B,
        external: null,
        typeOnly: false,
      },
    ],
    violations: [
      { rule: "no-ui-imports", severity: "error", from: BLOB, to: B },
    ],
    circular: new Set(),
  };
  const { content, side } = mergeFacts({
    ...mergeInput(FILES, {
      profile: SIM,
      facts: { depcruise, grimp, pythonResolver: "grimp" },
    }),
    rules: RULES,
  });
  // Files: 1-2 the packages' __init__.py, 3 bridge.py, 4 model.py, 5 ui/__init__.py,
  // 6 view.py, 7 blob.ts, 8 b.ts. Each module is its file, each hop one import
  expect(content.rule_findings).toEqual([
    finding(
      1,
      "ui-over-core",
      "warn",
      4,
      6,
      [
        { from: MODEL, to: BRIDGE, line: 2 },
        { from: BRIDGE, to: VIEW, line: 1 },
      ],
      "grimp",
    ),
  ]);
  expect(side.warnings).toEqual([
    `${BLOB}: dependency-cruiser reports the rule "no-ui-imports" on an import of ${B} that the store does not hold; left out`,
  ]);
});
