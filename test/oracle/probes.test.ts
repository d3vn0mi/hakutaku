// The facts of fixtures/observatory/oracle.json that only the query tools can show, checked
// through runTool over a fixed host on the sample's standard store: each probe's answer, which
// must hold the oracle's expected answer as a deep subset, or its error code; each transitive
// scoped call, which code_callers finds with scope "transitive" and not with scope "direct";
// each unscoped call, which it finds with labels ["unscoped"]; and each untrusted line, which
// code_snippet returns marked untrusted, and which the probes' answers and code_explain of its
// file carry only under a text or lines key. The oracle owes at least one fact of each of these
// kinds, so a block with none fails.
//
// Run `node dist/cli/main.js engines install --yes` once first. The store is built with the
// Python the engines were installed with, since grimp must run: where that Python does not
// start, the tests are skipped, and in CI they fail.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { afterAll, expect, it } from "vitest";
import { formatId } from "../../src/model/index.js";
import type { Store } from "../../src/store/index.js";
import {
  type CallersAnswer,
  type ErrorCode,
  type Host,
  runTool,
  type SnippetAnswer,
  type ToolName,
  type ToolResult,
} from "../../src/tools/index.js";
import { fixedHost } from "../helpers/fixed-host.js";
import { requireInCI } from "../helpers/live.js";
import { samplePythonProbe, sampleStore } from "../helpers/sample.js";
import { isDeepSubset } from "../helpers/subset.js";

type Path = string; // repo-relative
type LocalId = string; // an ID without its "observatory:"

// The facts this file reads, with their fields; test/oracle/sample.test.ts checks the other
// kinds, named last.
type OracleFact =
  | {
      fact: "call";
      file: Path;
      line: number;
      caller: LocalId;
      target: LocalId;
      label: "bound" | "scoped" | "unscoped";
      collision: boolean;
      scope: "direct" | "transitive";
    }
  | { fact: "untrusted"; file: Path; line: number }
  | {
      fact: "probe";
      tool: ToolName;
      args: Record<string, unknown>;
      expect: { answer: object } | { error: ErrorCode };
    }
  | {
      fact:
        | "file"
        | "absent"
        | "import"
        | "definition"
        | "reference"
        | "entry"
        | "cycle"
        | "redacted"
        | "computed-import";
    };

type FactKind = OracleFact["fact"];
type FactOf<K extends FactKind> = Extract<OracleFact, { fact: K }>;

const TIMEOUT = 300_000;
const PYTHON = samplePythonProbe();
const REPO = "observatory";
const ORACLE: { facts: OracleFact[] } = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../fixtures/observatory/oracle.json", import.meta.url),
    ),
    "utf8",
  ),
);

const factsOf = <K extends FactKind>(kind: K): FactOf<K>[] =>
  ORACLE.facts.filter((f): f is FactOf<K> => f.fact === kind);

const fileId = (path: Path): string =>
  formatId({ kind: "file", repo: REPO, path });
const idOf = (local: LocalId): string => `${REPO}:${local}`;

let opened: Promise<{ host: Host; store: Store }> | undefined;

// A fixed host on the sample's standard store, and that store as the host opened it, made once
// for this file.
function sample(): Promise<{ host: Host; store: Store }> {
  opened ??= sampleStore("standard").then((path) => {
    const host = fixedHost({ [REPO]: path });
    const store = host.open(undefined, REPO);
    if ("code" in store) throw new Error(`the sample store: ${store.code}`);
    return { host, store };
  });
  return opened;
}

afterAll(async () => {
  (await opened?.catch(() => undefined))?.store.close();
});

function answerOf<A extends object>(r: ToolResult): A {
  if (!r.ok) {
    throw new Error(
      `expected an answer, not ${r.error.code}: ${r.error.message}`,
    );
  }
  return r.answer as A;
}

interface Site {
  caller: string;
  file: string;
  line: number;
  label: string;
  collision: boolean;
}

const siteOf = (f: FactOf<"call">): Site => ({
  caller: idOf(f.caller),
  file: fileId(f.file),
  line: f.line,
  label: f.label,
  collision: f.collision,
});

// Every site code_callers lists for a target with these arguments and limit 200, over every page
// it goes out in.
function sitesOf(
  host: Host,
  target: LocalId,
  args: Record<string, unknown>,
): Site[] {
  const sites: Site[] = [];
  let offset: number | undefined;
  for (let page = 0; page < 100; page++) {
    const a = answerOf<CallersAnswer>(
      runTool(host, undefined, "code_callers", {
        repo: REPO,
        symbol: idOf(target),
        limit: 200,
        ...args,
        ...(offset === undefined ? {} : { offset }),
      }),
    );
    for (const caller of a.callers) {
      for (const s of caller.sites) {
        sites.push({
          caller: caller.id,
          file: caller.file,
          line: s.line,
          label: s.label,
          collision: s.collision === true,
        });
      }
    }
    if (!("nextOffset" in a) || a.nextOffset === undefined) return sites;
    offset = a.nextOffset;
  }
  throw new Error(`the callers of ${target} go out in over 100 pages`);
}

