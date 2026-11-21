import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path/posix";
import { expect, expectTypeOf, it } from "vitest";
import type {
  CallContext,
  CallersAnswer,
  CallersArgs,
  Candidate,
  DepsAnswer,
  DepsArgs,
  ErrorCode,
  ExplainArgs,
  ExplainDefinitionAnswer,
  ExplainFileAnswer,
  ExplainMetrics,
  FindAnswer,
  FindArgs,
  Fresh,
  Freshness,
  Host,
  HostError,
  ImpactAnswer,
  ImpactArgs,
  LastAttempt,
  LibraryReferencesAnswer,
  OverviewArgs,
  OverviewComponentAnswer,
  OverviewRepoAnswer,
  Paged,
  PageFields,
  PathAnswer,
  PathArgs,
  ReferencesAnswer,
  ReferencesArgs,
  RefreshAnswer,
  RefreshArgs,
  RefreshState,
  RepoEntry,
  ReposAnswer,
  ReposArgs,
  RulesAnswer,
  RulesArgs,
  SearchTextAnswer,
  SearchTextArgs,
  SnippetAnswer,
  SnippetArgs,
  ToolAnswer,
  ToolArgs,
  ToolError,
  ToolIO,
  ToolName,
  ToolResult,
  ToolSpec,
} from "../../../src/index.js";
import { MCP_INSTRUCTIONS } from "../../../src/mcp/instructions.js";
import { runTool, TOOL_NAMES, TOOL_SPECS } from "../../../src/tools/index.js";

// The specifiers of a module's static imports and re-exports (import or export ... from, and a
// bare import "x") and of its dynamic import("x") calls, type-only ones included. Comments are
// dropped first, so a specifier quoted in a comment is not followed.
const SPECIFIERS = [
  /\b(?:import|export)\b[^;"'`]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s*["']([^"']+)["']/g,
];

function specifiersOf(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return SPECIFIERS.flatMap((re) =>
    [...code.matchAll(re)].map((m) => m[1] ?? ""),
  );
}

// Every file and package that entry reaches. A relative specifier is followed to its .ts source
// (one that names no file is recorded and not followed); a package's is recorded as it is.
function importClosure(entry: string): string[] {
  const reached = new Set<string>([entry]);
  const todo = [entry];
  for (let file = todo.pop(); file !== undefined; file = todo.pop()) {
    for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
      const relative = spec.startsWith(".");
      const next = relative
        ? normalize(join(dirname(file), spec)).replace(/\.js$/, ".ts")
        : spec;
      if (reached.has(next)) continue;
      reached.add(next);
      if (relative && existsSync(next)) todo.push(next);
    }
  }
  return [...reached];
}

const BUILD_CODE =
  /^src\/(export|extract|engines|profile|manifests|cli)\/|^src\/mcp\/server\.ts$/;

const SDK = "node_modules/@modelcontextprotocol/sdk";
const sdkVersion = (): string =>
  JSON.parse(readFileSync(`${SDK}/package.json`, "utf8")).version;

it("exports the tool contract and the server instructions from '.'", async () => {
  const m = await import("../../../src/index.js");
  expect(m.TOOL_SPECS).toBe(TOOL_SPECS);
  expect(m.TOOL_NAMES).toBe(TOOL_NAMES);
  expect(m.runTool).toBe(runTool);
  expect(m.MCP_INSTRUCTIONS).toBe(MCP_INSTRUCTIONS);
});

it("exports the Host types, the tool types and every argument and answer type from '.'", () => {
  // This compiles only while '.' exports every type the import above names.
  expectTypeOf<
    [
      Host,
      CallContext,
      RepoEntry,
      HostError,
      Freshness,
      RefreshState,
      LastAttempt,
      ToolSpec,
      ToolName,
      ToolIO,
      ToolArgs<"code_find">,
      ToolAnswer<"code_find">,
      ToolResult,
      ToolError,
      ErrorCode,
      Candidate,
      Fresh,
      PageFields,
      Paged,
      ExplainMetrics,
      ReposArgs,
      OverviewArgs,
      FindArgs,
      ExplainArgs,
      CallersArgs,
      ReferencesArgs,
      ImpactArgs,
      DepsArgs,
      PathArgs,
      RulesArgs,
      SearchTextArgs,
      SnippetArgs,
      RefreshArgs,
      ReposAnswer,
      OverviewRepoAnswer,
      OverviewComponentAnswer,
      FindAnswer,
      ExplainFileAnswer,
      ExplainDefinitionAnswer,
      CallersAnswer,
      ReferencesAnswer,
      LibraryReferencesAnswer,
      ImpactAnswer,
      DepsAnswer,
      PathAnswer,
      RulesAnswer,
      SearchTextAnswer,
      SnippetAnswer,
      RefreshAnswer,
    ]
  >().not.toBeNever();
});

it("'.' never reaches build code or the MCP SDK", () => {
  const reached = importClosure("src/index.ts");
  expect(reached).toContain("src/tools/run.ts");
  expect(reached).toContain("src/mcp/instructions.ts");
  expect(reached.filter((f) => BUILD_CODE.test(f))).toEqual([]);
  expect(reached.filter((f) => f.includes("@modelcontextprotocol"))).toEqual(
    [],
  );
});

it("reaches the MCP SDK through the server, which the mcp barrel exports", () => {
  expect(importClosure("src/mcp/server.ts")).toContain(
    "@modelcontextprotocol/sdk/server/index.js",
  );
  expect(importClosure("src/mcp/index.ts")).toContain("src/mcp/server.ts");
});

it("depends at run time on the MCP SDK alone, at the exact version installed", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  expect(sdkVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  expect(pkg.dependencies).toEqual({
    "@modelcontextprotocol/sdk": sdkVersion(),
  });
});

it("NOTICE credits the MCP SDK with its copyright line", () => {
  const line = readFileSync(`${SDK}/LICENSE`, "utf8")
    .split("\n")
    .find((l) => l.startsWith("Copyright"));
  expect(line).toBeDefined();
  const notice = readFileSync("NOTICE", "utf8");
  const installed = notice
    .split("\n## ")
    .find((part) => part.startsWith("Installed with the package\n"));
  expect(installed).toContain(
    [
      "### @modelcontextprotocol/sdk",
      `Version: ${sdkVersion()}`,
      "Licence: MIT",
      `Copyright: ${line}`,
      "Use: the MCP server over stdio",
    ].join("\n"),
  );
});
