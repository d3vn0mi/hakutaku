import { expect, it } from "vitest";
import {
  formatSummary,
  pythonWhy,
  type SummaryInput,
  summaryCounts,
} from "../../../src/cli/summary.js";
import type { BuildFacts } from "../../../src/store/index.js";
import { HOSTILE, HOSTILE_SHOWN, rawLines } from "../../helpers/terminal.js";
import { openTiny, tinyContent } from "../../helpers/tiny.js";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const COMMIT = "4f2a9c1e07b3d5a8c6e2f1b0a9d8c7e6f5a4b3c2";

const facts = (patch: Partial<BuildFacts> = {}): BuildFacts => ({
  commit: COMMIT,
  ref: "main",
  contentHash: "a".repeat(64),
  startedAt: "2026-09-01T12:00:00.000Z",
  finishedAt: "2026-09-01T12:00:19.400Z",
  wallMs: 19_400,
  peakRssBytes: Math.round(0.6 * GIB),
  sandbox: "bubblewrap",
  engines: {},
  warnings: [],
  ...patch,
});

const fixedInput: SummaryInput = {
  version: "0.0.0",
  id: "observatory",
  commit: COMMIT,
  ref: "main",
  detail: "standard",
  counts: {
    tracked: 164,
    code: { typescript: 74, python: 41, shell: 9, javascript: 7 },
    production: 97,
    test: 34,
    edges: 388,
    unresolvedRelative: 0,
    cycles: 1,
    callSites: { bound: 902, scoped: 263, unresolved: 39 },
    entryPoints: 9,
    launchManifests: 5,
    core: 14,
  },
  build: facts(),
  storeBytes: Math.round(4.1 * MIB),
  result: "built",
  pythonResolver: "grimp",
  commands: [],
};

it("formats the summary lines", () =>
  expect(formatSummary(fixedInput)).toEqual([
    "hakutaku 0.0.0 \u00b7 observatory at 4f2a9c1e07b3 (main), standard detail",
    "  files      164 tracked \u00b7 131 code (TypeScript 74, Python 41, shell 9, JavaScript 7) \u00b7 97 production, 34 test",
    "  imports    388 edges \u00b7 0 unresolved relative \u00b7 1 cycle",
    "  callers    1,204 call sites \u00b7 902 bound \u00b7 263 scoped \u00b7 39 unresolved",
    "  entry      9 entry points from 5 launch manifests",
    "  core       14 of 97 production files (14%) carry at least half of what the code depends on",
    "  built      19 s \u00b7 peak 0.6 GB \u00b7 store 4.1 MB \u00b7 sandbox: bubblewrap",
  ])); // no "next" lines: neither view nor mcp is registered in this input

// A ref as map was asked for it: git takes a ref name that holds a C1 control, a line separator
// or a bidirectional control.
it("shows the ref on a line safe for a terminal", () => {
  const lines = formatSummary({ ...fixedInput, ref: HOSTILE });
  expect(lines[0]).toBe(
    formatSummary(fixedInput)[0]?.replace("(main)", `(${HOSTILE_SHOWN})`),
  );
  expect(rawLines(lines.join("\n"))).toEqual([]);
});

it("says when a build was skipped and when Python fell back", () => {
  const why =
    "grimp is not installed: no suitable Python was found when the engines were installed";
  const skipped = formatSummary({
    ...fixedInput,
    build: null,
    result: "skipped",
    pythonResolver: "hakutaku-resolver",
    pythonWhy: why,
  });
  expect(skipped.slice(6)).toEqual([
    "  built      skipped: the store at 4f2a9c1e07b3 is current",
    `  python     imports from hakutaku's resolver: ${why}`,
  ]);
  // the lines above the built line are the store's, whatever the build did
  expect(skipped.slice(0, 6)).toEqual(formatSummary(fixedInput).slice(0, 6));
  // an unsandboxed build has no peak to show, and says which sandbox it had
  expect(
    formatSummary({
      ...fixedInput,
      build: facts({ peakRssBytes: null, sandbox: "none", wallMs: 2_600 }),
    })[6],
  ).toBe(
    "  built      3 s \u00b7 peak ? \u00b7 store 4.1 MB \u00b7 sandbox: none",
  );
  // no python line where grimp read the imports, or there was no Python to read
  for (const pythonResolver of ["grimp", "none"] as const) {
    expect(
      formatSummary({ ...fixedInput, pythonResolver, pythonWhy: why }),
    ).toHaveLength(7);
  }
});

