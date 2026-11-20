// Call links: who calls a definition, what a definition calls, and who uses it otherwise. The
// store keeps the bound and scoped links its engines found. The transitive scoped links and the
// unscoped name matches are derived here, at query time, from the call sites and the imports
// (docs/tools.md).
import type { StatementSync } from "node:sqlite";
import type { RefRole } from "../model/index.js";
import type { Store } from "../store/index.js";
import { type DefInfo, type StoreIndex, storeIndex } from "./store-index.js";

export type LinkLabel = "bound" | "scoped" | "unscoped" | "reference";

// How strong each label is: a compiler binding, a compiler-resolved use, a name match in a file
// that imports the definition, then a bare name match.
const STRENGTH: Readonly<Record<LinkLabel, number>> = Object.freeze({
  bound: 4,
  reference: 3,
  scoped: 2,
  unscoped: 1,
});

export function weakest(a: LinkLabel, b: LinkLabel): LinkLabel {
  return STRENGTH[b] < STRENGTH[a] ? b : a;
}

export function strongest(a: LinkLabel, b: LinkLabel): LinkLabel {
  return STRENGTH[b] > STRENGTH[a] ? b : a;
}

// One call site linked to one definition. collision: a scoped site whose file sees two or more
// definitions with the name.
export interface CallLink {
  siteId: number;
  fileId: number;
  line: number;
  col: number;
  callerDefId: number; // the site's enclosing definition, perhaps a <module> row
  calleeDefId: number;
  label: "bound" | "scoped" | "unscoped";
  collision: boolean;
}

export interface RefLink {
  refId: number;
  fileId: number;
  line: number;
  col: number;
  callerDefId: number; // the use's enclosing definition, perhaps a <module> row
  role: RefRole;
}

// The columns each SELECT reads, with the types the store's writer guarantees.
interface StoredRow {
  site_id: number;
  file_id: number;
  line: number;
  col: number;
  enclosing_def_id: number;
  def_id: number;
  label: "bound" | "scoped";
  collision: number;
}
interface NamedRow {
  site_id: number;
  file_id: number;
  line: number;
  col: number;
  enclosing_def_id: number;
  bound_elsewhere: number;
}
interface RefRow {
  id: number;
  file_id: number;
  line: number;
  col: number;
  enclosing_def_id: number;
  role: RefRole;
}

interface Statements {
  stored: StatementSync; // the stored links to a definition
  named: StatementSync; // the sites calling a name, and whether another definition is bound there
  refs: StatementSync; // the uses of a definition
}

const SITE_COLUMNS =
  "s.id AS site_id, s.file_id, s.line, s.col, s.enclosing_def_id";

const STORED_SQL = `SELECT ${SITE_COLUMNS}, t.def_id, t.label, t.collision FROM call_targets AS t JOIN call_sites AS s ON s.id = t.site_id WHERE t.def_id = ?`;
const NAMED_SQL = `SELECT ${SITE_COLUMNS}, EXISTS (SELECT 1 FROM call_targets AS t WHERE t.site_id = s.id AND t.label = 'bound' AND t.def_id <> ?) AS bound_elsewhere FROM call_sites AS s WHERE s.callee_name = ?`;
const REFS_SQL =
  "SELECT id, file_id, line, col, enclosing_def_id, role FROM refs WHERE def_id = ? ORDER BY id";
const ALL_STORED_SQL = `SELECT ${SITE_COLUMNS}, t.def_id, t.label, t.collision FROM call_targets AS t JOIN call_sites AS s ON s.id = t.site_id ORDER BY s.id, t.def_id`;

const STATEMENTS = new WeakMap<Store, Statements>();
const CALLEES = new WeakMap<Store, ReadonlyMap<number, readonly CallLink[]>>();

function statementsOf(store: Store): Statements {
  let statements = STATEMENTS.get(store);
  if (statements === undefined) {
    statements = {
      stored: store.db.prepare(STORED_SQL),
      named: store.db.prepare(NAMED_SQL),
      refs: store.db.prepare(REFS_SQL),
    };
    STATEMENTS.set(store, statements);
  }
  return statements;
}

