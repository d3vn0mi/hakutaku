// The viewer is built over the agents' query functions, and never the other way round: no tool,
// MCP or query module outside src/query/view/ imports the viewer's data or the viewer.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// Every .ts file under dir, as a path relative to the repo root.
const listTs = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `${dir}/${f}`)
    .sort();

it("no agent-facing module imports the viewer", () => {
  const agentFacing = listTs("src").filter(
    (f) =>
      /^src\/(tools|mcp|query)\//.test(f) && !f.startsWith("src/query/view/"),
  );
  expect(agentFacing.length).toBeGreaterThan(0); // the scan reads real files
  const offenders = agentFacing.filter((f) =>
    /from\s+["'][^"']*(\/view\/|\/viewer\/)/.test(
      readFileSync(join(ROOT, f), "utf8"),
    ),
  );
  expect(offenders).toEqual([]); // the viewer calls the agents' query functions, never the reverse
});
