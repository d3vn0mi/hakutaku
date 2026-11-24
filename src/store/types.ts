// The store's types: the rows writeStore takes, and what a reader answers.
//
// Positions: lines are 1-based, columns are 1-based Unicode code points, and every range's end
// is exclusive.
import type { DatabaseSync } from "node:sqlite";
import type {
  DefKind,
  Detail,
  Ecosystem,
  EngineName,
  EntryKind,
  FileKind,
  GitMode,
  ImportKind,
  Lang,
  Producer,
  RefRole,
  RepoId,
  Severity,
  ShadowedModule,
} from "../model/index.js";

export interface Coverage {
  files: number; // rows in files
  indexed: Record<Lang, number>; // code, test and test-support files indexed, per language
  unresolvedImports: number; // unresolved relative imports
  callSites: { bound: number; scoped: number; unresolved: number };
  redactions: number;
  // The five fields above are code_repos' coverage. Those below feed blindSpots and the gates.
  tiers: Partial<Record<EngineName, "ran" | "skipped" | "failed" | "fallback">>;
  pythonResolver: "grimp" | "hakutaku-resolver" | "none";
  computedImports: number; // import() calls with a computed specifier
  unmatchedScipDefinitions: number;
  unmatchedBoundUses: number;
  cycleDifferences: number; // Tarjan's cycles against dependency-cruiser's
  noSourceFiles: number; // over 1 MB, minified or generated
  denied: number; // denylisted paths left out at export
  // The rules file's cycle severity, "warn" without one. It is the store's only copy, read by
  // code_rules, and not one of code_repos' fields.
  cycleSeverity: Severity;
  // The tiers that failed for want of memory, each with its fixed wording and repair, and the
  // memory cap the build had. Present only when a tier did, so another build's hash is
  // unchanged; a build with another cap is never skipped over it, so the repair can work.
  outOfMemory?: {
    memoryMax: string;
    tiers: Partial<Record<EngineName, string>>;
  };
  // The Python files an import statement could name that give no module, since another file
  // holds their name, in path order. The files-indexed gate does not count them, and blindSpots
  // names them. Present only when there is one, so another build's hash is unchanged.
  shadowedPython?: ShadowedModule[];
}

export interface GateResult {
  gate:
    | "files-indexed"
    | "unresolved-imports"
    | "scip-duplicates"
    | "denylist"
    | "redaction";
  ok: boolean;
  detail: string;
}

export interface StoreMeta {
  schemaVersion: number;
  hakutakuVersion: string;
  repoId: RepoId;
  commit: string;
  commitTime: number;
  detail: Detail;
  noSource: boolean;
  engines: Record<string, string>;
  engineLockHash: string;
  profileHash: string;
  rulesHash: string;
  coverage: Coverage;
  gates: GateResult[];
}

export interface Store {
  readonly path: string;
  readonly db: DatabaseSync;
  readonly meta: StoreMeta;
  readonly run: { ref: string; contentHash: string; builtAt: string };
  close(): void;
}

export interface NotBuilt {
  code: "not_built";
  reason: string;
}

// attempt.json beside the store: the last attempt, and why it failed.
export interface Attempt {
  at: string; // ISO 8601 UTC
  commit: string; // 40 hex
  result: "built" | "skipped" | "gates-failed" | "failed";
  reason?: string;
}

// build.json beside the store: what varies from one build of a commit to the next.
export interface BuildFacts {
  commit: string;
  ref: string;
  contentHash: string;
  startedAt: string;
  finishedAt: string;
  wallMs: number;
  peakRssBytes: number | null;
  sandbox: "bubblewrap" | "systemd-run" | "none" | "unavailable";
  engines: Partial<
    Record<
      EngineName,
      {
        status: "ran" | "skipped" | "failed" | "timed-out" | "fallback";
        wallMs: number;
        cpuMs: number | null;
        peakRssBytes: number | null;
        exitCode: number | null;
      }
    >
  >;
  warnings: string[];
}

// The rows writeStore takes. Each row's keys are exactly its table's columns, a flag is 0 or 1,
// and a column that may be NULL takes null. JSON columns take objects.

export interface MetaRow {
  schema_version: number;
  hakutaku_version: string;
  repo_id: RepoId;
  commit_sha: string; // 40 hex
  commit_time: number; // committer date, Unix seconds
  detail: Detail;
  no_source: 0 | 1;
  engines: Partial<Record<EngineName, string>>; // the version of each engine that ran
  engine_lock_hash: string;
  profile_hash: string; // sha256 hex of the profile copy's bytes
  rules_hash: string; // sha256 hex of the rules copy's bytes; "" when there is none
  coverage: Coverage;
  gates: GateResult[];
}

export interface ComponentRow {
  id: number;
  path: string; // ends with "/"
  kind: "package" | "python-package" | "folder" | "profile" | "split";
  parent_id: number | null; // the component it split from
  files: number; // production code files
  tests: number; // test and test-support files
  lines: number;
}

