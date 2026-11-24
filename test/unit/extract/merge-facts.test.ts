// The whole merge: every table but the metrics, and the counts beside them, in a form the
// store's writer takes; the coverage built from them, the build's tiers and the export; and
// the redactions every stored text took.
import { expect, it } from "vitest";
import type { AstGrepFacts } from "../../../src/extract/drivers/ast-grep.js";
import {
  coverageOf,
  type MergedContent,
  type MergeInput,
  mergeFacts,
} from "../../../src/extract/merge/index.js";
import type { ScipFacts } from "../../../src/extract/scip/facts.js";
import { findSecrets } from "../../../src/redact/index.js";
import { openStore } from "../../../src/store/index.js";
import { emptyContent, miniStore } from "../../helpers/mini-store.js";
import {
  astGrep,
  callFact,
  importFact,
  lines,
  mergeInput,
  outlineDef,
  P,
  SIM,
  scip,
  spot,
  symbolOf,
} from "./merge-input.js";

const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const high = (n: number) =>
  Array.from({ length: n }, (_, i) => ALPHA[(i * 37 + 11) % ALPHA.length]).join(
    "",
  );
const join = (...parts: string[]) => parts.join("");

const KEPLER = "web/src/orbits/kepler.ts";
const CAMERA = "web/src/sky/camera.ts";
const TEST = "web/src/orbits/kepler.test.ts";
const CLI = "web/src/cli.ts";

const classText = (name: string) =>
  lines(
    `export class ${name} {`,
    "  position(t: number): number {",
    "    return t;",
    "  }",
    "}",
  );

const classDefs = (file: string, name: string) => [
  outlineDef(
    file,
    name,
    "class",
    P(1, 8),
    P(5, 2),
    [P(1, 14)],
    `export class ${name} {`,
    true,
  ),
  outlineDef(
    file,
    `${name}.position`,
    "method",
    P(2, 3),
    P(4, 4),
    [P(2, 3)],
    "position(t: number): number {",
    true,
  ),
];

const classSymbols = (file: string, name: string) => [
  { file, at: P(1, 14), symbol: symbolOf(file, `${name}#`) },
  { file, at: P(2, 3), symbol: symbolOf(file, `${name}#position().`) },
];

// cli.ts and kepler.test.ts make an Orbit and call position; the test also imports Camera,
// which two forbidden rules, listed out of name order, both flag.
function whole(): MergeInput {
  const TEST_TEXT = lines(
    'import { Orbit } from "./kepler";',
    'import { Camera } from "../sky/camera";',
    "const orbit = new Orbit();",
    "orbit.position(0);",
  );
  const CLI_TEXT = lines(
    'import { readFileSync } from "node:fs";',
    'import { Orbit } from "./orbits/kepler";',
    "new Orbit().position(readFileSync.length);",
  );
  const ORBIT = symbolOf(KEPLER, "Orbit#");
  const POSITION = symbolOf(KEPLER, "Orbit#position().");
  const use = (file: string, at: ReturnType<typeof P>, symbol: string) => ({
    file,
    at,
    symbol,
    roles: 0,
  });
  const base = mergeInput(
    {
      [CAMERA]: classText("Camera"),
      [CLI]: CLI_TEXT,
      [KEPLER]: classText("Orbit"),
      [TEST]: TEST_TEXT,
      "web/package.json":
        '{ "name": "web", "bin": { "sky": "./src/cli.ts" } }\n',
    },
    {
      facts: {
        astGrep: astGrep({
          defs: [...classDefs(KEPLER, "Orbit"), ...classDefs(CAMERA, "Camera")],
          calls: [
            callFact(CLI, spot(CLI_TEXT, 3, "Orbit"), "Orbit"),
            callFact(CLI, spot(CLI_TEXT, 3, "position"), "position"),
            callFact(TEST, spot(TEST_TEXT, 3, "Orbit"), "Orbit"),
            callFact(TEST, spot(TEST_TEXT, 4, "position"), "position", "orbit"),
          ],
          imports: [
            importFact(
              CLI,
              spot(CLI_TEXT, 1, '"node:fs"'),
              "node:fs",
              "static",
              ["readFileSync"],
            ),
            importFact(
              CLI,
              spot(CLI_TEXT, 2, '"./orbits/kepler"'),
              "./orbits/kepler",
              "static",
              ["Orbit"],
            ),
            importFact(
              TEST,
              spot(TEST_TEXT, 1, '"./kepler"'),
              "./kepler",
              "static",
              ["Orbit"],
            ),
            importFact(
              TEST,
              spot(TEST_TEXT, 2, '"../sky/camera"'),
              "../sky/camera",
              "static",
              ["Camera"],
            ),
          ],
        }),
        scip: scip({
          documents: new Set([CAMERA, CLI, KEPLER, TEST]),
          definitions: [
            ...classSymbols(CAMERA, "Camera"),
            ...classSymbols(KEPLER, "Orbit"),
          ],
          uses: [
            use(CLI, spot(CLI_TEXT, 2, "Orbit"), ORBIT),
            use(CLI, spot(CLI_TEXT, 3, "Orbit"), ORBIT),
            use(CLI, spot(CLI_TEXT, 3, "position"), POSITION),
            use(TEST, spot(TEST_TEXT, 1, "Orbit"), ORBIT),
            use(
              TEST,
              spot(TEST_TEXT, 2, "Camera"),
              symbolOf(CAMERA, "Camera#"),
            ),
            use(TEST, spot(TEST_TEXT, 4, "position"), POSITION),
          ],
        }),
      },
    },
  );
  return {
    ...base,
    rules: {
      schema: 1 as const,
      forbidden: [
        {
          name: "tests-not-sky",
          severity: "warn" as const,
          from: { path: "\\.test\\.ts$" },
          to: { path: "/sky/" },
        },
        {
          name: "no-camera-in-tests",
          severity: "error" as const,
          from: { path: "\\.test\\.ts$" },
          to: { path: "camera" },
        },
      ],
    },
  };
}

