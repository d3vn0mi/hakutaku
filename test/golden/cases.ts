// The golden cases: one call each on the observatory sample, at standard detail unless the case
// says otherwise, with the premise its result must meet before its golden file is written or
// compared. Every call but code_repos, which takes no arguments, asks about the repo
// "observatory" unless its args name another. A case's args may be a function of the case's
// store and of earlier cases' answers; golden.test.ts writes them resolved, in the order of this
// list.
import { expect } from "vitest";
import {
  type Detail,
  type Ecosystem,
  formatId,
} from "../../src/model/index.js";
import type { Store } from "../../src/store/index.js";
import {
  type CallersAnswer,
  type DepsAnswer,
  type ExplainDefinitionAnswer,
  type FindAnswer,
  type LibraryReferencesAnswer,
  measure,
  type OverviewRepoAnswer,
  type PathAnswer,
  type ReposAnswer,
  type RulesAnswer,
  type SearchTextAnswer,
  type SnippetAnswer,
  type ToolError,
  type ToolName,
  type ToolResult,
} from "../../src/tools/index.js";

// What a case's args and premise can read besides the result.
export interface CaseContext {
  store: Store; // the case's store, at the case's detail
  // the answer of an earlier case, by "<tool>/<name>"
  answer<A extends object = Record<string, unknown>>(key: string): A;
  // a call written as a case's args are, on the case's store at the default maxResultChars
  run(tool: ToolName, args: Record<string, unknown>): ToolResult;
}

export interface GoldenCase {
  tool: ToolName;
  name: string;
  detail: Detail;
  maxResultChars?: number;
  args: Record<string, unknown> | ((c: CaseContext) => Record<string, unknown>);
  premise?: (result: ToolResult, c: CaseContext) => void; // runs on every check
}

const REPO = "observatory";
const KEPLER = "web/src/orbits/kepler.ts";
const KEPLER_TEST = "web/src/orbits/kepler.test.ts";
const CONSTANTS = "web/src/orbits/constants.ts";
// A Python test module outside the importable packages: sim/tests holds no __init__.py.
const MOON_TEST = "sim/tests/test_moon.py";
const METHOD = `${KEPLER}#Orbit.position`;
const SOLVE = `${KEPLER}#solveKepler`;
const SNIPPET = { file: KEPLER, from: 1, to: 120 };

// The cap for the split caller: the first page holds the production caller drawSky, whose one
// site cannot split, so the case starts at offset 1, with the test module's caller of two sites.
// 1,200 is the smallest multiple of 100 at which that caller goes out in two parts and its page
// fits within the cap; below it the part still shows, on a page over the cap.
const SPLIT_CAP = 1200;
// The smallest multiple of 100 at which kepler.ts's lines go out in exactly three windows.
const WINDOW_CAP = 1200;
// A search for "import" at this cap goes out over several pages.
const SEARCH_CAP = 4000;

// The mark a redaction leaves in a stored line, from code points so that this file stays ASCII.
const REDACTED = `${String.fromCodePoint(0xab)}redacted:`;

const fileId = (path: string): string =>
  formatId({ kind: "file", repo: REPO, path });

// The answer of a result that must answer, as the tool's answer type.
function answerOf<A extends object>(r: ToolResult): A {
  if (!r.ok) {
    throw new Error(
      `expected an answer, not ${r.error.code}: ${r.error.message}`,
    );
  }
  return r.answer as A;
}

function errorOf(r: ToolResult): ToolError {
  if (r.ok) throw new Error("expected an error, not an answer");
  return r.error;
}

// An earlier case's nextOffset, which its premise has seen to be there.
function nextOffsetOf(c: CaseContext, key: string): number {
  const next = c.answer(key).nextOffset;
  if (typeof next !== "number") throw new Error(`${key} has no nextOffset`);
  return next;
}

type Row = Record<string, unknown>;

// The first production Python definition, in definition order, that no other production file
// uses: the sample's own console script, cli.py#main, is used by __main__.py.
function unusedPythonDefinition({
  store,
}: CaseContext): Record<string, unknown> {
  const row = store.db
    .prepare(
      "SELECT f.path, d.qualname, d.ordinal FROM definitions AS d JOIN files AS f ON f.id = d.file_id LEFT JOIN def_metrics AS m ON m.def_id = d.id WHERE f.kind = 'code' AND f.lang = 'python' AND d.kind <> 'module' AND COALESCE(m.used_by_files, 0) = 0 ORDER BY d.id LIMIT 1",
    )
    .get() as Row | undefined;
  if (row === undefined) throw new Error("no unused Python definition");
  return {
    target: formatId({
      kind: "definition",
      repo: REPO,
      path: row.path as string,
      qualname: row.qualname as string,
      ordinal: row.ordinal as number,
    }),
  };
}