export interface FileRow {
  id: number;
  path: string; // exactly as git tracks it
  lang: Lang | null; // null unless kind is code, test or test-support
  kind: FileKind;
  component_id: number | null; // null unless kind is code, test or test-support
  lines: number;
  bytes: number;
  blob_sha: string; // for a submodule, its commit
  mode: GitMode;
  link_target: string | null; // mode 120000 only: the link text, never followed
  entry: 0 | 1; // 1 when an entry_points row of a kind other than dev-script names it
  has_source: 0 | 1; // 1 when sources holds its body
}

export interface DefinitionRow {
  id: number;
  file_id: number;
  qualname: string; // "Orbit.position"; "<module>" for module scope
  ordinal: number; // 1, or n >= 2 for the nth repeat in file order
  name: string; // the last segment of qualname
  kind: DefKind | "module";
  start_line: number; // the enclosing range
  start_col: number;
  end_line: number;
  end_col: number;
  exported: 0 | 1;
  parent_id: number | null;
  scip_symbol: string | null;
  signature: string | null; // one line, redacted
  producer: Producer;
}

export interface ExternalRow {
  id: number;
  ecosystem: Ecosystem;
  name: string;
  files: number; // the repo files that import it
}

export interface ImportRow {
  id: number;
  src_file_id: number;
  dst_file_id: number | null;
  dst_external_id: number | null;
  kind: ImportKind;
  line: number;
  specifier: string; // as written, redacted
  resolved: 0 | 1; // 1 when exactly one dst_* column is set
  producer: Producer;
}

export interface CallSiteRow {
  id: number;
  file_id: number;
  line: number;
  col: number;
  enclosing_def_id: number; // the nearest named definition, else the file's <module> row
  callee_name: string;
  receiver_text: string | null; // redacted
  producer: Producer;
}

export interface CallTargetRow {
  site_id: number;
  def_id: number;
  label: "bound" | "scoped";
  collision: 0 | 1; // 1: a scoped site whose file sees two or more definitions of the name
}

export interface RefRow {
  id: number;
  file_id: number;
  line: number;
  col: number;
  enclosing_def_id: number;
  def_id: number;
  role: RefRole;
  producer: Producer;
}

export interface EntryPointRow {
  file_id: number;
  def_id: number | null; // a console-script's module:function
  kind: EntryKind;
  manifest_file_id: number; // the file itself for executable, main-guard and route
  manifest_line: number;
  name: string; // the command, script, unit or route; the file's path for the secondary signals
}

export interface FileMetricRow {
  file_id: number;
  pagerank: number | null; // null for tests and test support
  dependents_rank: number | null; // 1 = the most depended-on production file; null off production
  fan_in: number; // the repo files that import it, tests included
  fan_out: number; // the repo files it imports
  churn_90d: number;
  hotspot: number | null; // 0..1, two decimals; null off production
  cycle_id: number | null; // null when it is in no cycle
  core: 0 | 1; // 1 when it is in the core set
  last_change: number | null; // committer time of the newest commit that touched it; null when none did
}

export interface DefMetricRow {
  def_id: number;
  used_by_files: number;
  used_by_files_bound: number; // of those, the files with a bound use or a SCIP reference
  mentioned_by_tests: number;
}

export interface CochangeRow {
  file_id: number;
  partner_file_id: number;
  commits: number;
}

export interface CycleRow {
  cycle_id: number; // 1.. in the order of each set's first file path
  ord: number; // 0.. along the chain, starting at that first file
  file_id: number;
  line: number; // the line in this file that imports the next one
}

export interface RuleFindingRow {
  id: number;
  rule: string;
  severity: Severity;
  from_file_id: number;
  to_file_id: number;
  chain: { from: string; to: string; line: number }[]; // repo paths
  producer: Producer;
}

export interface TimelineRow {
  week_start: number; // Unix seconds
  commits: number; // commits whose time is in (week_start, week_start + 604800]
}

export interface RenameRow {
  old_path: string;
  new_path: string;
  commit_sha: string;
}

export interface TextIndexRow {
  text: string; // one non-empty line of a stored source, redacted
  file_id: number;
  line: number;
}

// One array per table, named after it, plus run, whose content_hash the writer computes.
export interface StoreContent {
  meta: MetaRow[]; // exactly one row
  components: ComponentRow[];
  files: FileRow[];
  sources: { file_id: number; text: string }[]; // the redacted UTF-8 text; the writer deflates it
  definitions: DefinitionRow[];
  externals: ExternalRow[];
  imports: ImportRow[];
  call_sites: CallSiteRow[];
  call_targets: CallTargetRow[];
  refs: RefRow[];
  entry_points: EntryPointRow[];
  file_metrics: FileMetricRow[];
  def_metrics: DefMetricRow[];
  cochange: CochangeRow[];
  cycles: CycleRow[];
  rule_findings: RuleFindingRow[];
  timeline: TimelineRow[];
  renames: RenameRow[];
  text_index: TextIndexRow[];
  run: { ref: string; built_at: string }; // built_at: ISO 8601 UTC
}