it("names next only the commands that are registered, in one column", () => {
  const next = (commands: string[]): string[] =>
    formatSummary({ ...fixedInput, commands }).slice(7);
  expect(next(["map", "list", "doctor"])).toEqual([]);
  expect(next(["map", "mcp", "query"])).toEqual([
    "next  hakutaku mcp observatory    the tools, for an agent",
  ]);
  expect(next(["mcp", "view"])).toEqual([
    "next  hakutaku view observatory    the map, in your browser",
    "      hakutaku mcp observatory     the tools, for an agent",
  ]);
  // they come after the python line
  const lines = formatSummary({
    ...fixedInput,
    pythonResolver: "hakutaku-resolver",
    pythonWhy: "grimp failed: exit code 1",
    commands: ["mcp"],
  });
  expect(lines.slice(7)).toEqual([
    "  python     imports from hakutaku's resolver: grimp failed: exit code 1",
    "next  hakutaku mcp observatory    the tools, for an agent",
  ]);
});

it("formats a repo with no code, and counts of one, without a broken line", () => {
  const empty = formatSummary({
    ...fixedInput,
    counts: {
      tracked: 1,
      code: {},
      production: 0,
      test: 0,
      edges: 1,
      unresolvedRelative: 0,
      cycles: 0,
      callSites: { bound: 1, scoped: 0, unresolved: 0 },
      entryPoints: 1,
      launchManifests: 1,
      core: 0,
    },
    build: facts({ wallMs: 400, peakRssBytes: 1_234 * GIB }),
    storeBytes: 0,
  });
  expect(empty.slice(1)).toEqual([
    "  files      1 tracked \u00b7 0 code \u00b7 0 production, 0 test",
    "  imports    1 edge \u00b7 0 unresolved relative \u00b7 0 cycles",
    "  callers    1 call site \u00b7 1 bound \u00b7 0 scoped \u00b7 0 unresolved",
    "  entry      1 entry point from 1 launch manifest",
    "  core       no production files",
    "  built      0 s \u00b7 peak 1,234.0 GB \u00b7 store 0.0 MB \u00b7 sandbox: bubblewrap",
  ]);
  // languages with the same count are listed by name
  expect(
    formatSummary({
      ...fixedInput,
      counts: { ...fixedInput.counts, code: { rust: 2, go: 2, python: 5 } },
    })[1],
  ).toContain("9 code (Python 5, go 2, rust 2)");
});

it("says why hakutaku's resolver read the Python imports, from grimp's tier", () => {
  expect(pythonWhy("fallback", null)).toBe(
    "grimp is not installed: no suitable Python was found when the engines were installed",
  );
  const failed = facts({
    warnings: [
      "dependency-cruiser failed: exit code 2",
      "grimp failed: timed out after 600 s\nTraceback (most recent call last):",
    ],
  });
  expect(pythonWhy("failed", failed)).toBe(
    "grimp failed: timed out after 600 s",
  );
  // an engine's error can quote a repository's line: no control character reaches the terminal
  const quoting = facts({
    warnings: ["grimp failed: exit code 1: x\x1b]0;title\x07\x1b[2Jy\ttab"],
  });
  expect(pythonWhy("failed", quoting)).toBe(
    "grimp failed: exit code 1: x?]0;title??[2Jy?tab",
  );
  expect(pythonWhy("failed", null)).toBe("grimp failed");
  expect(pythonWhy("failed", facts())).toBe("grimp failed");
  expect(pythonWhy("skipped", null)).toBe(
    "grimp found no Python package to read",
  );
  expect(pythonWhy(undefined, null)).toBe("grimp did not run");
});

it("counts the store's parts for the summary", () => {
  const content = tinyContent();
  const coverage = content.meta[0]?.coverage;
  if (coverage === undefined) throw new Error("the tiny store has no meta");
  const codeFiles = content.files.filter((f) =>
    ["code", "test", "test-support"].includes(f.kind),
  );
  const code: Record<string, number> = {};
  for (const f of codeFiles) {
    if (f.lang !== null) code[f.lang] = (code[f.lang] ?? 0) + 1;
  }
  const entries = content.entry_points.filter((e) => e.kind !== "dev-script");
  const store = openTiny();
  try {
    expect(summaryCounts(store)).toEqual({
      tracked: content.files.length + coverage.denied,
      code,
      production: content.files.filter((f) => f.kind === "code").length,
      test: codeFiles.filter((f) => f.kind !== "code").length,
      edges: new Set(
        content.imports
          .filter((i) => i.dst_file_id !== null)
          .map((i) => `${i.src_file_id}>${i.dst_file_id}`),
      ).size,
      unresolvedRelative: coverage.unresolvedImports,
      cycles: new Set(content.cycles.map((c) => c.cycle_id)).size,
      callSites: coverage.callSites,
      entryPoints: entries.length,
      launchManifests: new Set(entries.map((e) => e.manifest_file_id)).size,
      core: content.file_metrics.filter((m) => m.core === 1).length,
    });
  } finally {
    store.close();
  }
});
