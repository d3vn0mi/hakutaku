// The summary hakutaku map prints once a store is built or found current: the build's header, one
// line for each part of the store, how it was built, and then the commands to run next. Numbers
// are written as en-US writes them (1,204); memory and sizes in units of 1024.
import {
  comparePaths,
  type Detail,
  type Lang,
  type RepoId,
} from "../model/index.js";
import { displayLang } from "../query/tiers.js";
import type { BuildFacts, Coverage, Store } from "../store/index.js";
import { printable } from "./table.js";

// What the summary counts in a store.
export interface SummaryCounts {
  tracked: number; // the files git tracks: the store's files and the denylisted ones left out
  code: Readonly<Record<Lang, number>>; // code, test and test-support files, per language
  production: number; // code files
  test: number; // test and test-support files
  edges: number; // pairs of repo files, one importing the other
  unresolvedRelative: number; // relative imports that resolved to no file
  cycles: number;
  callSites: Coverage["callSites"];
  entryPoints: number; // dev scripts left out
  launchManifests: number; // the files those entry points are launched from
  core: number; // production files in the core set
}

export interface SummaryInput {
  version: string;
  id: RepoId;
  commit: string; // 40 hex
  ref: string; // as map was asked for it
  detail: Detail;
  counts: SummaryCounts;
  build: BuildFacts | null; // the facts of the build that made the store; null when unknown
  storeBytes: number;
  result: "built" | "skipped";
  pythonResolver: Coverage["pythonResolver"];
  pythonWhy?: string; // why hakutaku's resolver read the Python imports, when it did
  commands: readonly string[]; // the registered commands: only these are named next
}

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

// A part's name, padded so that every part's text starts in one column.
const part = (name: string, text: string): string =>
  `  ${name.padEnd(11)}${text}`;

const whole = (n: number): string => n.toLocaleString("en-US");

const oneDecimal = (n: number): string =>
  n.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

// "1 edge", "2 edges".
const counted = (n: number, one: string, many: string): string =>
  `${whole(n)} ${n === 1 ? one : many}`;

// The commands named next, in this order, each only when it is registered.
const NEXT: ReadonlyArray<{
  command: string;
  what: string;
}> = [
  { command: "view", what: "the map, in your browser" },
  { command: "mcp", what: "the tools, for an agent" },
];

export function formatSummary(s: SummaryInput): string[] {
  const c = s.counts;
  const commit12 = s.commit.slice(0, 12);
  const languages = Object.entries(c.code)
    .filter(([, n]) => n > 0)
    .sort(([a, m], [b, n]) => n - m || comparePaths(a, b));
  const code = languages.reduce((sum, [, n]) => sum + n, 0);
  const named =
    languages.length === 0
      ? ""
      : ` (${languages.map(([lang, n]) => `${displayLang(lang)} ${whole(n)}`).join(", ")})`;
  const { bound, scoped, unresolved } = c.callSites;
  const lines = [
    `hakutaku ${s.version} \u00b7 ${s.id} at ${commit12} (${s.ref}), ${s.detail} detail`,
    part(
      "files",
      `${whole(c.tracked)} tracked \u00b7 ${whole(code)} code${named} \u00b7 ${whole(c.production)} production, ${whole(c.test)} test`,
    ),
    part(
      "imports",
      `${counted(c.edges, "edge", "edges")} \u00b7 ${whole(c.unresolvedRelative)} unresolved relative \u00b7 ${counted(c.cycles, "cycle", "cycles")}`,
    ),
    part(
      "callers",
      `${counted(bound + scoped + unresolved, "call site", "call sites")} \u00b7 ${whole(bound)} bound \u00b7 ${whole(scoped)} scoped \u00b7 ${whole(unresolved)} unresolved`,
    ),
    part(
      "entry",
      `${counted(c.entryPoints, "entry point", "entry points")} from ${counted(c.launchManifests, "launch manifest", "launch manifests")}`,
    ),
    part(
      "core",
      c.production === 0
        ? "no production files"
        : `${whole(c.core)} of ${whole(c.production)} production files (${Math.round((100 * c.core) / c.production)}%) carry at least half of what the code depends on`,
    ),
    part("built", built(s, commit12)),
  ];
  if (s.pythonResolver === "hakutaku-resolver") {
    lines.push(
      part(
        "python",
        `imports from hakutaku's resolver: ${s.pythonWhy ?? "grimp did not run"}`,
      ),
    );
  }
  const next = NEXT.filter((n) => s.commands.includes(n.command)).map((n) => ({
    text: `hakutaku ${n.command} ${s.id}`,
    what: n.what,
  }));
  const width = Math.max(0, ...next.map((n) => n.text.length));
  for (const [i, n] of next.entries()) {
    lines.push(
      `${i === 0 ? "next  " : "      "}${n.text.padEnd(width)}    ${n.what}`,
    );
  }
  return lines;
}

