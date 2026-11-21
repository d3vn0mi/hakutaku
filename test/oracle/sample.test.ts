// The observatory sample's store against fixtures/observatory/oracle.json, whose facts are
// written by hand from the sample's source, never from a store. The store must hold exactly
// what the oracle says: its files, entry points and import cycles; the imports and definitions
// of each file the oracle lists them for; the bound and scoped call sites and the references of
// each target it lists them for; and each denylisted, redacted and computed-import fact. The
// oracle's probes, its transitive and unscoped call facts and its untrusted facts are answers of
// the query tools, and are checked through those tools, not here. A failure lists, for each file
// or target, the facts the store lacks and the rows it holds beyond them.
//
// Run `node dist/cli/main.js engines install --yes` once first. The store is built with the
// Python the engines were installed with, since grimp must run: where that Python does not
// start, the tests that read the store are skipped, and in CI they fail.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { afterAll, expect, it } from "vitest";
import {
  type DefKind,
  type Ecosystem,
  type EntryKind,
  type FileKind,
  formatId,
  type ImportKind,
  type Lang,
  parseId,
  type RefRole,
} from "../../src/model/index.js";
import { openStore, type Store } from "../../src/store/index.js";
import {
  ERROR_CODES,
  type ErrorCode,
  TOOL_NAMES,
  type ToolName,
} from "../../src/tools/index.js";
import { git } from "../helpers/git.js";
import { requireInCI } from "../helpers/live.js";
import {
  samplePythonProbe,
  sampleRepo,
  sampleStore,
} from "../helpers/sample.js";

type Path = string; // repo-relative
type LocalId = string; // an ID without its "observatory:"
type CaseKind =
  | "function"
  | "method-bound"
  | "method-seam"
  | "method-collision"
  | "method-transitive"
  | "py-function"
  | "py-self-method"
  | "py-module-function"
  | "py-instance-method"
  | "ts-instance-method";

interface Oracle {
  version: 1;
  repo: "observatory";
  commit: string; // 40 hex
  detail: "standard";
  facts: OracleFact[];
}

type OracleFact =
  | {
      fact: "file";
      path: Path;
      kind: FileKind;
      lang: Lang | null;
      component: string | null; // the component's path without its trailing "/"
      entry: boolean;
    }
  | { fact: "absent"; path: Path }
  | { fact: "import"; from: Path; to: LocalId; kind: ImportKind; line: number }
  | {
      fact: "definition";
      id: LocalId;
      kind: DefKind;
      line: number;
      exported: boolean;
    }
  | {
      fact: "call";
      file: Path;
      line: number;
      caller: LocalId;
      target: LocalId;
      label: "bound" | "scoped" | "unscoped";
      collision: boolean;
      scope: "direct" | "transitive";
      case: CaseKind;
    }
  | {
      fact: "reference";
      file: Path;
      line: number;
      target: LocalId;
      role: RefRole;
    }
  | { fact: "entry"; file: Path; kind: EntryKind; manifest: Path; line: number }
  | { fact: "cycle"; files: Path[] }
  | { fact: "redacted"; file: Path; line: number; rule: string }
  | { fact: "computed-import"; file: Path; line: number }
  | { fact: "untrusted"; file: Path; line: number }
  | {
      fact: "probe";
      tool: ToolName;
      args: Record<string, unknown>;
      expect: { answer: object } | { error: ErrorCode };
    };

type FactKind = OracleFact["fact"];
type FactOf<K extends FactKind> = Extract<OracleFact, { fact: K }>;

const TIMEOUT = 300_000;
const PYTHON = samplePythonProbe();
const ORACLE: Oracle = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../fixtures/observatory/oracle.json", import.meta.url),
    ),
    "utf8",
  ),
);
const REPO = "observatory";

const factsOf = <K extends FactKind>(kind: K): FactOf<K>[] =>
  ORACLE.facts.filter((f): f is FactOf<K> => f.fact === kind);

