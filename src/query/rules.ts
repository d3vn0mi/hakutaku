// code_rules: the repo's import cycles and declared rule violations, as one list of findings
// (docs/tools.md). A cycle finding is one strongly connected set of files, with the shortest
// chain of imports that closes it; a violation is an import a rule forbids, with the chain of
// imports that breaks the rule. The list goes by severity, then cycles before violations, then
// id; violations that tie go by rule, then to.
import { comparePaths, formatId, type Severity } from "../model/index.js";
import type { Store } from "../store/index.js";
import type { Checked, RulesAnswer } from "../tools/types.js";
import { ok, type QueryCtx, type QueryOut } from "./ctx.js";
import { type FileInfo, type StoreIndex, storeIndex } from "./store-index.js";

type Finding = RulesAnswer["findings"][number];
type ChainStep = Finding["chain"][number];

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = Object.freeze({
  error: 0,
  warn: 1,
  info: 2,
});
const KIND_ORDER: Readonly<Record<Finding["kind"], number>> = Object.freeze({
  cycle: 0,
  violation: 1,
});

// The columns each SELECT reads, with the types the store's writer guarantees.
interface CycleRow {
  cycle_id: number;
  file_id: number;
  line: number; // the line in this file that imports the next one
}
interface RuleRow {
  id: number;
  rule: string;
  severity: Severity;
  from_file_id: number;
  to_file_id: number;
  chain: string; // JSON: [{ from, to, line }] of repo paths
}

const CYCLES_SQL =
  "SELECT cycle_id, file_id, line FROM cycles ORDER BY cycle_id, ord";
const RULES_SQL =
  "SELECT id, rule, severity, from_file_id, to_file_id, chain FROM rule_findings ORDER BY id";

// A finding, and the row it came from: a violation's rule_findings id breaks the last tie.
interface Ranked {
  finding: Finding;
  row: number;
}

// The severity the rules file gives cycles; "warn" when it gives none.
export function cycleSeverityOf(store: Store): Severity {
  return store.meta.coverage.cycleSeverity ?? "warn";
}

export function queryRules(
  store: Store,
  _args: Checked<"code_rules">,
  q: QueryCtx,
): QueryOut<RulesAnswer> {
  const ix = storeIndex(store);
  const ranked = [...cycleFindings(store, ix), ...violationFindings(store, ix)];
  ranked.sort(
    ({ finding: a, row: ra }, { finding: b, row: rb }) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      comparePaths(a.id, b.id) ||
      comparePaths(a.rule ?? "", b.rule ?? "") ||
      comparePaths(a.to ?? "", b.to ?? "") ||
      ra - rb,
  );
  return ok({
    builtCommit: q.builtCommit,
    stale: q.stale,
    findings: ranked.map(({ finding }) => finding),
  });
}

// One finding per stored cycle. Its files are the strongly connected set, every file the
// metrics place in the cycle, in path order; its chain runs from each stored file to the next,
// and from the last back to the first.
function cycleFindings(store: Store, ix: StoreIndex): Ranked[] {
  const severity = cycleSeverityOf(store);
  const members = new Map<number, FileInfo[]>();
  for (const file of ix.files.values()) {
    if (file.cycleId !== null) push(members, file.cycleId, file);
  }
  const chains = new Map<number, CycleRow[]>();
  const rows = store.db.prepare(CYCLES_SQL).all() as unknown as CycleRow[];
  for (const row of rows) push(chains, row.cycle_id, row);
  const out: Ranked[] = [];
  for (const [cycleId, chain] of chains) {
    // the chain's files belong to the set; a store whose metrics left one out still lists it
    const set = new Map<number, FileInfo>();
    for (const file of members.get(cycleId) ?? []) set.set(file.id, file);
    for (const row of chain) set.set(row.file_id, fileAt(ix, row.file_id));
    const files = [...set.values()]
      .sort((a, b) => comparePaths(a.path, b.path))
      .map((file) => ix.idOfFile(file.id));
    out.push({
      finding: {
        kind: "cycle",
        id: files[0],
        severity,
        files,
        chain: chain.map(
          (row, k): ChainStep => ({
            from: ix.idOfFile(row.file_id),
            to: ix.idOfFile(chain[(k + 1) % chain.length].file_id),
            line: row.line,
          }),
        ),
      },
      row: 0,
    });
  }
  return out;
}

// One finding per stored rule finding, its chain's repo paths written as file IDs.
function violationFindings(store: Store, ix: StoreIndex): Ranked[] {
  const idOfPath = (path: string) =>
    formatId({ kind: "file", repo: ix.repo, path });
  const rows = store.db.prepare(RULES_SQL).all() as unknown as RuleRow[];
  return rows.map((row) => {
    const from = ix.idOfFile(row.from_file_id);
    const chain = JSON.parse(row.chain) as ChainStep[];
    return {
      finding: {
        kind: "violation",
        id: from,
        severity: row.severity,
        rule: row.rule,
        from,
        to: ix.idOfFile(row.to_file_id),
        chain: chain.map(
          (step): ChainStep => ({
            from: idOfPath(step.from),
            to: idOfPath(step.to),
            line: step.line,
          }),
        ),
      },
      row: row.id,
    };
  });
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function fileAt(ix: StoreIndex, fileId: number): FileInfo {
  const file = ix.files.get(fileId);
  if (file === undefined)
    throw new RangeError(`the store has no file ${fileId}`);
  return file;
}
