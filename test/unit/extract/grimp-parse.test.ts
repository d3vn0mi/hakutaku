// The grimp driver's output read without the engine: canned JSON of the shape
// python/hakutaku_grimp_driver.py prints.
import { expect, it } from "vitest";
import {
  type GrimpFacts,
  parseGrimpOutput,
} from "../../../src/extract/drivers/grimp.js";

const hop = (importer: string, imported: string, line: number) => ({
  importer,
  imported,
  line,
});

it("reads modules, imports with lines, externals and layer violations", () => {
  const json = JSON.stringify({
    grimp: "3.18",
    modules: ["observatory.b", "observatory", "observatory.a"],
    imports: [
      hop("observatory.b", "observatory.a", 3),
      hop("observatory.a", "json", 1),
      hop("observatory.a", "numpy", 2),
      hop("observatory", "observatory.a", 1),
      hop("observatory.a", "observatory.b", 4),
    ],
    external: ["numpy", "json"],
    layerViolations: [
      {
        name: "sky-layers",
        severity: "error",
        importer: "observatory.b",
        imported: "observatory.a",
        chain: [hop("observatory.b", "observatory.a", 3)],
      },
    ],
    unreadable: [],
    warnings: [],
  });
  const want: GrimpFacts = {
    version: "3.18",
    modules: new Set(["observatory", "observatory.a", "observatory.b"]),
    imports: [
      hop("observatory", "observatory.a", 1),
      hop("observatory.a", "json", 1),
      hop("observatory.a", "numpy", 2),
      hop("observatory.a", "observatory.b", 4),
      hop("observatory.b", "observatory.a", 3),
    ],
    external: new Set(["json", "numpy"]),
    layerViolations: [
      {
        name: "sky-layers",
        severity: "error",
        importer: "observatory.b",
        imported: "observatory.a",
        chain: [hop("observatory.b", "observatory.a", 3)],
      },
    ],
  };
  const facts = parseGrimpOutput(json);
  expect(facts).toStrictEqual(want);
  expect([...facts.modules]).toStrictEqual([...want.modules]);
  expect([...facts.external]).toStrictEqual([...want.external]);
});

it("orders names by UTF-16 code units, whatever order the driver wrote, and drops repeats", () => {
  // an astral letter sorts before a high BMP one in code units, after it in code points
  const astral = `observatory.${String.fromCodePoint(0x1d538)}`;
  const high = `observatory.${String.fromCodePoint(0xff21)}`;
  const facts = parseGrimpOutput(
    JSON.stringify({
      grimp: "3.18",
      modules: [high, astral, "observatory.Zeta", "observatory.alpha", high],
      imports: [
        hop(high, "json", 2),
        hop(astral, "json", 9),
        hop(astral, "json", 1),
        hop("observatory.alpha", "observatory.Zeta", 1),
        hop(astral, "json", 1),
      ],
      external: ["os", "json", "os"],
      layerViolations: [
        {
          name: "sky-layers",
          severity: "warn",
          importer: high,
          imported: "observatory.alpha",
          chain: [hop(high, "observatory.alpha", 4)],
        },
        {
          name: "sky-layers",
          severity: "warn",
          importer: astral,
          imported: "observatory.alpha",
          chain: [
            hop(astral, "observatory.Zeta", 7),
            hop("observatory.Zeta", "observatory.alpha", 2),
          ],
        },
        {
          name: "orbit-layers",
          severity: "error",
          importer: high,
          imported: "observatory.alpha",
          chain: [hop(high, "observatory.alpha", 4)],
        },
        {
          name: "sky-layers",
          severity: "warn",
          importer: astral,
          imported: "observatory.alpha",
          chain: [
            hop(astral, "observatory.Zeta", 7),
            hop("observatory.Zeta", "observatory.alpha", 2),
          ],
        },
      ],
      unreadable: [],
      warnings: [],
    }),
  );
  expect([...facts.modules]).toStrictEqual([
    "observatory.Zeta",
    "observatory.alpha",
    astral,
    high,
  ]);
  expect(facts.imports).toStrictEqual([
    hop("observatory.alpha", "observatory.Zeta", 1),
    hop(astral, "json", 1),
    hop(astral, "json", 9),
    hop(high, "json", 2),
  ]);
  expect([...facts.external]).toStrictEqual(["json", "os"]);
  expect(
    facts.layerViolations.map((v) => [v.name, v.importer, v.chain.length]),
  ).toStrictEqual([
    ["orbit-layers", high, 1],
    ["sky-layers", astral, 2],
    ["sky-layers", high, 1],
  ]);
});