// A store row's node as a local id, written as every ID is, so a path is escaped alike.
const localOf = (id: string): LocalId => id.slice(REPO.length + 1);
const fileLocal = (path: Path): LocalId =>
  localOf(formatId({ kind: "file", repo: REPO, path }));
const defLocal = (path: Path, qualname: string, ordinal: number): LocalId =>
  localOf(
    formatId({ kind: "definition", repo: REPO, path, qualname, ordinal }),
  );

// The node a local id names, or null when it names none.
const refOf = (local: unknown) =>
  typeof local === "string" ? parseId(`${REPO}:${local}`) : null;

let opened: Promise<Store> | undefined;

// The sample's standard store, built and opened once for this file.
function sample(): Promise<Store> {
  opened ??= sampleStore("standard").then((path) => {
    const store = openStore(path);
    if ("code" in store) throw new Error(`the sample store: ${store.reason}`);
    return store;
  });
  return opened;
}

afterAll(async () => {
  (await opened?.catch(() => undefined))?.close();
});

type Row = Record<string, unknown>;
const rows = (s: Store, sql: string, ...params: Array<string | number>) =>
  s.db.prepare(sql).all(...params) as Row[];

// Each store definition's local id, by row id.
function definitionIds(s: Store): Map<number, LocalId> {
  const ids = new Map<number, LocalId>();
  for (const r of rows(
    s,
    "SELECT d.id, f.path, d.qualname, d.ordinal FROM definitions AS d JOIN files AS f ON f.id = d.file_id",
  )) {
    ids.set(
      r.id as number,
      defLocal(r.path as string, r.qualname as string, r.ordinal as number),
    );
  }
  return ids;
}

// The store's row id of the definition a local id names, or null.
function definitionRow(s: Store, local: LocalId): number | null {
  const ref = refOf(local);
  if (ref?.kind !== "definition") return null;
  const found = rows(
    s,
    "SELECT d.id FROM definitions AS d JOIN files AS f ON f.id = d.file_id WHERE f.path = ? AND d.qualname = ? AND d.ordinal = ?",
    ref.path,
    ref.qualname,
    ref.ordinal,
  );
  return found.length === 1 ? (found[0]?.id as number) : null;
}

// A file's stored text, split into lines, or null when the store holds none.
function storedLines(s: Store, path: Path): string[] | null {
  const found = rows(
    s,
    "SELECT o.body FROM sources AS o JOIN files AS f ON f.id = o.file_id WHERE f.path = ?",
    path,
  );
  const body = found[0]?.body;
  return body instanceof Uint8Array
    ? inflateSync(body).toString("utf8").split("\n")
    : null;
}

// What `a` holds beyond `b`, counting repeats, in order.
function beyond(a: readonly string[], b: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const x of b) left.set(x, (left.get(x) ?? 0) + 1);
  const out: string[] = [];
  for (const x of a) {
    const n = left.get(x) ?? 0;
    if (n > 0) left.set(x, n - 1);
    else out.push(x);
  }
  return out.sort();
}

interface Difference {
  of: string;
  missing: string[]; // facts the store lacks
  extra: string[]; // rows the store holds beyond the facts
}

// The facts' tuples against the store's rows, each as its JSON text, counting repeats: null
// when they are the same.
function difference(
  of: string,
  facts: readonly unknown[][],
  stored: readonly unknown[][],
): Difference | null {
  const want = facts.map((t) => JSON.stringify(t));
  const got = stored.map((t) => JSON.stringify(t));
  const missing = beyond(want, got);
  const extra = beyond(got, want);
  return missing.length === 0 && extra.length === 0
    ? null
    : { of, missing, extra };
}

function groupBy<T>(items: readonly T[], key: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = groups.get(k);
    if (list === undefined) groups.set(k, [item]);
    else list.push(item);
  }
  return groups;
}

