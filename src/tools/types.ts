// The agent contract's shapes: each tool's arguments and answers. Argument names are
// snake_case, answer names camelCase. Every type declares its fields in the order they
// serialize, and `view`, where an answer has one, comes last. TypeScript cannot pin the order
// of keys, so the golden answers do.
import type {
  DefKind,
  Detail,
  Id,
  ImportKind,
  Label,
  Lang,
  RefRole,
  RepoId,
  Severity,
  Stale,
} from "../model/index.js";
import type { LastAttempt } from "./host.js";

export type ToolName =
  | "code_repos"
  | "code_overview"
  | "code_find"
  | "code_explain"
  | "code_callers"
  | "code_references"
  | "code_impact"
  | "code_deps"
  | "code_path"
  | "code_rules"
  | "code_search_text"
  | "code_snippet"
  | "code_refresh";

export const TOOL_NAMES: readonly ToolName[] = Object.freeze([
  "code_repos",
  "code_overview",
  "code_find",
  "code_explain",
  "code_callers",
  "code_references",
  "code_impact",
  "code_deps",
  "code_path",
  "code_rules",
  "code_search_text",
  "code_snippet",
  "code_refresh",
]);

// The freshness every answer about a repo's content carries. builtCommit is 12 hex.
export interface Fresh {
  builtCommit: string;
  stale: Stale;
}

// The paging fields. They count items, or characters in code_snippet's window; nextOffset is
// there only while hasMore.
export interface PageFields {
  offset: number;
  returned: number;
  total: number;
  hasMore: boolean;
  nextOffset?: number;
  note: string;
}

// An answer carries no paging field at all when it is whole, and every one of them on a page.
// biome-ignore lint/complexity/noBannedTypes: {} is the whole answer's empty set of paging fields; it is only ever intersected with an object type
export type Paged = {} | PageFields;

// code_explain's `metrics`, shared by its two answers.
export interface ExplainMetrics {
  dependentsRank: number | null;
  importedBy: number;
  imports: number;
  commits90d: number;
  hotspot: number;
}

// Arguments. A comment gives the default, which the tool's input schema declares too.

export type ReposArgs = Record<string, never>;

export interface OverviewArgs {
  repo: string;
  component?: string;
}

export interface FindArgs {
  repo: string;
  name: string;
  kind?: DefKind | "file";
  offset?: number;
  limit?: number; // 20, at most 200
}

export interface ExplainArgs {
  repo: string;
  target: string;
}

export interface CallersArgs {
  repo: string;
  symbol: string;
  labels?: Label[]; // ["bound", "scoped"]
  scope?: "direct" | "transitive"; // "direct"
  include_tests?: boolean; // true
  depth?: 1 | 2 | 3; // 1
  offset?: number;
  limit?: number; // 50 callers, at most 200
}

export interface ReferencesArgs {
  repo: string;
  symbol: string;
  offset?: number;
  limit?: number; // 100, at most 500
}

export interface ImpactArgs {
  repo: string;
  target: string;
  depth?: 1 | 2 | 3; // 2
  include_tests?: boolean; // true
  offset?: number;
  limit?: number; // 50 nodes reached, at most 200
}

export interface DepsArgs {
  repo: string;
  file: string;
  direction: "in" | "out";
  transitive?: boolean; // false
  kinds?: ImportKind[];
  offset?: number;
  limit?: number; // 100, at most 500
}

export interface PathArgs {
  repo: string;
  from: string;
  to: string;
  via?: "imports" | "calls"; // "imports"
}

export interface RulesArgs {
  repo: string;
  offset?: number;
  limit?: number; // 100, at most 500
}

export interface SearchTextArgs {
  repo: string;
  text: string; // at least 3 characters
  path_glob?: string;
  offset?: number;
  limit?: number; // 50, at most 200
}

export interface SnippetArgs {
  repo: string;
  target?: string;
  file?: string;
  from?: number;
  to?: number;
  offset?: number; // characters, to read the next window
}

export interface RefreshArgs {
  repo: string;
}

// Answers.

// code_repos: a list answer, so no view.
export interface ReposAnswer {
  repos: Array<{
    id: RepoId;
    ref: string;
    builtCommit: string | null;
    headCommit: string | null;
    stale: Stale;
    staleReason?: string;
    builtAt: string | null;
    detail: Detail;
    snippets: boolean;
    languages: Record<Lang, number>;
    coverage: {
      files: number;
      indexed: Record<Lang, number>;
      unresolvedImports: number;
      callSites: { bound: number; scoped: number; unresolved: number };
      redactions: number;
    };
    engines: Record<string, string>;
  }>;
}

