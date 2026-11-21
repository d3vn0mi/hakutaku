// Every tool's answer on the observatory sample, pinned. Each case of cases.ts runs, in order,
// through runTool over a fixed host on the sample's store at the case's detail and cap, and its
// premise is checked. Its call, with its args written resolved, and its result, as JSON with
// two-space indents and a final newline, must then equal test/golden/<tool>/<name>.json byte for
// byte. With HAKUTAKU_GOLDEN_UPDATE=1 (npm run golden:update) each file is written instead, and a
// person reads every diff before it is committed. A code_repos answer's builtAt, the time its
// store was built, is written as "<builtAt>".
//
// Run `node dist/cli/main.js engines install --yes` once first. The stores are built with the
// Python the engines were installed with, since grimp must run: where that Python does not start,
// the cases are skipped, and in CI they fail.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Detail } from "../../src/model/index.js";
import {
  type Host,
  type ReposAnswer,
  runTool,
  TOOL_NAMES,
  type ToolError,
  type ToolName,
  type ToolResult,
} from "../../src/tools/index.js";
import { fixedHost } from "../helpers/fixed-host.js";
import { requireInCI } from "../helpers/live.js";
import { samplePythonProbe, sampleStore } from "../helpers/sample.js";
import { CASES, type CaseContext, type GoldenCase } from "./cases.js";

const REPO = "observatory";
const UPDATE = process.env.HAKUTAKU_GOLDEN_UPDATE === "1";
const DIR = fileURLToPath(new URL(".", import.meta.url));
const PYTHON = samplePythonProbe();
const BUILD_TIMEOUT = 600_000;
const BUILT_AT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;

const storePaths = new Map<Detail, string>();
const hosts = new Map<string, Host>();
const answers = new Map<string, object>();

// The sample's store at each detail a case uses. Without the engines' Python no store is built,
// and each case skips, or fails in CI, through requireInCI.
beforeAll(async () => {
  if (!PYTHON.ok) return;
  for (const detail of new Set(CASES.map((c) => c.detail))) {
    storePaths.set(detail, await sampleStore(detail));
  }
}, BUILD_TIMEOUT);

afterAll(() => {
  for (const host of hosts.values()) {
    const store = host.open(undefined, REPO);
    if (!("code" in store)) store.close();
  }
});

// The host over the sample's store at this detail and cap, made once for each pair; undefined
// is the default cap.
function hostOf(detail: Detail, maxResultChars?: number): Host {
  const key = `${detail} ${maxResultChars ?? "default"}`;
  let host = hosts.get(key);
  if (host === undefined) {
    const path = storePaths.get(detail);
    if (path === undefined) throw new Error(`no ${detail} store was built`);
    host = fixedHost({ [REPO]: path }, { maxResultChars });
    hosts.set(key, host);
  }
  return host;
}

// A call's args as a case writes them, with the repo they imply: every tool but code_repos,
// which takes no arguments, asks about the sample unless the args name another repo.
function withRepo(
  tool: ToolName,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return tool === "code_repos" ? { ...args } : { repo: REPO, ...args };
}

function contextOf(c: GoldenCase): CaseContext {
  const store = hostOf(c.detail, c.maxResultChars).open(undefined, REPO);
  if ("code" in store) {
    throw new Error(`the ${c.detail} store does not open: ${store.code}`);
  }
  return {
    store,
    answer<A extends object = Record<string, unknown>>(key: string): A {
      const answer = answers.get(key);
      if (answer === undefined) {
        throw new Error(
          `no answer of ${key}: that case must come first, and answer`,
        );
      }
      return answer as A;
    },
    run: (tool, args) =>
      runTool(hostOf(c.detail), undefined, tool, withRepo(tool, args)),
  };
}

// The result as its golden file holds it. A code_repos answer's builtAt must read as an ISO time,
// and is then written as "<builtAt>".
function goldenResult(
  tool: ToolName,
  result: ToolResult,
): { answer: object } | { error: ToolError } {
  if (!result.ok) return { error: result.error };
  if (tool !== "code_repos") return { answer: result.answer };
  const answer = structuredClone(result.answer) as ReposAnswer;
  for (const repo of answer.repos) {
    if (repo.builtAt === null) continue;
    expect(repo.builtAt).toMatch(BUILT_AT);
    repo.builtAt = "<builtAt>";
  }
  return { answer };
}

function goldenText(
  c: GoldenCase,
  args: Record<string, unknown>,
  result: ToolResult,
): string {
  const call = {
    tool: c.tool,
    args,
    detail: c.detail,
    ...(c.maxResultChars === undefined
      ? {}
      : { maxResultChars: c.maxResultChars }),
  };
  return `${JSON.stringify({ call, result: goldenResult(c.tool, result) }, null, 2)}\n`;
}

const keyOf = (c: GoldenCase): string => `${c.tool}/${c.name}`;

for (const c of CASES) {
  it(keyOf(c), (ctx) => {
    requireInCI(ctx, PYTHON);
    const context = contextOf(c);
    const args = withRepo(
      c.tool,
      typeof c.args === "function" ? c.args(context) : c.args,
    );
    const result = runTool(
      hostOf(c.detail, c.maxResultChars),
      undefined,
      c.tool,
      args,
    );
    if (result.ok) answers.set(keyOf(c), result.answer);
    c.premise?.(result, context);
    const text = goldenText(c, args, result);
    const file = join(DIR, c.tool, `${c.name}.json`);
    if (UPDATE) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    } else {
      // the message names the golden file, relative to the repo, beside the diff
      expect(text, `test/golden/${c.tool}/${c.name}.json`).toBe(
        readFileSync(file, "utf8"),
      );
    }
  });
}

// The paths, relative to dir, of the .json files under it at any depth.
function jsonFiles(dir: string, under = ""): string[] {
  return readdirSync(join(dir, under), { withFileTypes: true }).flatMap((e) => {
    const path = under === "" ? e.name : `${under}/${e.name}`;
    if (e.isDirectory()) return jsonFiles(dir, path);
    return e.name.endsWith(".json") ? [path] : [];
  });
}

it("has one golden file for each case, and no other", () => {
  const keys = CASES.map(keyOf);
  expect(new Set(keys).size).toBe(keys.length);
  expect(jsonFiles(DIR).sort()).toEqual(keys.map((k) => `${k}.json`).sort());
});

it("has a case for every tool, and three code_explain cases or more", () => {
  expect(TOOL_NAMES.filter((t) => !CASES.some((c) => c.tool === t))).toEqual(
    [],
  );
  expect(
    CASES.filter((c) => c.tool === "code_explain").length,
  ).toBeGreaterThanOrEqual(3);
});