it(
  "is the oracle of the current sample",
  async (ctx) => {
    requireInCI(ctx, PYTHON);
    expect([ORACLE.version, ORACLE.repo, ORACLE.detail]).toEqual([
      1,
      "observatory",
      "standard",
    ]);
    expect(git(await sampleRepo(), "rev-parse", "HEAD")).toBe(ORACLE.commit);
    const s = await sample();
    expect([s.meta.repoId, s.meta.commit, s.meta.detail]).toEqual([
      ORACLE.repo,
      ORACLE.commit,
      ORACLE.detail,
    ]);
  },
  TIMEOUT,
);

it(
  "has exactly the file facts as files",
  async (ctx) => {
    requireInCI(ctx, PYTHON);
    const s = await sample();
    const stored = rows(
      s,
      "SELECT f.path, f.kind, f.lang, c.path AS component, f.entry FROM files AS f LEFT JOIN components AS c ON c.id = f.component_id",
    ).map((r) => [
      r.path,
      r.kind,
      r.lang,
      typeof r.component === "string" ? r.component.slice(0, -1) : null,
      r.entry === 1,
    ]);
    const facts = factsOf("file").map((f) => [
      f.path,
      f.kind,
      f.lang,
      f.component,
      f.entry,
    ]);
    expect(difference("files", facts, stored)).toBeNull();
  },
  TIMEOUT,
);

it(
  "has exactly the entry facts as entry points",
  async (ctx) => {
    requireInCI(ctx, PYTHON);
    const s = await sample();
    const stored = rows(
      s,
      "SELECT f.path AS file, e.kind, m.path AS manifest, e.manifest_line AS line FROM entry_points AS e JOIN files AS f ON f.id = e.file_id JOIN files AS m ON m.id = e.manifest_file_id",
    ).map((r) => [r.file, r.kind, r.manifest, r.line]);
    const facts = factsOf("entry").map((f) => [
      f.file,
      f.kind,
      f.manifest,
      f.line,
    ]);
    expect(difference("entry points", facts, stored)).toBeNull();
  },
  TIMEOUT,
);

it(
  "has exactly the cycle facts as cycles",
  async (ctx) => {
    requireInCI(ctx, PYTHON);
    const s = await sample();
    const chains = groupBy(
      rows(
        s,
        "SELECT c.cycle_id, f.path FROM cycles AS c JOIN files AS f ON f.id = c.file_id ORDER BY c.cycle_id, c.ord",
      ),
      (r) => String(r.cycle_id),
    );
    const stored = [...chains.values()].map((chain) => [
      chain.map((r) => r.path),
    ]);
    const facts = factsOf("cycle").map((f) => [f.files]);
    expect(difference("cycles", facts, stored)).toBeNull();
  },
  TIMEOUT,
);

it(
  "has, for each file with import facts, exactly those imports",
  async (ctx) => {
    requireInCI(ctx, PYTHON);
    const s = await sample();
    const differences: Difference[] = [];
    for (const [from, facts] of groupBy(factsOf("import"), (f) => f.from)) {
      const stored = rows(
        s,
        "SELECT d.path AS dst, x.ecosystem, x.name, i.kind, i.line FROM imports AS i JOIN files AS s ON s.id = i.src_file_id LEFT JOIN files AS d ON d.id = i.dst_file_id LEFT JOIN externals AS x ON x.id = i.dst_external_id WHERE s.path = ?",
        from,
      ).map((r) => [
        typeof r.dst === "string"
          ? fileLocal(r.dst)
          : typeof r.ecosystem === "string"
            ? localOf(
                formatId({
                  kind: "external",
                  repo: REPO,
                  ecosystem: r.ecosystem as Ecosystem,
                  name: r.name as string,
                }),
              )
            : null,
        r.kind,
        r.line,
      ]);
      const d = difference(
        from,
        facts.map((f) => [f.to, f.kind, f.line]),
        stored,
      );
      if (d !== null) differences.push(d);
    }
    expect(differences).toEqual([]);
  },
  TIMEOUT,
);