// code_overview for the whole repo.
export interface OverviewRepoAnswer {
  id: Id;
  kind: "repo";
  builtCommit: string;
  stale: Stale;
  files: number;
  tests: number;
  lines: number;
  languages: Record<Lang, number>;
  coreSet: {
    files: number;
    ofFiles: number; // the production files
    share: number; // the set carries at least this share of the PageRank
    top: Array<{ id: Id; dependentsRank: number; importedBy: number }>;
  };
  components: {
    total: number;
    top: Array<{
      id: Id;
      files: number;
      tests: number;
      coreFiles: number;
      entryPoints: number;
    }>;
  };
  dependsOn: {
    total: number;
    top: Array<{ from: Id; to: Id; imports: number }>; // between components
  };
  entryPoints: {
    total: number;
    top: Array<{ id: Id; kind: string; via: Id; line: number }>;
  };
  hotspots: {
    total: number;
    top: Array<{ id: Id; hotspot: number; commits90d: number }>;
  };
  cycles: { total: number; top: Id[][] };
  view: "#";
}

// code_overview with a component.
export interface OverviewComponentAnswer {
  id: Id;
  kind: "component";
  builtCommit: string;
  stale: Stale;
  files: number;
  tests: number;
  core: Array<{ id: Id; importedBy: number }>; // the top 6 by rank
  entryPoints: Id[]; // the top 6
  view: string;
}

// code_find: a list answer, so no view.
export type FindAnswer = { query: string } & Fresh &
  Paged & {
    matches: Array<{
      id: Id;
      kind: DefKind | "file" | "test-file";
      match: "exact" | "case" | "prefix" | "substring";
      line?: number;
      container?: Id;
      exported?: boolean;
      usedByFiles?: number;
    }>;
  };

// code_explain for a file. The lists hold the top 8 importers, 8 imports, 6 co-change
// partners and 8 definitions.
export interface ExplainFileAnswer {
  id: Id;
  kind: "file" | "test-file";
  builtCommit: string;
  stale: Stale;
  component: string; // the component's path
  lines: number;
  entryPoint: boolean;
  inImportCycle: boolean;
  metrics: ExplainMetrics;
  importedBy: { total: number; top: Id[] };
  imports: { total: number; top: Id[] };
  changesTogetherWith: Array<{ id: Id; commits: number }>;
  definitions: {
    total: number;
    top: Array<{
      id: Id;
      kind: DefKind;
      line: number;
      exported: boolean;
      usedByFiles: number;
      mentionedByTests: boolean;
    }>;
  };
  view: string;
}

// code_explain for a definition. The fields from `component` on describe the file that
// defines it.
export interface ExplainDefinitionAnswer {
  id: Id;
  kind: DefKind;
  builtCommit: string;
  stale: Stale;
  definedIn: Id;
  line: number;
  usedByFiles: number;
  mentionedByTests: boolean;
  label: "bound" | "scoped";
  note: string;
  component: string;
  lines: number;
  entryPoint: boolean;
  inImportCycle: boolean;
  metrics: ExplainMetrics;
  importedBy: { total: number; top: Id[] };
  imports: { total: number; top: Id[] };
  changesTogetherWith: Array<{ id: Id; commits: number }>;
  view: string;
}

export type CallersAnswer = { id: Id } & Fresh &
  Paged & {
    labels: Label[];
    scope: "direct" | "transitive";
    depth: number;
    counts: {
      files: number;
      callers: number;
      sites: number;
      bound: number;
      scoped: number;
      unscoped: number;
    };
    callers: Array<{
      id: Id;
      file: Id;
      test: boolean;
      hop: number;
      part?: string; // "<k>/<n>", only when the caller is split into parts
      sites: Array<{
        line: number;
        col: number;
        label: Label;
        collision?: true;
        text?: string;
      }>;
    }>;
    blindSpots: string[];
    view: string;
  };

// code_references for a definition.
export type ReferencesAnswer = { id: Id } & Fresh &
  Paged & {
    references: Array<{
      in: Id;
      file: Id;
      line: number;
      col: number;
      role: RefRole;
      test: boolean;
      text?: string;
    }>;
    view: string;
  };

// code_references for an external module.
export interface LibraryReferencesAnswer {
  id: Id;
  kind: "library";
  builtCommit: string;
  stale: Stale;
  importedBy: { total: number; top: Id[] };
  view: string;
}

