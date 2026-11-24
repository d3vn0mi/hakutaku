// openStore: a store opened read-only, with its meta and run read, or the reason it cannot serve.
// No reason names a path, and openStore never throws. Also the shape checks that hakutaku's
// readers of its own JSON use.
import { lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type {
  Detail,
  EngineName,
  Severity,
  ShadowedModule,
} from "../model/index.js";
import { SCHEMA_VERSION, TABLE_COLUMNS } from "./schema.js";
import type {
  Coverage,
  GateResult,
  NotBuilt,
  Store,
  StoreMeta,
} from "./types.js";

// A check that a value read from JSON or SQLite has a type's shape. Keys the type does not
// declare are let through.
export type Guard<T> = (value: unknown) => value is T;

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const isString: Guard<string> = (v): v is string =>
  typeof v === "string";

export const isNumber: Guard<number> = (v): v is number =>
  typeof v === "number" && Number.isFinite(v);

const isBoolean: Guard<boolean> = (v): v is boolean => typeof v === "boolean";

export const orNull =
  <T>(guard: Guard<T>): Guard<T | null> =>
  (v): v is T | null =>
    v === null || guard(v);

export const optional =
  <T>(guard: Guard<T>): Guard<T | undefined> =>
  (v): v is T | undefined =>
    v === undefined || guard(v);

// One of a closed set of strings. The set is written as a record, so the compiler checks that
// it holds every member of T and nothing else.
export const oneOf =
  <T extends string>(members: Record<T, true>): Guard<T> =>
  (v): v is T =>
    typeof v === "string" && Object.hasOwn(members, v);

export const arrayOf =
  <T>(item: Guard<T>): Guard<T[]> =>
  (v): v is T[] =>
    Array.isArray(v) && v.every(item);

// A map keyed by data.
const mapOf =
  <V>(value: Guard<V>): Guard<Record<string, V>> =>
  (v): v is Record<string, V> =>
    isRecord(v) && Object.values(v).every(value);

const isEngineName = oneOf<EngineName>({
  "scip-typescript": true,
  "dependency-cruiser": true,
  grimp: true,
  "ast-grep": true,
  "scip-python": true,
});

export const engineMapOf =
  <V>(value: Guard<V>): Guard<Partial<Record<EngineName, V>>> =>
  (v): v is Partial<Record<EngineName, V>> =>
    isRecord(v) &&
    Object.entries(v).every(([key, x]) => isEngineName(key) && value(x));

// An object with each of T's keys, checked by its guard; an absent key is checked as undefined.
export const shape =
  <T extends object>(fields: { [K in keyof T]-?: Guard<T[K]> }): Guard<T> =>
  (v): v is T =>
    isRecord(v) &&
    Object.entries<Guard<unknown>>(fields).every(([key, guard]) =>
      guard(Object.hasOwn(v, key) ? v[key] : undefined),
    );

type Tier = NonNullable<Coverage["tiers"][EngineName]>;

const isCoverage = shape<Coverage>({
  files: isNumber,
  indexed: mapOf(isNumber),
  unresolvedImports: isNumber,
  callSites: shape<Coverage["callSites"]>({
    bound: isNumber,
    scoped: isNumber,
    unresolved: isNumber,
  }),
  redactions: isNumber,
  tiers: engineMapOf(
    oneOf<Tier>({ ran: true, skipped: true, failed: true, fallback: true }),
  ),
  pythonResolver: oneOf<Coverage["pythonResolver"]>({
    grimp: true,
    "hakutaku-resolver": true,
    none: true,
  }),
  computedImports: isNumber,
  unmatchedScipDefinitions: isNumber,
  unmatchedBoundUses: isNumber,
  cycleDifferences: isNumber,
  noSourceFiles: isNumber,
  denied: isNumber,
  cycleSeverity: oneOf<Severity>({ error: true, warn: true, info: true }),
  outOfMemory: optional(
    shape<NonNullable<Coverage["outOfMemory"]>>({
      memoryMax: isString,
      tiers: engineMapOf(isString),
    }),
  ),
  shadowedPython: optional(
    arrayOf(
      shape<ShadowedModule>({
        path: isString,
        name: isString,
        heldBy: isString,
        by: oneOf<ShadowedModule["by"]>({ root: true, package: true }),
      }),
    ),
  ),
});

const isGateResult = shape<GateResult>({
  gate: oneOf<GateResult["gate"]>({
    "files-indexed": true,
    "unresolved-imports": true,
    "scip-duplicates": true,
    denylist: true,
    redaction: true,
  }),
  ok: isBoolean,
  detail: isString,
});

const isStoreMeta = shape<StoreMeta>({
  schemaVersion: isNumber,
  hakutakuVersion: isString,
  repoId: isString,
  commit: isString,
  commitTime: isNumber,
  detail: oneOf<Detail>({ quick: true, standard: true, deep: true }),
  noSource: isBoolean,
  engines: mapOf(isString),
  engineLockHash: isString,
  profileHash: isString,
  rulesHash: isString,
  coverage: isCoverage,
  gates: arrayOf(isGateResult),
});

const isRun = shape<Store["run"]>({
  ref: isString,
  contentHash: isString,
  builtAt: isString,
});

const NOT_BUILT_YET = "not built yet";
const UNREADABLE = "store unreadable";
const NOT_A_STORE = "not an hakutaku store";

const notBuilt = (reason: string): NotBuilt => ({ code: "not_built", reason });

export function openStore(path: string): Store | NotBuilt {
  // A FIFO or a directory is never opened: SQLite would block on the one and fail on the other.
  // Nor is a link: only a build puts a store in place, by a rename, never as a link.
  try {
    if (!lstatSync(path).isFile()) return notBuilt(UNREADABLE);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return notBuilt(
      code === "ENOENT" || code === "ENOTDIR" ? NOT_BUILT_YET : UNREADABLE,
    );
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    return notBuilt(UNREADABLE);
  }
  const head = readHead(db);
  if ("code" in head) {
    db.close();
    return head;
  }
  let open = true;
  return {
    path,
    db,
    meta: head.meta,
    run: head.run,
    close() {
      if (!open) return;
      open = false;
      db.close();
    },
  };
}

function readHead(
  db: DatabaseSync,
): { meta: StoreMeta; run: Store["run"] } | NotBuilt {
  // The first read of the file: a file that is not SQLite fails here, before meta is looked for.
  try {
    db.prepare("SELECT name FROM sqlite_master").all();
  } catch {
    return notBuilt(UNREADABLE);
  }
  try {
    // schema_version alone first, so that a newer store is named as one whatever the rest of
    // its meta holds, and whether or not it has run.
    const versions = db.prepare("SELECT schema_version FROM meta").all();
    const version =
      versions.length === 1 ? versions[0]?.schema_version : undefined;
    if (!Number.isSafeInteger(version) || Number(version) < 1) {
      return notBuilt(NOT_A_STORE);
    }
    if (Number(version) > SCHEMA_VERSION) {
      return notBuilt(
        `store schema ${version} is newer than this hakutaku's schema ${SCHEMA_VERSION}`,
      );
    }
    const metas = db
      .prepare(`SELECT ${TABLE_COLUMNS.meta.join(", ")} FROM meta`)
      .all();
    const runs = db
      .prepare(`SELECT ${TABLE_COLUMNS.run.join(", ")} FROM run`)
      .all();
    const meta = metas.length === 1 ? metaOf(metas[0] ?? {}) : undefined;
    const run = runs.length === 1 ? runOf(runs[0] ?? {}) : undefined;
    if (meta === undefined || run === undefined) return notBuilt(NOT_A_STORE);
    return { meta, run };
  } catch {
    // a table or a column of schema 1 is missing
    return notBuilt(NOT_A_STORE);
  }
}

function metaOf(row: Readonly<Record<string, unknown>>): StoreMeta | undefined {
  const meta: Record<keyof StoreMeta, unknown> = {
    schemaVersion: row.schema_version,
    hakutakuVersion: row.hakutaku_version,
    repoId: row.repo_id,
    commit: row.commit_sha,
    commitTime: row.commit_time,
    detail: row.detail,
    noSource: row.no_source === 1 ? true : row.no_source === 0 ? false : null,
    engines: jsonOf(row.engines),
    engineLockHash: row.engine_lock_hash,
    profileHash: row.profile_hash,
    rulesHash: row.rules_hash,
    coverage: jsonOf(row.coverage),
    gates: jsonOf(row.gates),
  };
  return isStoreMeta(meta) ? meta : undefined;
}

function runOf(
  row: Readonly<Record<string, unknown>>,
): Store["run"] | undefined {
  const run = {
    ref: row.ref,
    contentHash: row.content_hash,
    builtAt: row.built_at,
  };
  return isRun(run) ? run : undefined;
}

// A JSON column's value, or undefined when it is not JSON text.
function jsonOf(cell: unknown): unknown {
  if (typeof cell !== "string") return undefined;
  try {
    return JSON.parse(cell);
  } catch {
    return undefined;
  }
}