it(
  "has, for each file with definition facts, exactly those definitions besides <module>",
  async (ctx) => {
    requireInCI(ctx, PYTHON);
    const s = await sample();
    const differences: Difference[] = [];
    const byFile = groupBy(factsOf("definition"), (f) => {
      const ref = refOf(f.id);
      return ref?.kind === "definition"
        ? ref.path
        : `(not a definition) ${f.id}`;
    });
    for (const [path, facts] of byFile) {
      const stored = rows(
        s,
        "SELECT d.qualname, d.ordinal, d.kind, d.start_line, d.exported FROM definitions AS d JOIN files AS f ON f.id = d.file_id WHERE f.path = ? AND d.kind <> 'module'",
        path,
      ).map((r) => [
        defLocal(path, r.qualname as string, r.ordinal as number),
        r.kind,
        r.start_line,
        r.exported === 1,
      ]);
      const d = difference(
        path,
        facts.map((f) => [f.id, f.kind, f.line, f.exported]),
        stored,
      );
      if (d !== null) differences.push(d);
    }
    expect(differences).toEqual([]);
  },
  TIMEOUT,
);

it(
  "has, for each target with direct bound or scoped call facts, exactly those sites",
  async (ctx) => {
    requireInCI(ctx, PYTHON);
    const s = await sample();
    const ids = definitionIds(s);
    const checked = factsOf("call").filter(
      (f) => f.scope === "direct" && f.label !== "unscoped",
    );
    const differences: Difference[] = [];
    for (const [target, facts] of groupBy(checked, (f) => f.target)) {
      const def = definitionRow(s, target);
      // the caller is the site's enclosing definition, which the facts name too
      const stored =
        def === null
          ? []
          : rows(
              s,
              "SELECT f.path AS file, s.line, s.enclosing_def_id, t.label, t.collision FROM call_targets AS t JOIN call_sites AS s ON s.id = t.site_id JOIN files AS f ON f.id = s.file_id WHERE t.def_id = ?",
              def,
            ).map((r) => [
              r.file,
              r.line,
              ids.get(r.enclosing_def_id as number),
              r.label,
              r.collision === 1,
            ]);
      const d = difference(
        def === null ? `${target} (no such definition in the store)` : target,
        facts.map((f) => [f.file, f.line, f.caller, f.label, f.collision]),
        stored,
      );
      if (d !== null) differences.push(d);
    }
    expect(differences).toEqual([]);
  },
  TIMEOUT,
);

it(
  "has, for each target with reference facts, exactly those references",
  async (ctx) => {
    requireInCI(ctx, PYTHON);
    const s = await sample();
    const differences: Difference[] = [];
    for (const [target, facts] of groupBy(
      factsOf("reference"),
      (f) => f.target,
    )) {
      const def = definitionRow(s, target);
      const stored =
        def === null
          ? []
          : rows(
              s,
              "SELECT f.path AS file, r.line, r.role FROM refs AS r JOIN files AS f ON f.id = r.file_id WHERE r.def_id = ?",
              def,
            ).map((r) => [r.file, r.line, r.role]);
      const d = difference(
        def === null ? `${target} (no such definition in the store)` : target,
        facts.map((f) => [f.file, f.line, f.role]),
        stored,
      );
      if (d !== null) differences.push(d);
    }
    expect(differences).toEqual([]);
  },
  TIMEOUT,
);

// The marker redaction leaves in a stored line, built from code points so that this file
// stays ASCII.
const marker = (rule: string): string =>
  `${String.fromCodePoint(0xab)}redacted:${rule}${String.fromCodePoint(0xbb)}`;