// The same input with every list an engine or the rules file gives in reverse order.
function reversed(input: MergeInput): MergeInput {
  const facts = input.astGrep as AstGrepFacts;
  const compiled = input.scip as ScipFacts;
  return {
    ...input,
    astGrep: {
      ...facts,
      defs: [...facts.defs].reverse(),
      calls: [...facts.calls].reverse(),
      imports: [...facts.imports].reverse(),
    },
    scip: {
      ...compiled,
      definitions: [...compiled.definitions].reverse(),
      uses: [...compiled.uses].reverse(),
    },
    rules: {
      schema: 1,
      forbidden: [...(input.rules?.forbidden ?? [])].reverse(),
    },
  };
}

it("writes the merged rows with the store's writer", () => {
  const input = whole();
  const merged = mergeFacts(input);
  const { content } = merged;
  const tables: Array<keyof MergedContent> = [
    "components",
    "files",
    "sources",
    "definitions",
    "externals",
    "imports",
    "call_sites",
    "call_targets",
    "refs",
    "entry_points",
    "rule_findings",
    "text_index",
  ];
  expect(Object.keys(content).sort()).toEqual([...tables].sort());
  // every table holds rows, so the writer checks each one's order and references
  for (const table of tables) expect(content[table].length).toBeGreaterThan(0);

  const empty = emptyContent();
  const coverage = coverageOf({
    input,
    ...merged,
    tiers: { "ast-grep": "ran", "scip-typescript": "ran" },
    cycleDifferences: 0,
  });
  const path = miniStore({
    ...empty,
    ...content,
    meta: [{ ...(empty.meta[0] as (typeof empty.meta)[0]), coverage }],
  });
  const store = openStore(path);
  if ("code" in store) throw new Error(store.reason);
  try {
    for (const table of tables) {
      const { n } = store.db
        .prepare(`SELECT count(*) AS n FROM ${table}`)
        .get() as { n: number };
      expect([table, n]).toEqual([table, content[table].length]);
    }
  } finally {
    store.close();
  }
});

it("gives the same rows whatever order the engines and the rules file list their facts in", () => {
  const input = whole();
  const merged = mergeFacts(input);
  // two findings, sorted by rule name, so that a list taken as given is out of order
  expect(merged.content.rule_findings.map((r) => r.rule)).toEqual([
    "no-camera-in-tests",
    "tests-not-sky",
  ]);
  expect(merged.content.call_sites.length).toBeGreaterThan(1);
  expect(merged.content.refs.length).toBeGreaterThan(1);
  expect(mergeFacts(reversed(input))).toEqual(merged);
});

