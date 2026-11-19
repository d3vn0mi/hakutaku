// The store schema, version 1. DDL is the shared contract's schema, verbatim, comments
// included; the content hash reads rows only, so neither the comments nor the indexes reach it.
//
// Positions: lines are 1-based, columns are 1-based Unicode code points, and every range's end
// is exclusive.

export const SCHEMA_VERSION = 1;

// The text index's tokenizer argument. It is spliced in, so that no source line reads
// `tokenize = '...'`: the secret scan takes that for a quoted value assigned to a name holding
// "token".
const TRIGRAM = "'trigram case_sensitive 1'";

export const DDL = `CREATE TABLE meta (                       -- one row
  schema_version INTEGER NOT NULL,        -- 1
  hakutaku_version TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,               -- 40 hex ("commit" is an SQL keyword)
  commit_time INTEGER NOT NULL,           -- committer date, Unix seconds
  detail TEXT NOT NULL,                   -- Detail
  no_source INTEGER NOT NULL,             -- 0 | 1
  engines TEXT NOT NULL,                  -- JSON Record<EngineName, version> of the engines that ran
  engine_lock_hash TEXT NOT NULL,         -- (addition) the lock's hash (interfaces §3.5)
  profile_hash TEXT NOT NULL,             -- sha256 hex of the profile copy's bytes
  rules_hash TEXT NOT NULL,               -- sha256 hex of the rules copy's bytes; "" when there is none
  coverage TEXT NOT NULL,                 -- JSON Coverage
  gates TEXT NOT NULL                     -- JSON GateResult[]
);
CREATE TABLE run (                        -- one row; outside the content hash
  ref TEXT NOT NULL,
  content_hash TEXT NOT NULL,             -- sha256 hex, below
  built_at TEXT NOT NULL                  -- (addition) ISO 8601 UTC
);
CREATE TABLE components (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,              -- ends with "/"
  kind TEXT NOT NULL,                     -- 'package' | 'python-package' | 'folder' | 'profile' | 'split'
  parent_id INTEGER REFERENCES components(id),  -- the component it split from
  files INTEGER NOT NULL,                 -- production code files
  tests INTEGER NOT NULL,                 -- test and test-support files
  lines INTEGER NOT NULL
);
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,              -- exactly as git tracks it
  lang TEXT,                              -- Lang; NULL unless kind is code, test or test-support
  kind TEXT NOT NULL,                     -- FileKind
  component_id INTEGER REFERENCES components(id), -- NULL unless code, test or test-support
  lines INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  blob_sha TEXT NOT NULL,                 -- for a submodule, its commit
  mode TEXT NOT NULL,                     -- GitMode
  link_target TEXT,                       -- (addition) mode 120000 only: the link text, never followed
  entry INTEGER NOT NULL,                 -- 1 when an entry_points row of a kind other than dev-script names it
  has_source INTEGER NOT NULL             -- 1 when sources holds its body
);
CREATE TABLE sources (
  file_id INTEGER PRIMARY KEY REFERENCES files(id),
  body BLOB NOT NULL                      -- zlib deflateSync(level 9) of the redacted UTF-8 text
);
CREATE TABLE definitions (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id),
  qualname TEXT NOT NULL,                 -- 'Orbit.position'; '<module>' for module scope
  ordinal INTEGER NOT NULL,               -- 1, or n >= 2 for the nth repeat in file order (§5.4)
  name TEXT NOT NULL,                     -- the last segment of qualname
  kind TEXT NOT NULL,                     -- DefKind | 'module'
  start_line INTEGER NOT NULL, start_col INTEGER NOT NULL,   -- the enclosing range
  end_line INTEGER NOT NULL, end_col INTEGER NOT NULL,
  exported INTEGER NOT NULL,
  parent_id INTEGER REFERENCES definitions(id),
  scip_symbol TEXT,
  signature TEXT,                         -- one line, redacted
  producer TEXT NOT NULL,                 -- Producer
  UNIQUE (file_id, qualname, ordinal)
);
CREATE TABLE externals (
  id INTEGER PRIMARY KEY,
  ecosystem TEXT NOT NULL,                -- Ecosystem
  name TEXT NOT NULL,
  files INTEGER NOT NULL,                 -- the repo files that import it
  UNIQUE (ecosystem, name)
);
CREATE TABLE imports (
  id INTEGER PRIMARY KEY,
  src_file_id INTEGER NOT NULL REFERENCES files(id),
  dst_file_id INTEGER REFERENCES files(id),
  dst_external_id INTEGER REFERENCES externals(id),
  kind TEXT NOT NULL,                     -- ImportKind
  line INTEGER NOT NULL,
  specifier TEXT NOT NULL,                -- as written, redacted
  resolved INTEGER NOT NULL,              -- 1 when exactly one dst_* column is set
  producer TEXT NOT NULL
);
CREATE TABLE call_sites (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id),
  line INTEGER NOT NULL, col INTEGER NOT NULL,
  enclosing_def_id INTEGER NOT NULL REFERENCES definitions(id), -- the nearest named definition, else the file's <module> row
  callee_name TEXT NOT NULL,
  receiver_text TEXT,                     -- redacted
  producer TEXT NOT NULL
);
CREATE TABLE call_targets (
  site_id INTEGER NOT NULL REFERENCES call_sites(id),
  def_id INTEGER NOT NULL REFERENCES definitions(id),
  label TEXT NOT NULL,                    -- 'bound' | 'scoped' only (addition: query time derives unscoped
                                          -- and transitive scoped matches from call_sites and imports)
  collision INTEGER NOT NULL,             -- 1: a scoped site whose file sees two or more definitions of the name
  PRIMARY KEY (site_id, def_id)
);
CREATE TABLE refs (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id),
  line INTEGER NOT NULL, col INTEGER NOT NULL,
  enclosing_def_id INTEGER NOT NULL REFERENCES definitions(id),
  def_id INTEGER NOT NULL REFERENCES definitions(id),
  role TEXT NOT NULL,                     -- RefRole
  producer TEXT NOT NULL
);
CREATE TABLE entry_points (
  file_id INTEGER NOT NULL REFERENCES files(id),
  def_id INTEGER REFERENCES definitions(id),     -- a console-script's module:function
  kind TEXT NOT NULL,                     -- EntryKind
  manifest_file_id INTEGER NOT NULL REFERENCES files(id), -- the file itself for executable, main-guard and route
  manifest_line INTEGER NOT NULL,
  name TEXT NOT NULL,                     -- the command, script, unit or route; the file's path for the secondary signals
  PRIMARY KEY (file_id, kind, manifest_file_id, manifest_line, name)  -- two bin names on one line stay two rows
);
CREATE TABLE file_metrics (               -- code, test and test-support files
  file_id INTEGER PRIMARY KEY REFERENCES files(id),
  pagerank REAL,                          -- NULL for tests and test support
  dependents_rank INTEGER,                -- 1 = the most depended-on production file; NULL off production
  fan_in INTEGER NOT NULL,                -- the repo files that import it, tests included
  fan_out INTEGER NOT NULL,               -- the repo files it imports
  churn_90d INTEGER NOT NULL,
  hotspot REAL,                           -- 0..1, two decimals; NULL off production
  cycle_id INTEGER,                       -- NULL when it is in no cycle
  core INTEGER NOT NULL,                  -- 1 when it is in the core set
  last_change INTEGER                     -- (addition) committer time, Unix seconds, of the newest History commit that
                                          -- touched the file; NULL when none did. It feeds §7.6's 7/30/90-day filter
);
CREATE TABLE def_metrics (
  def_id INTEGER PRIMARY KEY REFERENCES definitions(id),
  used_by_files INTEGER NOT NULL,
  used_by_files_bound INTEGER NOT NULL,   -- of those, the files with a bound use or a SCIP reference
  mentioned_by_tests INTEGER NOT NULL
);
CREATE TABLE cochange (                   -- the top 8 partners per file
  file_id INTEGER NOT NULL REFERENCES files(id),
  partner_file_id INTEGER NOT NULL REFERENCES files(id),
  commits INTEGER NOT NULL,
  PRIMARY KEY (file_id, partner_file_id)
);
CREATE TABLE cycles (                     -- one shortest closing chain per strongly connected set
  cycle_id INTEGER NOT NULL,              -- 1.. in the order of each set's first file path
  ord INTEGER NOT NULL,                   -- 0.. along the chain, starting at that first file
  file_id INTEGER NOT NULL REFERENCES files(id),
  line INTEGER NOT NULL,                  -- the line in this file that imports the next one
  PRIMARY KEY (cycle_id, ord)
);
CREATE TABLE rule_findings (
  id INTEGER PRIMARY KEY,
  rule TEXT NOT NULL,
  severity TEXT NOT NULL,                 -- Severity
  from_file_id INTEGER NOT NULL REFERENCES files(id),
  to_file_id INTEGER NOT NULL REFERENCES files(id),
  chain TEXT NOT NULL,                    -- JSON Array<{ from: string; to: string; line: number }> of repo paths
  producer TEXT NOT NULL
);
CREATE TABLE timeline (                   -- always 26 rows
  week_start INTEGER PRIMARY KEY,         -- commit_time − (26 − k)·604800 for k = 0..25, Unix seconds
  commits INTEGER NOT NULL                -- commits whose time is in (week_start, week_start + 604800]
);
CREATE TABLE renames (
  old_path TEXT NOT NULL, new_path TEXT NOT NULL, commit_sha TEXT NOT NULL,
  PRIMARY KEY (old_path, new_path, commit_sha)
);
CREATE VIRTUAL TABLE text_index USING fts5(
  text, file_id UNINDEXED, line UNINDEXED, tokenize = ${TRIGRAM}
);                                        -- one row per non-empty line of every stored source, redacted
CREATE INDEX call_targets_def ON call_targets(def_id);   -- (addition) lookup indexes for M7. §12 leaves indexes to the
CREATE INDEX refs_def ON refs(def_id);                   -- builder, and the content hash reads rows, never indexes
CREATE INDEX imports_dst ON imports(dst_file_id);
CREATE INDEX call_sites_callee ON call_sites(callee_name);
`;