it(
  "holds every absent, redacted and computed-import fact",
  async (ctx) => {
    requireInCI(ctx, PYTHON);
    const s = await sample();
    const problems: string[] = [];
    const isFile = (path: Path) =>
      rows(s, "SELECT 1 FROM files WHERE path = ?", path).length > 0;
    for (const f of factsOf("absent")) {
      if (isFile(f.path)) problems.push(`${JSON.stringify(f)}: in the store`);
    }
    for (const f of factsOf("redacted")) {
      const line = storedLines(s, f.file)?.[f.line - 1];
      if (line === undefined || !line.includes(marker(f.rule))) {
        problems.push(`${JSON.stringify(f)}: the stored line is ${line}`);
      }
    }
    // The store keeps no row for an import() with a computed specifier, only their count:
    // each fact's line holds one, and no import row of its file is on that line.
    const computed = factsOf("computed-import");
    for (const f of computed) {
      const line = storedLines(s, f.file)?.[f.line - 1];
      if (line === undefined || !line.includes("import(")) {
        problems.push(`${JSON.stringify(f)}: the stored line is ${line}`);
      }
      const onLine = rows(
        s,
        "SELECT i.specifier FROM imports AS i JOIN files AS f ON f.id = i.src_file_id WHERE f.path = ? AND i.line = ?",
        f.file,
        f.line,
      );
      if (onLine.length > 0) {
        problems.push(`${JSON.stringify(f)}: an import row is on its line`);
      }
    }
    if (s.meta.coverage.computedImports !== computed.length) {
      problems.push(
        `the store counts ${s.meta.coverage.computedImports} computed imports, the oracle ${computed.length}`,
      );
    }
    expect(problems).toEqual([]);
  },
  TIMEOUT,
);

// Closed sets, written as records so that the compiler checks each holds its type's members.
const members = <T extends string>(set: Record<T, true>): string[] =>
  Object.keys(set);
const CASE_KINDS = members<CaseKind>({
  function: true,
  "method-bound": true,
  "method-seam": true,
  "method-collision": true,
  "method-transitive": true,
  "py-function": true,
  "py-self-method": true,
  "py-module-function": true,
  "py-instance-method": true,
  "ts-instance-method": true,
});
const FILE_KINDS = members<FileKind>({
  code: true,
  test: true,
  "test-support": true,
  config: true,
  doc: true,
  other: true,
});
const IMPORT_KINDS = members<ImportKind>({
  static: true,
  dynamic: true,
  "type-only": true,
  "re-export": true,
  require: true,
  "side-effect": true,
  source: true,
  exec: true,
});
const DEF_KINDS = members<DefKind>({
  function: true,
  class: true,
  method: true,
  constant: true,
  type: true,
});
const ROLES = members<RefRole>({
  read: true,
  write: true,
  type: true,
  import: true,
  other: true,
});
const ENTRY_KINDS = members<EntryKind>({
  bin: true,
  script: true,
  "dev-script": true,
  unit: true,
  "console-script": true,
  container: true,
  procfile: true,
  ci: true,
  plugin: true,
  executable: true,
  "main-guard": true,
  route: true,
});

type Check = (v: unknown) => boolean;
const oneOf =
  (values: readonly string[]): Check =>
  (v) =>
    typeof v === "string" && values.includes(v);
const isLine: Check = (v) => Number.isSafeInteger(v) && (v as number) >= 1;
const isBoolean: Check = (v) => typeof v === "boolean";
const isObject: Check = (v) =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isPath: Check = (v) => {
  const ref = refOf(typeof v === "string" ? fileLocal(v) : null);
  return ref?.kind === "file" && ref.path === v;
};
const isDefinition: Check = (v) => refOf(v)?.kind === "definition";
const isImported: Check = (v) => {
  const kind = refOf(v)?.kind;
  return kind === "file" || kind === "external";
};
const isExpect: Check = (v) => {
  if (!isObject(v)) return false;
  const e = v as Record<string, unknown>;
  const keys = Object.keys(e);
  return keys.length === 1 && keys[0] === "answer"
    ? isObject(e.answer)
    : keys.length === 1 && keys[0] === "error"
      ? oneOf(ERROR_CODES)(e.error)
      : false;
};

