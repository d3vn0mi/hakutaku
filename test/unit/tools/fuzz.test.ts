// In process: repos, targets and globs from outside the store never reach anything but the
// store.
import { expect, it } from "vitest";
import {
  runTool,
  type SearchTextAnswer,
  type ToolError,
  type ToolResult,
} from "../../../src/tools/index.js";
import { fixedHost } from "../../helpers/fixed-host.js";
import { tinyStore } from "../../helpers/tiny.js";

const OUT = "/tmp/hakutaku-fuzz-canary/secret.txt";
const REPOS = [
  "../tiny",
  "/etc/passwd",
  OUT,
  `file://${OUT}`,
  "tiny/../x",
  "*",
  "tiny:",
  "https://example.com/x",
  "TINY",
  " tiny",
];
const TARGETS = [
  OUT,
  "../../etc/passwd",
  `file://${OUT}`,
  "~/.ssh/id_rsa",
  "lib/**",
  "lib/*.ts",
  "%2e%2e/%2e%2e/etc/passwd",
  "tiny:../../etc/passwd",
  `tiny:${OUT}`,
  "C:\\Windows\\win.ini",
  "\u0000",
  "lib/orbit.ts\u0000.png",
];

const host = fixedHost({ tiny: tinyStore() });

const error = (r: ToolResult): ToolError => {
  if (r.ok) throw new Error(`an answer: ${JSON.stringify(r.answer)}`);
  return r.error;
};
const answer = (r: ToolResult): SearchTextAnswer => {
  if (!r.ok) throw new Error(`an error: ${JSON.stringify(r.error)}`);
  return r.answer as SearchTextAnswer;
};

it("a repo is only ever an exact registered id", () => {
  for (const repo of REPOS)
    expect(runTool(host, null, "code_overview", { repo })).toMatchObject({
      ok: false,
      error: { code: "unknown_repo", known: ["tiny"] },
    });
});

it("a target from outside the store never resolves", () => {
  for (const target of TARGETS)
    expect(["not_found", "invalid_argument", "denied_file"]).toContain(
      error(runTool(host, null, "code_explain", { repo: "tiny", target })).code,
    );
});

it("path_glob only filters stored paths", () => {
  for (const g of [
    "/etc/*",
    "../**",
    OUT,
    "**/*",
    "*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b",
  ]) {
    const r = answer(
      runTool(host, null, "code_search_text", {
        repo: "tiny",
        text: "import",
        path_glob: g,
      }),
    );
    for (const h of r.hits) expect(h.file.startsWith("tiny:")).toBe(true);
  }
});