it("builds coverage from the merge, the build's tiers and the export", () => {
  const A = "web/src/a.ts";
  const A_TEXT = lines(
    'import "./missing";',
    "export const load = (name: string) => import(name);",
  );
  const DUPLICATE = symbolOf(A, "load.");
  const base = mergeInput(
    {
      "sim/src/observatory/__init__.py": "",
      [A]: A_TEXT,
      "web/src/gen.ts": lines("export const gen = 1;"),
    },
    {
      profile: SIM,
      metadataOnly: { "web/src/gen.ts": "generated" },
      facts: {
        pythonResolver: "hakutaku-resolver",
        astGrep: astGrep({
          imports: [
            importFact(
              A,
              spot(A_TEXT, 1, '"./missing"'),
              "./missing",
              "side-effect",
            ),
          ],
          computed: [{ file: A, line: 2 }],
        }),
        // load has no outline definition here, so its SCIP definition joins nothing
        scip: scip({
          documents: new Set([A]),
          definitions: [
            { file: A, at: P(1, 1), symbol: symbolOf(A, "") },
            { file: A, at: spot(A_TEXT, 2, "load"), symbol: DUPLICATE },
          ],
          duplicates: [DUPLICATE],
        }),
      },
    },
  );
  const input = {
    ...base,
    manifest: { ...base.manifest, denied: 3 },
    rules: { schema: 1 as const, cycles: { severity: "error" as const } },
  };
  const merged = mergeFacts(input);
  expect(merged.side).toEqual({
    relative: { total: 1, unresolved: 1 },
    indexed: new Map([
      ["python", new Set(["sim/src/observatory/__init__.py"])],
      ["typescript", new Set([A])],
    ]),
    scipDuplicates: [DUPLICATE],
    redactions: 0,
    computedImports: 1,
    unmatchedScipDefinitions: 1,
    unmatchedBoundUses: 0,
    warnings: [],
  });
  const tiers = {
    "ast-grep": "ran",
    "dependency-cruiser": "failed",
    grimp: "fallback",
    "scip-typescript": "ran",
  } as const;
  const coverage = coverageOf({ input, ...merged, tiers, cycleDifferences: 2 });
  expect(coverage).toEqual({
    files: 3,
    indexed: { python: 1, typescript: 1 },
    unresolvedImports: 1,
    callSites: { bound: 0, scoped: 0, unresolved: 0 },
    redactions: 0,
    tiers,
    pythonResolver: "hakutaku-resolver",
    computedImports: 1,
    unmatchedScipDefinitions: 1,
    unmatchedBoundUses: 0,
    cycleDifferences: 2,
    noSourceFiles: 1,
    denied: 3,
    cycleSeverity: "error",
  });
  // without a rules file, cycles are warnings
  expect(
    coverageOf({
      input: { ...input, rules: null },
      ...merged,
      tiers,
      cycleDifferences: 2,
    }).cycleSeverity,
  ).toBe("warn");
});

it("sums the redactions of sources, signatures, receivers, specifiers, entry names, external names and link targets", () => {
  const LINK = "web/src/link.ts";
  const github = join("gh", "p_", high(36));
  const SIGNATURE = `export function connect(t = "${github}") {}`;
  const LINK_TEXT = lines(
    `import "https://example.invalid/${github}";`,
    SIGNATURE,
    `${github}.connect();`,
    `import "${github}";`,
  );
  const input = mergeInput(
    {
      ".github/workflows/sky.yml": lines(
        "jobs:",
        "  check:",
        "    steps:",
        `      - run: node scripts/check.mjs --token ${github}`,
      ),
      "scripts/check.mjs": lines("console.log('check');"),
      [LINK]: LINK_TEXT,
    },
    {
      facts: {
        astGrep: astGrep({
          defs: [
            outlineDef(
              LINK,
              "connect",
              "function",
              P(2, 8),
              P(2, SIGNATURE.length + 1),
              [P(2, 17)],
              SIGNATURE,
              true,
            ),
          ],
          calls: [
            callFact(LINK, spot(LINK_TEXT, 3, "connect"), "connect", github),
          ],
          imports: [
            importFact(
              LINK,
              P(1, 8),
              `https://example.invalid/${github}`,
              "side-effect",
            ),
            importFact(LINK, P(4, 8), github, "side-effect"),
          ],
        }),
      },
      links: { "keys/current": `../vault/${github}` },
    },
  );
  const { content, side } = mergeFacts(input);
  // the CI step is the one entry point
  expect(content.entry_points).toHaveLength(1);
  // the workflow's source and its entry name, link.ts' source (four tokens), the two
  // specifiers, the signature, the receiver, the external's name and the link's target
  expect(side.redactions).toBe(12);
  const stored = [
    ...content.sources.map((s) => s.text),
    ...content.text_index.map((t) => t.text),
    ...content.definitions.flatMap((d) => d.signature ?? []),
    ...content.call_sites.flatMap((s) => s.receiver_text ?? []),
    ...content.imports.map((i) => i.specifier),
    ...content.entry_points.map((e) => e.name),
    ...content.externals.map((e) => e.name),
    ...content.files.flatMap((f) => f.link_target ?? []),
  ];
  expect(content.externals.map((e) => e.name)).toEqual([
    "«redacted:github-token»",
  ]);
  expect(stored.flatMap(findSecrets)).toEqual([]);
});