// Each kind's fields besides "fact", each with its check.
const FIELDS: {
  [K in FactKind]: Record<Exclude<keyof FactOf<K>, "fact">, Check>;
} = {
  file: {
    path: isPath,
    kind: oneOf(FILE_KINDS),
    lang: (v) => v === null || typeof v === "string",
    component: (v) => v === null || (typeof v === "string" && !v.endsWith("/")),
    entry: isBoolean,
  },
  absent: { path: isPath },
  import: {
    from: isPath,
    to: isImported,
    kind: oneOf(IMPORT_KINDS),
    line: isLine,
  },
  definition: {
    id: isDefinition,
    kind: oneOf(DEF_KINDS),
    line: isLine,
    exported: isBoolean,
  },
  call: {
    file: isPath,
    line: isLine,
    caller: isDefinition,
    target: isDefinition,
    label: oneOf(["bound", "scoped", "unscoped"]),
    collision: isBoolean,
    scope: oneOf(["direct", "transitive"]),
    case: oneOf(CASE_KINDS),
  },
  reference: {
    file: isPath,
    line: isLine,
    target: isDefinition,
    role: oneOf(ROLES),
  },
  entry: {
    file: isPath,
    kind: oneOf(ENTRY_KINDS),
    manifest: isPath,
    line: isLine,
  },
  cycle: {
    files: (v) => Array.isArray(v) && v.length > 0 && v.every(isPath),
  },
  redacted: {
    file: isPath,
    line: isLine,
    rule: (v) => typeof v === "string" && v !== "",
  },
  "computed-import": { file: isPath, line: isLine },
  untrusted: { file: isPath, line: isLine },
  probe: { tool: oneOf(TOOL_NAMES), args: isObject, expect: isExpect },
};

it("holds only well-formed facts", () => {
  const problems: string[] = [];
  for (const fact of ORACLE.facts as unknown as Record<string, unknown>[]) {
    const text = JSON.stringify(fact);
    const fields: Record<string, Check> | undefined = Object.hasOwn(
      FIELDS,
      String(fact.fact),
    )
      ? FIELDS[fact.fact as FactKind]
      : undefined;
    if (fields === undefined) {
      problems.push(`${text}: no such kind of fact`);
      continue;
    }
    const keys = Object.keys(fact)
      .filter((k) => k !== "fact")
      .sort();
    const wanted = Object.keys(fields).sort();
    if (JSON.stringify(keys) !== JSON.stringify(wanted)) {
      problems.push(`${text}: has the fields ${keys}, not ${wanted}`);
      continue;
    }
    for (const [key, check] of Object.entries(fields)) {
      if (!check(fact[key])) problems.push(`${text}: ${key} is not valid`);
    }
  }
  expect(problems).toEqual([]);
});

it("holds a call fact of every case kind, transitive and unscoped call facts, an untrusted fact, and the refusal and question probes", () => {
  const calls = factsOf("call");
  expect([...new Set(calls.map((f) => f.case))].sort()).toEqual(
    [...CASE_KINDS].sort(),
  );
  expect(
    calls.filter((f) => f.scope === "transitive" && f.label === "scoped")
      .length,
  ).toBeGreaterThan(0);
  expect(calls.filter((f) => f.label === "unscoped").length).toBeGreaterThan(0);
  expect(factsOf("untrusted").length).toBeGreaterThan(0);
  const probes = factsOf("probe").map((f) =>
    "error" in f.expect ? `error ${f.expect.error}` : `answer ${f.tool}`,
  );
  expect(probes.sort()).toEqual([
    "answer code_callers",
    "answer code_explain",
    "answer code_path",
    "error ambiguous",
    "error not_found",
    "error unknown_repo",
  ]);
});