const VALID = {
  grimp: "3.18",
  modules: ["observatory"],
  imports: [hop("observatory", "json", 1)],
  external: ["json"],
  layerViolations: [
    {
      name: "sky-layers",
      severity: "info",
      importer: "observatory.b",
      imported: "observatory.a",
      chain: [hop("observatory.b", "observatory.a", 3)],
    },
  ],
  unreadable: [{ file: "/work/grimp/roots/0/observatory/x.py", reason: "x" }],
  warnings: ["a warning"],
};

it("accepts the valid output these refusals start from", () => {
  expect(parseGrimpOutput(JSON.stringify(VALID)).version).toBe("3.18");
});

it.each<[string, unknown, string]>([
  ["an array", [], "not an object"],
  ["no version", { ...VALID, grimp: 3.18 }, "grimp is not a string"],
  ["no modules", { ...VALID, modules: undefined }, "modules is not an array"],
  [
    "an empty module",
    { ...VALID, modules: [""] },
    "modules[0] is not a module",
  ],
  [
    "a module with an empty part",
    { ...VALID, modules: ["observatory..b"] },
    "modules[0] is not a module",
  ],
  [
    "an import without a line",
    { ...VALID, imports: [{ importer: "observatory", imported: "json" }] },
    "imports[0].line is not a line",
  ],
  [
    "a line 0",
    { ...VALID, imports: [hop("observatory", "json", 0)] },
    "imports[0].line is not a line",
  ],
  [
    "a fractional line",
    { ...VALID, imports: [hop("observatory", "json", 1.5)] },
    "imports[0].line is not a line",
  ],
  [
    "an import of an empty name",
    { ...VALID, imports: [hop("observatory", "", 1)] },
    "imports[0].imported is not a module",
  ],
  [
    "an external that is no module",
    { ...VALID, external: ["json", "."] },
    "external[1] is not a module",
  ],
  [
    "an unknown severity",
    {
      ...VALID,
      layerViolations: [{ ...VALID.layerViolations[0], severity: "fatal" }],
    },
    "layerViolations[0].severity is not error, warn or info",
  ],
  [
    "a violation without a name",
    {
      ...VALID,
      layerViolations: [{ ...VALID.layerViolations[0], name: 1 }],
    },
    "layerViolations[0].name is not a string",
  ],
  [
    "an empty chain",
    {
      ...VALID,
      layerViolations: [{ ...VALID.layerViolations[0], chain: [] }],
    },
    "layerViolations[0].chain is not a list of imports",
  ],
  [
    "a chain step without a line",
    {
      ...VALID,
      layerViolations: [
        {
          ...VALID.layerViolations[0],
          chain: [{ importer: "observatory.b", imported: "observatory.a" }],
        },
      ],
    },
    "layerViolations[0].chain[0].line is not a line",
  ],
  [
    "unreadable files that are not a list",
    { ...VALID, unreadable: "none" },
    "unreadable is not a list of files and reasons",
  ],
  [
    "warnings that are not strings",
    { ...VALID, warnings: [1] },
    "warnings is not a list of strings",
  ],
])("refuses %s", (_what, output, where) => {
  expect(() => parseGrimpOutput(JSON.stringify(output))).toThrow(
    `grimp's output is not in its JSON shape: ${where}`,
  );
});

it("refuses text that is not JSON", () => {
  expect(() => parseGrimpOutput("{ not json")).toThrow(
    /^grimp's output is not JSON \(.+\)$/,
  );
});