// The links into defId, by file path, line and col: its stored links; with scope transitive,
// a scoped link for each site calling its name from a file that reaches its file through any
// chain of imports; with unscoped, an unscoped link for each other site calling its name. A
// derived link is never made for a site already linked to defId, nor for one bound to another
// definition. Sites inside defId itself are left out.
export function callersOf(
  store: Store,
  defId: number,
  opts: { unscoped: boolean; scope: "direct" | "transitive" },
): CallLink[] {
  const ix = storeIndex(store);
  const def = defAt(ix, defId);
  const statements = statementsOf(store);
  const links: CallLink[] = [];
  const linked = new Set<number>();
  for (const row of statements.stored.all(defId) as unknown as StoredRow[]) {
    linked.add(row.site_id);
    if (row.enclosing_def_id === defId) continue;
    links.push(linkOf(row, defId, row.label, row.collision !== 0));
  }
  const transitive = opts.scope === "transitive";
  if (transitive || opts.unscoped) {
    let reach: ReadonlySet<number> | undefined;
    let sees: ReadonlyMap<number, number> | undefined;
    const named = statements.named.all(
      defId,
      def.name,
    ) as unknown as NamedRow[];
    for (const row of named) {
      if (linked.has(row.site_id) || row.bound_elsewhere !== 0) continue;
      if (row.enclosing_def_id === defId) continue;
      if (transitive && row.file_id !== def.fileId) {
        reach ??= reachersOf(ix, def.fileId);
        if (reach.has(row.file_id)) {
          sees ??= sightings(ix, def.name);
          const collision = (sees.get(row.file_id) ?? 0) >= 2;
          links.push(linkOf(row, defId, "scoped", collision));
          continue;
        }
      }
      if (opts.unscoped) links.push(linkOf(row, defId, "unscoped", false));
    }
  }
  // site ids follow (file path, line, col), the order the store's writer asserts
  return links.sort((a, b) => a.siteId - b.siteId);
}

// The stored bound and scoped links out of defId: those of the sites it encloses, by line and
// col, then by the callee's row. Read once per Store, with one SELECT.
export function calleesOf(store: Store, defId: number): CallLink[] {
  let byCaller = CALLEES.get(store);
  if (byCaller === undefined) {
    const map = new Map<number, CallLink[]>();
    const rows = store.db
      .prepare(ALL_STORED_SQL)
      .all() as unknown as StoredRow[];
    for (const row of rows) {
      const link = linkOf(row, row.def_id, row.label, row.collision !== 0);
      const list = map.get(link.callerDefId);
      if (list === undefined) map.set(link.callerDefId, [link]);
      else list.push(link);
    }
    byCaller = map;
    CALLEES.set(store, byCaller);
  }
  return [...(byCaller.get(defId) ?? [])];
}

// The uses of defId that are not calls: its refs rows, in the store's row order (file path, line,
// col).
export function referrersOf(store: Store, defId: number): RefLink[] {
  const rows = statementsOf(store).refs.all(defId) as unknown as RefRow[];
  return rows.map((row) => ({
    refId: row.id,
    fileId: row.file_id,
    line: row.line,
    col: row.col,
    callerDefId: row.enclosing_def_id,
    role: row.role,
  }));
}

function linkOf(
  row: Omit<StoredRow, "def_id" | "label" | "collision">,
  calleeDefId: number,
  label: CallLink["label"],
  collision: boolean,
): CallLink {
  return {
    siteId: row.site_id,
    fileId: row.file_id,
    line: row.line,
    col: row.col,
    callerDefId: row.enclosing_def_id,
    calleeDefId,
    label,
    collision,
  };
}

// The files that reach fileId through any chain of imports, fileId included.
function reachersOf(ix: StoreIndex, fileId: number): Set<number> {
  const seen = new Set([fileId]);
  const queue = [fileId];
  for (let i = 0; i < queue.length; i++) {
    for (const edge of ix.importsIn.get(queue[i]) ?? []) {
      if (seen.has(edge.src)) continue;
      seen.add(edge.src);
      queue.push(edge.src);
    }
  }
  return seen;
}

// For each file, how many definitions named name it sees: those it defines, and those defined
// in the files it reaches through imports. A file that sees none is not listed.
function sightings(ix: StoreIndex, name: string): Map<number, number> {
  const defined = new Map<number, number>();
  for (const def of ix.defsByName.get(name) ?? []) {
    defined.set(def.fileId, (defined.get(def.fileId) ?? 0) + 1);
  }
  const sees = new Map<number, number>();
  for (const [fileId, n] of defined) {
    for (const viewer of reachersOf(ix, fileId)) {
      sees.set(viewer, (sees.get(viewer) ?? 0) + n);
    }
  }
  return sees;
}

function defAt(ix: StoreIndex, defId: number): DefInfo {
  const def = ix.defs.get(defId);
  if (def === undefined) {
    throw new RangeError(`the store has no definition ${defId}`);
  }
  return def;
}