// How many files of these languages hold an import that hakutaku's own resolver read.
function resolverFiles(
  { store }: CaseContext,
  langs: readonly string[],
): number {
  const row = store.db
    .prepare(
      `SELECT COUNT(DISTINCT i.src_file_id) AS n FROM imports AS i JOIN files AS f ON f.id = i.src_file_id WHERE i.producer = 'hakutaku-resolver' AND f.lang IN (${langs.map(() => "?").join(", ")})`,
    )
    .get(...langs) as Row | undefined;
  return Number(row?.n ?? 0);
}

// The producers of a file's imports, each once, in name order.
function importProducers({ store }: CaseContext, path: string): string[] {
  const rows = store.db
    .prepare(
      "SELECT DISTINCT i.producer FROM imports AS i JOIN files AS f ON f.id = i.src_file_id WHERE f.path = ? ORDER BY i.producer",
    )
    .all(path) as Row[];
  return rows.map((r) => r.producer as string);
}

// The library the most files import, ties by ecosystem, then name.
function mostImportedLibrary({ store }: CaseContext): Record<string, unknown> {
  const row = store.db
    .prepare(
      "SELECT ecosystem, name FROM externals ORDER BY files DESC, ecosystem, name LIMIT 1",
    )
    .get() as Row | undefined;
  if (row === undefined) throw new Error("the store holds no library");
  return {
    symbol: formatId({
      kind: "external",
      repo: REPO,
      ecosystem: row.ecosystem as Ecosystem,
      name: row.name as string,
    }),
  };
}

const golden = (
  tool: ToolName,
  name: string,
  args: GoldenCase["args"],
  more: Partial<Pick<GoldenCase, "detail" | "maxResultChars" | "premise">> = {},
): GoldenCase => ({ tool, name, detail: "standard", args, ...more });