// code_impact: a list answer, paged over the nodes it reaches, so no view.
export type ImpactAnswer = { id: Id } & Fresh &
  Paged & {
    depth: number;
    byHop: Array<{
      hop: number;
      definitions: Array<{ id: Id; label: Label }>;
      files: Id[];
      tests: Id[];
    }>;
    counts: { definitions: number; files: number; tests: number };
    blindSpots: string[];
  };

export type DepsAnswer = { id: Id } & Fresh &
  Paged & {
    direction: "in" | "out";
    edges: Array<{
      id: Id;
      kind: ImportKind;
      line: number;
      hop?: number;
      specifier?: string;
      text?: string;
    }>;
    view: string;
  };

// code_path: view names the from node.
export type PathAnswer = {
  from: Id;
  to: Id;
  via: "imports" | "calls";
} & Fresh & {
    found: boolean;
    hops: Array<{
      from: Id;
      to: Id;
      kind: ImportKind | Label;
      line: number;
      text?: string;
    }>;
    view: string;
  };

// code_rules: a list answer, one list of findings.
export type RulesAnswer = Fresh &
  Paged & {
    findings: Array<{
      kind: "cycle" | "violation";
      id: Id;
      severity: Severity;
      rule?: string; // a violation: the rule it breaks
      files?: Id[]; // a cycle: its strongly connected files, in path order
      from?: Id; // a violation: the import that breaks the rule
      to?: Id;
      part?: string; // "<k>/<n>", only when the finding is split into parts
      chain: Array<{ from: Id; to: Id; line: number }>;
    }>;
  };

// code_search_text: a list answer.
export type SearchTextAnswer = { text: string } & Fresh &
  Paged & { hits: Array<{ file: Id; line: number; text?: string }> };

// code_snippet. On a window, the paging fields count characters.
export type SnippetAnswer = { id: Id; file: Id } & Fresh &
  Paged & {
    from: number;
    to: number;
    lines: string[];
    truncated: boolean;
    next?: { from: number; to: number };
    redactions: number;
    untrusted: true;
    view: string;
  };

export interface RefreshAnswer {
  state: "queued" | "building" | "idle" | "failed";
  builtCommit: string | null;
  headCommit: string | null;
  lastAttempt?: LastAttempt;
  retryAfterSeconds?: number;
}

export interface ToolIO {
  code_repos: { args: ReposArgs; answer: ReposAnswer };
  code_overview: {
    args: OverviewArgs;
    answer: OverviewRepoAnswer | OverviewComponentAnswer;
  };
  code_find: { args: FindArgs; answer: FindAnswer };
  code_explain: {
    args: ExplainArgs;
    answer: ExplainFileAnswer | ExplainDefinitionAnswer;
  };
  code_callers: { args: CallersArgs; answer: CallersAnswer };
  code_references: {
    args: ReferencesArgs;
    answer: ReferencesAnswer | LibraryReferencesAnswer;
  };
  code_impact: { args: ImpactArgs; answer: ImpactAnswer };
  code_deps: { args: DepsArgs; answer: DepsAnswer };
  code_path: { args: PathArgs; answer: PathAnswer };
  code_rules: { args: RulesArgs; answer: RulesAnswer };
  code_search_text: { args: SearchTextArgs; answer: SearchTextAnswer };
  code_snippet: { args: SnippetArgs; answer: SnippetAnswer };
  code_refresh: { args: RefreshArgs; answer: RefreshAnswer };
}

export type ToolArgs<N extends ToolName> = ToolIO[N]["args"];
export type ToolAnswer<N extends ToolName> = ToolIO[N]["answer"];

// The arguments each tool's input schema gives a default.
interface Defaulted {
  code_repos: never;
  code_overview: never;
  code_find: "limit";
  code_explain: never;
  code_callers: "labels" | "scope" | "include_tests" | "depth" | "limit";
  code_references: "limit";
  code_impact: "depth" | "include_tests" | "limit";
  code_deps: "transitive" | "limit";
  code_path: "via";
  code_rules: "limit";
  code_search_text: "limit";
  code_snippet: never;
  code_refresh: never;
}

// A tool's arguments once checked: every argument with a default is present. offset has no
// default and stays optional, so a query can tell an explicit offset from none.
export type Checked<N extends ToolName> = Omit<ToolArgs<N>, Defaulted[N]> &
  Required<Pick<ToolArgs<N>, Extract<Defaulted[N], keyof ToolArgs<N>>>>;