it("keeps an entry point that only its test imports in production, after the entry points are known", () => {
  const ENTRY = "web/src/cli/export-sky.ts";
  const CHECK = "web/src/cli/export-sky.test.ts";
  const CLOCK = "web/src/testing/fake-clock.ts";
  const CHECK_TEXT = lines(
    'import { main } from "./export-sky";',
    'import { now } from "../testing/fake-clock";',
    "main(now);",
  );
  const input = mergeInput(
    {
      "web/package.json":
        '{ "name": "web", "bin": { "sky": "./dist/cli/export-sky.js" } }\n',
      [CHECK]: CHECK_TEXT,
      [ENTRY]: lines("export function main(t: number) {}"),
      [CLOCK]: lines("export const now = 0;"),
    },
    {
      facts: {
        astGrep: astGrep({
          imports: [
            importFact(
              CHECK,
              spot(CHECK_TEXT, 1, '"./export-sky"'),
              "./export-sky",
              "static",
              ["main"],
            ),
            importFact(
              CHECK,
              spot(CHECK_TEXT, 2, '"../testing/fake-clock"'),
              "../testing/fake-clock",
              "static",
              ["now"],
            ),
          ],
        }),
      },
    },
  );
  const { content } = mergeFacts(input);
  // the package's bin launches export-sky.ts: an entry point stays production though only
  // its test imports it, while fake-clock.ts becomes test support
  expect(content.files.map((f) => [f.path, f.kind, f.entry])).toEqual([
    ["web/package.json", "config", 0],
    [CHECK, "test", 0],
    [ENTRY, "code", 1],
    [CLOCK, "test-support", 0],
  ]);
});

it("records the importable Python modules another file shadows in coverage, and the store keeps them", () => {
  const input = mergeInput(
    {
      "sim/src/config.py": "",
      "sim/src/observatory/__init__.py": "",
      "sim/src/observatory/orbit.py": "",
      "sim/src/observatory/orbit/__init__.py": "",
      "tools/config/__init__.py": "",
    },
    {
      profile: {
        python: { roots: ["sim/src", "tools"], singleFileModules: [] },
      },
    },
  );
  const merged = mergeFacts(input);
  const coverage = coverageOf({
    input,
    ...merged,
    tiers: {},
    cycleDifferences: 0,
  });
  const shadowed = [
    {
      path: "sim/src/observatory/orbit.py",
      name: "observatory.orbit",
      heldBy: "sim/src/observatory/orbit/__init__.py",
      by: "package",
    },
    {
      path: "tools/config/__init__.py",
      name: "config",
      heldBy: "sim/src/config.py",
      by: "root",
    },
  ];
  expect(coverage.shadowedPython).toEqual(shadowed);
  const empty = emptyContent();
  const store = openStore(
    miniStore({
      ...empty,
      meta: [{ ...(empty.meta[0] as (typeof empty.meta)[0]), coverage }],
    }),
  );
  if ("code" in store) throw new Error(store.reason);
  try {
    expect(store.meta.coverage.shadowedPython).toEqual(shadowed);
  } finally {
    store.close();
  }
  // a build with nothing shadowed has no such key, so its coverage reads as before
  const plain = mergeInput(
    { "sim/src/observatory/__init__.py": "" },
    { profile: SIM },
  );
  expect(
    Object.keys(
      coverageOf({
        input: plain,
        ...mergeFacts(plain),
        tiers: {},
        cycleDifferences: 0,
      }),
    ),
  ).not.toContain("shadowedPython");
});