// How the store came to be: skipped, or built in this time, at this peak, to this size, in this
// sandbox. A part the build's facts do not give is "?".
function built(s: SummaryInput, commit12: string): string {
  if (s.result === "skipped") {
    return `skipped: the store at ${commit12} is current`;
  }
  const b = s.build;
  const wall = b === null ? "?" : whole(Math.round(b.wallMs / 1000));
  const peak =
    b === null || b.peakRssBytes === null
      ? "peak ?"
      : `peak ${oneDecimal(b.peakRssBytes / GIB)} GB`;
  return `${wall} s \u00b7 ${peak} \u00b7 store ${oneDecimal(s.storeBytes / MIB)} MB \u00b7 sandbox: ${b?.sandbox ?? "?"}`;
}

// Why hakutaku's resolver read the Python imports, from grimp's tier in the store: grimp not
// installed, grimp failed (as its warning in the build's facts says, when they are given, made
// safe for a terminal, since an engine's error can quote a repository's line), or grimp had no
// package to read.
export function pythonWhy(
  tier: Coverage["tiers"]["grimp"],
  build: BuildFacts | null,
): string {
  switch (tier) {
    case "fallback":
      return "grimp is not installed: no suitable Python was found when the engines were installed";
    case "failed":
      return printable(
        build?.warnings
          .find((w) => w.startsWith("grimp failed"))
          ?.split("\n", 1)[0] ?? "grimp failed",
      );
    case "skipped":
      return "grimp found no Python package to read";
    default:
      return "grimp did not run";
  }
}

const CODE_KINDS = "('code', 'test', 'test-support')";

// The summary's counts, read from an open store.
export function summaryCounts(store: Store): SummaryCounts {
  const { coverage } = store.meta;
  const count = (sql: string): number =>
    Number((store.db.prepare(sql).get() as { n: number | bigint }).n);
  const code: Record<Lang, number> = {};
  const rows = store.db
    .prepare(
      `SELECT lang, COUNT(*) AS n FROM files WHERE kind IN ${CODE_KINDS} AND lang IS NOT NULL GROUP BY lang`,
    )
    .all() as Array<{ lang: string; n: number | bigint }>;
  for (const row of rows) code[row.lang] = Number(row.n);
  return {
    tracked: count("SELECT COUNT(*) AS n FROM files") + coverage.denied,
    code,
    production: count("SELECT COUNT(*) AS n FROM files WHERE kind = 'code'"),
    test: count(
      "SELECT COUNT(*) AS n FROM files WHERE kind IN ('test', 'test-support')",
    ),
    edges: count(
      "SELECT COUNT(*) AS n FROM (SELECT DISTINCT src_file_id, dst_file_id FROM imports WHERE dst_file_id IS NOT NULL)",
    ),
    unresolvedRelative: coverage.unresolvedImports,
    cycles: count("SELECT COUNT(DISTINCT cycle_id) AS n FROM cycles"),
    callSites: { ...coverage.callSites },
    entryPoints: count(
      "SELECT COUNT(*) AS n FROM entry_points WHERE kind <> 'dev-script'",
    ),
    launchManifests: count(
      "SELECT COUNT(DISTINCT manifest_file_id) AS n FROM entry_points WHERE kind <> 'dev-script'",
    ),
    core: count("SELECT COUNT(*) AS n FROM file_metrics WHERE core = 1"),
  };
}