// The tables the content hash reads, in the order it reads them. Every table but run.
export const CONTENT_TABLES = Object.freeze([
  "meta",
  "components",
  "files",
  "sources",
  "definitions",
  "externals",
  "imports",
  "call_sites",
  "call_targets",
  "refs",
  "entry_points",
  "file_metrics",
  "def_metrics",
  "cochange",
  "cycles",
  "rule_findings",
  "timeline",
  "renames",
  "text_index",
] as const);

export type ContentTable = (typeof CONTENT_TABLES)[number];

// Each table's columns, in DDL order.
export const TABLE_COLUMNS: Readonly<
  Record<ContentTable | "run", readonly string[]>
> = Object.freeze({
  meta: [
    "schema_version",
    "hakutaku_version",
    "repo_id",
    "commit_sha",
    "commit_time",
    "detail",
    "no_source",
    "engines",
    "engine_lock_hash",
    "profile_hash",
    "rules_hash",
    "coverage",
    "gates",
  ],
  run: ["ref", "content_hash", "built_at"],
  components: ["id", "path", "kind", "parent_id", "files", "tests", "lines"],
  files: [
    "id",
    "path",
    "lang",
    "kind",
    "component_id",
    "lines",
    "bytes",
    "blob_sha",
    "mode",
    "link_target",
    "entry",
    "has_source",
  ],
  sources: ["file_id", "body"],
  definitions: [
    "id",
    "file_id",
    "qualname",
    "ordinal",
    "name",
    "kind",
    "start_line",
    "start_col",
    "end_line",
    "end_col",
    "exported",
    "parent_id",
    "scip_symbol",
    "signature",
    "producer",
  ],
  externals: ["id", "ecosystem", "name", "files"],
  imports: [
    "id",
    "src_file_id",
    "dst_file_id",
    "dst_external_id",
    "kind",
    "line",
    "specifier",
    "resolved",
    "producer",
  ],
  call_sites: [
    "id",
    "file_id",
    "line",
    "col",
    "enclosing_def_id",
    "callee_name",
    "receiver_text",
    "producer",
  ],
  call_targets: ["site_id", "def_id", "label", "collision"],
  refs: [
    "id",
    "file_id",
    "line",
    "col",
    "enclosing_def_id",
    "def_id",
    "role",
    "producer",
  ],
  entry_points: [
    "file_id",
    "def_id",
    "kind",
    "manifest_file_id",
    "manifest_line",
    "name",
  ],
  file_metrics: [
    "file_id",
    "pagerank",
    "dependents_rank",
    "fan_in",
    "fan_out",
    "churn_90d",
    "hotspot",
    "cycle_id",
    "core",
    "last_change",
  ],
  def_metrics: [
    "def_id",
    "used_by_files",
    "used_by_files_bound",
    "mentioned_by_tests",
  ],
  cochange: ["file_id", "partner_file_id", "commits"],
  cycles: ["cycle_id", "ord", "file_id", "line"],
  rule_findings: [
    "id",
    "rule",
    "severity",
    "from_file_id",
    "to_file_id",
    "chain",
    "producer",
  ],
  timeline: ["week_start", "commits"],
  renames: ["old_path", "new_path", "commit_sha"],
  text_index: ["text", "file_id", "line"],
});