// A file's stored line, as the store holds it, redacted.
function storedLine(store: Store, path: Path, line: number): string {
  const row = store.db
    .prepare(
      "SELECT o.body FROM sources AS o JOIN files AS f ON f.id = o.file_id WHERE f.path = ?",
    )
    .get(path);
  const body = row?.body;
  const text =
    body instanceof Uint8Array
      ? inflateSync(body).toString("utf8").split("\n")[line - 1]
      : undefined;
  if (text === undefined) throw new Error(`no stored line ${path}:${line}`);
  return text;
}

// The keys under which a string holding needle sits in value, at any depth; an array's elements
// sit under the array's own key.
function keysHolding(value: unknown, needle: string, key = ""): string[] {
  if (typeof value === "string") return value.includes(needle) ? [key] : [];
  if (Array.isArray(value)) {
    return value.flatMap((v) => keysHolding(v, needle, key));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => keysHolding(v, needle, k));
  }
  return [];
}

const bodyOf = (r: ToolResult): unknown => (r.ok ? r.answer : r.error);

it(
  "answers each probe with the oracle's answer as a deep subset, or with its error",
  async (ctx) => {
    requireInCI(ctx, PYTHON);
    const { host } = await sample();
    const probes = factsOf("probe");
    expect(probes.length).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const p of probes) {
      const r = runTool(host, undefined, p.tool, p.args);
      const call = `${p.tool} ${JSON.stringify(p.args)}`;
      if ("error" in p.expect) {
        if (r.ok || r.error.code !== p.expect.error) {
          problems.push(`${call}: ${JSON.stringify(bodyOf(r))}`);
        }
      } else if (!r.ok || !isDeepSubset(p.expect.answer, r.answer)) {
        problems.push(`${call}: ${JSON.stringify(bodyOf(r))}`);
      }
    }
    expect(problems).toEqual([]);
  },
  TIMEOUT,
);

it(
  "finds each transitive scoped call with scope transitive, and no site at its line with scope direct",
  async (ctx) => {
    requireInCI(ctx, PYTHON);
    const { host } = await sample();
    const facts = factsOf("call").filter(
      (f) => f.scope === "transitive" && f.label === "scoped",
    );
    expect(facts.length).toBeGreaterThan(0);
    for (const f of facts) {
      const site = siteOf(f);
      expect(sitesOf(host, f.target, { scope: "transitive" })).toContainEqual(
        site,
      );
      expect(
        sitesOf(host, f.target, { scope: "direct" }).filter(
          (s) => s.file === site.file && s.line === site.line,
        ),
      ).toEqual([]);
    }
  },
  TIMEOUT,
);

it(
  "finds each unscoped call with labels unscoped",
  async (ctx) => {
    requireInCI(ctx, PYTHON);
    const { host } = await sample();
    const facts = factsOf("call").filter((f) => f.label === "unscoped");
    expect(facts.length).toBeGreaterThan(0);
    for (const f of facts) {
      expect(sitesOf(host, f.target, { labels: ["unscoped"] })).toContainEqual(
        siteOf(f),
      );
    }
  },
  TIMEOUT,
);

it(
  "returns each untrusted line marked untrusted, and carries it only under text or lines",
  async (ctx) => {
    requireInCI(ctx, PYTHON);
    const { host, store } = await sample();
    const facts = factsOf("untrusted");
    expect(facts.length).toBeGreaterThan(0);
    const probes = factsOf("probe").map((p) =>
      runTool(host, undefined, p.tool, p.args),
    );
    for (const f of facts) {
      const stored = storedLine(store, f.file, f.line);
      const needle = stored.trim();
      expect(needle).not.toBe("");
      const snippet = runTool(host, undefined, "code_snippet", {
        repo: REPO,
        file: f.file,
        from: f.line,
        to: f.line,
      });
      const a = answerOf<SnippetAnswer>(snippet);
      expect(a.untrusted).toBe(true);
      expect(a.lines[0]).toContain(stored);
      // the walk finds the line where the snippet holds it
      expect(keysHolding(bodyOf(snippet), needle)).toEqual(["lines"]);
      const explain = runTool(host, undefined, "code_explain", {
        repo: REPO,
        target: f.file,
      });
      expect(explain.ok).toBe(true);
      for (const r of [...probes, explain]) {
        expect(
          keysHolding(bodyOf(r), needle).filter(
            (key) => key !== "text" && key !== "lines",
          ),
        ).toEqual([]);
      }
    }
  },
  TIMEOUT,
);