export const CASES: readonly GoldenCase[] = Object.freeze([
  golden(
    "code_repos",
    "all",
    {},
    {
      // languages counts the code, test and test-support files, as code_overview's repo answer
      // does; coverage.indexed counts those an import engine read, and grimp reads no Python
      // file outside the packages, so the sample's Python tests are in the one and not the other
      premise: (r, c) => {
        const repo = answerOf<ReposAnswer>(r).repos[0];
        const overview = answerOf<OverviewRepoAnswer>(
          c.run("code_overview", {}),
        );
        expect(JSON.stringify(repo?.languages)).toBe(
          JSON.stringify(overview.languages),
        );
        expect(repo?.coverage.indexed.python).toBe(24);
        expect(repo?.languages.python).toBeGreaterThan(24);
      },
    },
  ),

  golden("code_overview", "repo", {}),
  golden("code_overview", "component", { component: "web/src/orbits" }),
  golden(
    "code_overview",
    "unknown-repo",
    { repo: "nope" },
    {
      premise: (r) =>
        expect(errorOf(r)).toMatchObject({
          code: "unknown_repo",
          known: [REPO],
        }),
    },
  ),

  golden(
    "code_find",
    "position",
    { name: "position" },
    {
      premise: (r) =>
        expect(
          answerOf<FindAnswer>(r).matches.filter((m) => m.match === "exact"),
        ).toHaveLength(2),
    },
  ),
  golden("code_find", "prefix", { name: "kep" }),

  golden("code_explain", "file", { target: KEPLER }),
  golden("code_explain", "definition", { target: SOLVE }),
  golden("code_explain", "quick-no-compiler", unusedPythonDefinition, {
    detail: "quick",
    premise: (r) => {
      const a = answerOf<ExplainDefinitionAnswer>(r);
      expect(a).toMatchObject({ usedByFiles: 0, label: "scoped" });
      expect(a.note).toContain("(quick detail)");
    },
  }),
  golden(
    "code_explain",
    "below-deep",
    (c) => ({
      target: c.answer<ExplainDefinitionAnswer>(
        "code_explain/quick-no-compiler",
      ).id,
    }),
    {
      premise: (r) =>
        expect(answerOf<ExplainDefinitionAnswer>(r).note).toContain(
          "(below deep detail)",
        ),
    },
  ),
  golden(
    "code_explain",
    "renamed",
    { target: "web/src/orbits/orbit.ts" },
    {
      premise: (r) => {
        const e = errorOf(r);
        expect(e.code).toBe("not_found");
        expect(e.candidates?.map((c) => c.id)).toContain(fileId(KEPLER));
      },
    },
  ),
  golden(
    "code_explain",
    "component",
    { target: `${REPO}:web/src/orbits/` },
    { premise: (r) => expect(errorOf(r).code).toBe("invalid_argument") },
  ),

  golden(
    "code_callers",
    "method",
    { symbol: METHOD },
    {
      premise: (r) => {
        const a = answerOf<CallersAnswer>(r);
        const sitesIn = (path: string) =>
          a.callers
            .filter((caller) => caller.file === fileId(path))
            .flatMap((caller) => caller.sites);
        expect(
          sitesIn("web/src/sky/render.ts").some((s) => s.label === "scoped"),
        ).toBe(true);
        expect(sitesIn(KEPLER_TEST).some((s) => s.collision === true)).toBe(
          true,
        );
      },
    },
  ),
  golden(
    "code_callers",
    "ambiguous",
    { symbol: "position" },
    {
      premise: (r) => {
        const e = errorOf(r);
        expect(e.code).toBe("ambiguous");
        expect(e.candidates).toHaveLength(2);
      },
    },
  ),
  golden("code_callers", "transitive", { symbol: METHOD, scope: "transitive" }),
  golden("code_callers", "unscoped", { symbol: METHOD, labels: ["unscoped"] }),
  golden(
    "code_callers",
    "depth-2",
    { symbol: SOLVE, depth: 2 },
    {
      premise: (r) =>
        expect(
          answerOf<CallersAnswer>(r).callers.some((c) => c.hop === 2),
        ).toBe(true),
    },
  ),
  golden(
    "code_callers",
    "split-part",
    { symbol: METHOD, offset: 1 },
    {
      maxResultChars: SPLIT_CAP,
      premise: (r) => {
        const a = answerOf<CallersAnswer>(r);
        expect(a.callers.some((c) => c.part === "1/2")).toBe(true);
        expect(measure(a)).toBeLessThanOrEqual(SPLIT_CAP);
      },
    },
  ),

  golden("code_references", "definition", { symbol: `${KEPLER}#Orbit` }),
  golden("code_references", "library", mostImportedLibrary, {
    premise: (r) =>
      expect(answerOf<LibraryReferencesAnswer>(r).kind).toBe("library"),
  }),

  golden("code_impact", "file", { target: KEPLER }),
  golden("code_impact", "definition", { target: SOLVE, depth: 3 }),
  golden(
    "code_impact",
    "paged",
    { target: "web/src/orbits/units.ts", limit: 3 },
    { premise: (r) => expect(answerOf(r)).toMatchObject({ hasMore: true }) },
  ),

  golden(
    "code_deps",
    "out",
    { file: KEPLER, direction: "out" },
    {
      // dependency-cruiser ran, and no TypeScript or JavaScript file of the sample holds an import
      // from hakutaku's own resolver, so no line counts them
      premise: (r, c) => {
        expect(c.store.meta.coverage.tiers["dependency-cruiser"]).toBe("ran");
        expect(resolverFiles(c, ["typescript", "javascript"])).toBe(0);
        expect(
          answerOf<DepsAnswer>(r).blindSpots.filter((line) =>
            line.endsWith(", not dependency-cruiser"),
          ),
        ).toEqual([]);
      },
    },
  ),
  golden("code_deps", "in-transitive", {
    file: CONSTANTS,
    direction: "in",
    transitive: true,
  }),
  golden(
    "code_deps",
    "python-out",
    { file: MOON_TEST, direction: "out" },
    {
      // grimp ran, but reads only the packages under the profile's Python roots, so every import
      // of this test module is hakutaku's own resolver's, and the answer counts the Python files
      // that hold one
      premise: (r, c) => {
        expect(c.store.meta.coverage.pythonResolver).toBe("grimp");
        expect(importProducers(c, MOON_TEST)).toEqual(["hakutaku-resolver"]);
        const n = resolverFiles(c, ["python"]);
        expect(n).toBeGreaterThan(1);
        expect(answerOf<DepsAnswer>(r).blindSpots).toContain(
          `${n} Python files have imports that come from hakutaku's own resolver, not grimp`,
        );
      },
    },
  ),

  golden(
    "code_path",
    "imports",
    { from: KEPLER_TEST, to: CONSTANTS },
    { premise: (r) => expect(answerOf<PathAnswer>(r).found).toBe(true) },
  ),
  golden(
    "code_path",
    "no-path",
    { from: CONSTANTS, to: KEPLER_TEST },
    { premise: (r) => expect(answerOf<PathAnswer>(r).found).toBe(false) },
  ),
  golden(
    "code_path",
    "unknown-endpoint",
    { from: KEPLER, to: "web/src/orbits/nope.ts" },
    {
      premise: (r) =>
        expect(errorOf(r)).toMatchObject({ code: "not_found", field: "to" }),
    },
  ),
  golden(
    "code_path",
    "calls",
    { from: "web/src/sky/render.ts#drawSky", to: METHOD, via: "calls" },
    { premise: (r) => expect(answerOf<PathAnswer>(r).found).toBe(true) },
  ),

  golden(
    "code_rules",
    "all",
    {},
    {
      premise: (r) => {
        const kinds = answerOf<RulesAnswer>(r).findings.map((f) => f.kind);
        expect(kinds).toContain("cycle");
        expect(kinds).toContain("violation");
      },
    },
  ),

  golden(
    "code_search_text",
    "fits-whole",
    { text: "position(" },
    {
      premise: (r) => expect(Object.keys(answerOf(r))).not.toContain("offset"),
    },
  ),
  golden(
    "code_search_text",
    "oversized-page-1",
    { text: "import", limit: 200 },
    {
      maxResultChars: SEARCH_CAP,
      premise: (r) => expect(answerOf(r)).toMatchObject({ hasMore: true }),
    },
  ),
  golden(
    "code_search_text",
    "oversized-page-2",
    (c) => ({
      text: "import",
      limit: 200,
      offset: nextOffsetOf(c, "code_search_text/oversized-page-1"),
    }),
    {
      maxResultChars: SEARCH_CAP,
      // the first hit is the one after page 1's last, in the order of the whole list
      premise: (r, c) => {
        const page1 = c.answer<SearchTextAnswer>(
          "code_search_text/oversized-page-1",
        );
        const next = nextOffsetOf(c, "code_search_text/oversized-page-1");
        const page2 = answerOf<SearchTextAnswer>(r);
        expect(page2).toMatchObject({ offset: next });
        const whole = answerOf<SearchTextAnswer>(
          c.run("code_search_text", { text: "import", limit: 200 }),
        );
        expect(whole.hits.length).toBeGreaterThan(next);
        expect(page1.hits.at(-1)).toEqual(whole.hits[next - 1]);
        expect(page2.hits[0]).toEqual(whole.hits[next]);
      },
    },
  ),
  golden(
    "code_search_text",
    "glob",
    { text: "import", path_glob: "sim/**" },
    {
      premise: (r) => {
        const hits = answerOf<SearchTextAnswer>(r).hits;
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.filter((h) => !h.file.startsWith(`${REPO}:sim/`))).toEqual(
          [],
        );
      },
    },
  ),
  golden(
    "code_search_text",
    "too-short",
    { text: "ab" },
    { premise: (r) => expect(errorOf(r).code).toBe("invalid_argument") },
  ),

  golden(
    "code_snippet",
    "definition",
    { target: SOLVE },
    {
      premise: (r) => expect(answerOf<SnippetAnswer>(r).untrusted).toBe(true),
    },
  ),
  golden("code_snippet", "window-1", SNIPPET, {
    maxResultChars: WINDOW_CAP,
    premise: (r) => expect(answerOf(r)).toMatchObject({ hasMore: true }),
  }),
  golden(
    "code_snippet",
    "window-2",
    (c) => ({ ...SNIPPET, offset: nextOffsetOf(c, "code_snippet/window-1") }),
    {
      maxResultChars: WINDOW_CAP,
      premise: (r) => expect(answerOf(r)).toMatchObject({ hasMore: true }),
    },
  ),
  golden(
    "code_snippet",
    "window-3",
    (c) => ({ ...SNIPPET, offset: nextOffsetOf(c, "code_snippet/window-2") }),
    {
      maxResultChars: WINDOW_CAP,
      // the three windows, each joined by newlines and then end to end, are the text of the
      // snippet that fits whole at the default cap
      premise: (r, c) => {
        const last = answerOf<SnippetAnswer>(r);
        expect(last).toMatchObject({ hasMore: false });
        const windows = [
          c.answer<SnippetAnswer>("code_snippet/window-1"),
          c.answer<SnippetAnswer>("code_snippet/window-2"),
          last,
        ];
        const whole = answerOf<SnippetAnswer>(c.run("code_snippet", SNIPPET));
        expect(Object.keys(whole)).not.toContain("offset");
        expect(windows.map((w) => w.lines.join("\n")).join("")).toBe(
          whole.lines.join("\n"),
        );
      },
    },
  ),
  golden(
    "code_snippet",
    "redacted",
    { file: "web/src/api/ephemeris-client.ts" },
    {
      premise: (r) => {
        const a = answerOf<SnippetAnswer>(r);
        expect(a.redactions).toBeGreaterThanOrEqual(1);
        expect(a.lines.some((line) => line.includes(REDACTED))).toBe(true);
      },
    },
  ),
  golden(
    "code_snippet",
    "denied",
    { file: "sim/.env" },
    { premise: (r) => expect(errorOf(r).code).toBe("denied_file") },
  ),

  golden(
    "code_refresh",
    "disabled",
    {},
    { premise: (r) => expect(errorOf(r).code).toBe("refresh_disabled") },
  ),
]);