// The columns each table's dump is ordered and paged by: its primary key, in the order of its
// PRIMARY KEY clause, or rowid for meta and text_index, which have none.
export const ROW_KEY: Readonly<Record<ContentTable, readonly string[]>> =
  Object.freeze({
    meta: ["rowid"],
    components: ["id"],
    files: ["id"],
    sources: ["file_id"],
    definitions: ["id"],
    externals: ["id"],
    imports: ["id"],
    call_sites: ["id"],
    call_targets: ["site_id", "def_id"],
    refs: ["id"],
    entry_points: [
      "file_id",
      "kind",
      "manifest_file_id",
      "manifest_line",
      "name",
    ],
    file_metrics: ["file_id"],
    def_metrics: ["def_id"],
    cochange: ["file_id", "partner_file_id"],
    cycles: ["cycle_id", "ord"],
    rule_findings: ["id"],
    timeline: ["week_start"],
    renames: ["old_path", "new_path", "commit_sha"],
    text_index: ["rowid"],
  });

// A value as written to SQLite. node:sqlite binds every number as a REAL, so a safe integer goes
// in as a BigInt and is stored as an INTEGER, even where no column affinity converts it: FTS5's
// columns and rowid.
export const sqlValue = <T>(value: T): T | bigint =>
  typeof value === "number" && Number.isSafeInteger(value)
    ? BigInt(value)
    : value;
