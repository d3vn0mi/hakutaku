// Target resolution: a model's target read as exactly one node of the store, by string equality
// over the store. A target is an ID, path#name, a repo-relative path or a bare name; near misses
// and renames are only ever offered as candidates. Nothing a model passes is opened.
import { splitName } from "../model/ids.js";
import {
  comparePaths,
  type DefKind,
  MODULE_QUALNAME,
  type NodeRef,
  parseId,
  type RepoId,
} from "../model/index.js";
import { isDenied } from "../redact/denylist.js";
import type { Store } from "../store/index.js";
import {
  type Candidate,
  echo,
  type ToolError,
  toolError,
} from "../tools/errors.js";
import { MAX_CANDIDATES } from "../tools/limits.js";
import type { ToolName } from "../tools/types.js";
import { MATCH_LEVELS, matchLevel } from "./match.js";
import {
  type DefInfo,
  type FileInfo,
  type StoreIndex,
  storeIndex,
} from "./store-index.js";

export type Resolved =
  | { kind: "repo"; ref: NodeRef }
  | { kind: "directory"; componentId: number; ref: NodeRef }
  | { kind: "file"; fileId: number; ref: NodeRef }
  | { kind: "definition"; defId: number; fileId: number; ref: NodeRef }
  | { kind: "external"; externalId: number; ref: NodeRef };

// What a refusal calls each kind of node.
export const KIND_NAME: Readonly<Record<Resolved["kind"], string>> =
  Object.freeze({
    repo: "repo",
    directory: "component",
    file: "file",
    definition: "definition",
    external: "library",
  });

// The refusal of a target of a kind the tool does not take.
export function wrongKind(
  field: string,
  got: Resolved,
  tool: ToolName,
  takes: string,
  hint: string,
): ToolError {
  return toolError(
    "invalid_argument",
    `${field} is a ${KIND_NAME[got.kind]}; ${tool} takes ${takes}`,
    { field, hint },
  );
}

// The most renames followed, one after another, from a path that is not stored.
const MAX_RENAME_STEPS = 10;

const COMPONENT_HINT = "code_overview lists the components";
const EXTERNAL_HINT =
  "code_deps with direction out lists a file's imports and their IDs";
const NAME_HINT = "code_find searches by name";

interface Ask {
  store: Store;
  ix: StoreIndex;
  repo: RepoId;
  target: string;
  field: string;
}

// A node offered as a candidate: a file, or a definition (never a module row) in that file.
interface Hit {
  level: number; // its place in MATCH_LEVELS; 0 where no level applies
  file: FileInfo;
  def: (DefInfo & { kind: DefKind }) | null;
}

// The first rule that applies decides: an ID, path#name, a path, then a bare name.
export function resolveTarget(
  store: Store,
  repo: RepoId,
  target: string,
  field: string,
): Resolved | ToolError {
  const ask: Ask = { store, ix: storeIndex(store), repo, target, field };
  if (target.includes(":")) {
    const ref = parseId(target);
    if (ref !== null) return byId(ask, ref);
  }
  const hash = target.indexOf("#");
  if (hash >= 0) {
    return byPathName(ask, target.slice(0, hash), target.slice(hash + 1));
  }
  if (target.includes("/")) return byPath(ask, target);
  return byName(ask, target);
}

function byId(ask: Ask, ref: NodeRef): Resolved | ToolError {
  if (ref.repo !== ask.repo) {
    return toolError(
      "invalid_argument",
      `${ask.field} is an ID of another repo (${echo(ref.repo)})`,
      {
        field: ask.field,
        hint: `pass an ID of ${ask.repo}, a repo-relative path, or a name`,
      },
    );
  }
  const { ix } = ask;
  switch (ref.kind) {
    case "repo":
      return { kind: "repo", ref };
    case "directory": {
      const component = ix.componentByPath.get(ref.path);
      if (component !== undefined) {
        return { kind: "directory", componentId: component.id, ref };
      }
      return denied(ref.path) ?? notFound(ask, [], COMPONENT_HINT);
    }
    case "file": {
      const file = ix.fileByPath.get(ref.path);
      if (file !== undefined) return { kind: "file", fileId: file.id, ref };
      return missingFile(ask, ref.path);
    }
    case "definition": {
      const file = ix.fileByPath.get(ref.path);
      if (ref.qualname === MODULE_QUALNAME && ref.ordinal === 1) {
        return file !== undefined
          ? fileNode(ask, file)
          : missingFile(ask, ref.path);
      }
      const def =
        file === undefined
          ? undefined
          : defsOf(ix, file).find(
              (d) => d.qualname === ref.qualname && d.ordinal === ref.ordinal,
            );
      if (file !== undefined && def !== undefined) {
        return { kind: "definition", defId: def.id, fileId: file.id, ref };
      }
      return missingDef(ask, ref.path, file, ref.qualname);
    }
    case "external": {
      for (const external of ix.externals.values()) {
        if (
          external.ecosystem === ref.ecosystem &&
          external.name === ref.name
        ) {
          return { kind: "external", externalId: external.id, ref };
        }
      }
      return notFound(ask, [], EXTERNAL_HINT);
    }
  }
}

// path#name: the path must be a stored file. <module> names the file; then an exact qualname,
// with an optional (n) ordinal; then the file's definitions whose name is name.
function byPathName(
  ask: Ask,
  path: string,
  name: string,
): Resolved | ToolError {
  const file = ask.ix.fileByPath.get(path);
  if (name === MODULE_QUALNAME) {
    return file !== undefined ? fileNode(ask, file) : missingFile(ask, path);
  }
  const { qualname, ordinal } = splitName(name) ?? {
    qualname: name,
    ordinal: 1,
  };
  if (file !== undefined) {
    const defs = defsOf(ask.ix, file);
    const exact = defs.find(
      (d) => d.qualname === qualname && d.ordinal === ordinal,
    );
    if (exact !== undefined) return defNode(ask, exact, file);
    const named = defs.filter((d) => d.name === name);
    const [only] = named;
    if (named.length === 1 && only !== undefined)
      return defNode(ask, only, file);
    if (named.length > 1) {
      return ambiguous(
        ask,
        `${named.length} definitions in ${echo(path)} are named ${echo(name)}`,
        named.map((def) => ({ level: 0, file, def })),
        named.length,
      );
    }
  }
  return missingDef(ask, path, file, qualname);
}

// A path: a stored file, or else a component, with or without its trailing "/".
function byPath(ask: Ask, path: string): Resolved | ToolError {
  const file = ask.ix.fileByPath.get(path);
  if (file !== undefined) return fileNode(ask, file);
  const dir = path.endsWith("/") ? path : `${path}/`;
  const component = ask.ix.componentByPath.get(dir);
  if (component !== undefined) {
    return {
      kind: "directory",
      componentId: component.id,
      ref: { kind: "directory", repo: ask.repo, path: dir },
    };
  }
  if (path.endsWith("/")) {
    return denied(path) ?? notFound(ask, [], COMPONENT_HINT);
  }
  return missingFile(ask, path);
}

// A bare name: the definitions whose qualname or name is name, the files whose basename is
// name, and the component whose path is name plus "/". One match resolves.
function byName(ask: Ask, name: string): Resolved | ToolError {
  const { ix } = ask;
  const defs = defsCalled(ix, name, true);
  // name holds no "/", so its basename is name when the path is name or ends with "/" + name
  const files: FileInfo[] = [];
  const tail = `/${name}`;
  for (const file of ix.files.values()) {
    if (file.path === name || file.path.endsWith(tail)) files.push(file);
  }
  const component = ix.componentByPath.get(`${name}/`);
  const n = defs.length + files.length + (component === undefined ? 0 : 1);
  if (n === 1) {
    const [def] = defs;
    const [file] = files;
    if (def !== undefined) return defNode(ask, def, fileOf(ix, def));
    if (file !== undefined) return fileNode(ask, file);
    if (component !== undefined) {
      return {
        kind: "directory",
        componentId: component.id,
        ref: { kind: "directory", repo: ask.repo, path: component.path },
      };
    }
  }
  if (n > 1) {
    const what =
      component !== undefined
        ? "components, files and definitions match"
        : files.length > 0
          ? "files and definitions match"
          : "definitions are named";
    return ambiguous(
      ask,
      `${n} ${what} ${echo(name)}`,
      [
        ...defs.map((def) => ({ level: 0, file: fileOf(ix, def), def })),
        ...files.map((file) => ({ level: 0, file, def: null })),
      ],
      n,
      component === undefined ? "" : `, or ${echo(name)}/ for the component`,
    );
  }
  return denied(name) ?? notFound(ask, near(ask, name), NAME_HINT);
}

function fileNode(ask: Ask, file: FileInfo): Resolved {
  return {
    kind: "file",
    fileId: file.id,
    ref: { kind: "file", repo: ask.repo, path: file.path },
  };
}

function defNode(ask: Ask, def: DefInfo, file: FileInfo): Resolved {
  return {
    kind: "definition",
    defId: def.id,
    fileId: file.id,
    ref: {
      kind: "definition",
      repo: ask.repo,
      path: file.path,
      qualname: def.qualname,
      ordinal: def.ordinal,
    },
  };
}

// A file path that resolves to nothing: denied, or not found with its near misses and renames.
function missingFile(ask: Ask, path: string): ToolError {
  return denied(path) ?? notFound(ask, fileCandidates(ask, path), NAME_HINT);
}

// A definition that resolves to nothing: denied, or not found with the near names in its file,
// then its qualname in other files, then its qualname under a renamed path.
function missingDef(
  ask: Ask,
  path: string,
  file: FileInfo | undefined,
  qualname: string,
): ToolError {
  const deny = denied(path);
  if (deny !== undefined) return deny;
  const { ix } = ask;
  const near: Hit[] = [];
  if (file !== undefined) {
    for (const def of defsOf(ix, file)) {
      const level = matchLevel(qualname, [def.qualname, def.name]);
      if (level !== null)
        near.push({ level: MATCH_LEVELS.indexOf(level), file, def });
    }
  }
  // the same qualname elsewhere follows every near name in the file
  const elsewhere = MATCH_LEVELS.length;
  for (const def of defsCalled(ix, qualname, false)) {
    if (def.fileId !== file?.id) {
      near.push({ level: elsewhere, file: fileOf(ix, def), def });
    }
  }
  const renamed = renamedFiles(ask, path).flatMap((to) =>
    defsOf(ix, to)
      .filter((def) => def.qualname === qualname)
      .map((def) => ({ level: 0, file: to, def })),
  );
  return notFound(ask, candidates(ix, near, renamed), NAME_HINT);
}

function denied(path: string): ToolError | undefined {
  return isDenied(path, [])
    ? toolError(
        "denied_file",
        `${echo(path)} is denylisted and was never stored`,
      )
    : undefined;
}

function notFound(ask: Ask, found: Candidate[], hint: string): ToolError {
  return toolError(
    "not_found",
    `${ask.field} ${echo(ask.target)} is not in the store`,
    {
      field: ask.field,
      candidates: found.length > 0 ? found : undefined,
      hint: found.length > 0 ? `pass one candidate id as ${ask.field}` : hint,
    },
  );
}

function ambiguous(
  ask: Ask,
  message: string,
  matches: Hit[],
  n: number,
  more = "",
): ToolError {
  const all = n > MAX_CANDIDATES ? `; code_find lists all ${n}` : "";
  return toolError("ambiguous", message, {
    candidates: firstOf(matches, MAX_CANDIDATES, compareHits(ask.ix)).map(
      (hit) => candidateOf(ask.ix, hit),
    ),
    hint: `pass one candidate id as ${ask.field}${more}${all}`,
  });
}

// A path's near misses: the files whose basename is the path's basename, ignoring case, then
// the files whose path contains that basename; then the stored paths it was renamed to.
function fileCandidates(ask: Ask, path: string): Candidate[] {
  const base = basename(path);
  const near: Hit[] = [];
  for (const file of ask.ix.files.values()) {
    const level = matchLevel(base, [file.path, basename(file.path)]);
    if (level !== null)
      near.push({ level: MATCH_LEVELS.indexOf(level), file, def: null });
  }
  const renamed = renamedFiles(ask, path).map((file) => ({
    level: 0,
    file,
    def: null,
  }));
  return candidates(ask.ix, near, renamed);
}

// A bare name's near misses: the definitions and files it matches at a case, prefix or
// substring level (an exact match would have resolved).
function near(ask: Ask, name: string): Candidate[] {
  const { ix } = ask;
  const hits: Hit[] = [];
  for (const def of ix.defs.values()) {
    if (!isNamed(def)) continue;
    const level = matchLevel(name, [def.qualname, def.name]);
    if (level !== null) {
      hits.push({
        level: MATCH_LEVELS.indexOf(level),
        file: fileOf(ix, def),
        def,
      });
    }
  }
  for (const file of ix.files.values()) {
    const level = matchLevel(name, [file.path, basename(file.path)]);
    if (level !== null)
      hits.push({ level: MATCH_LEVELS.indexOf(level), file, def: null });
  }
  return candidates(ix, hits, []);
}

// The near misses in order, then the renames, each node once and at most MAX_CANDIDATES in all.
// Renames keep their places: near misses are cut first, and a renamed node is listed as one.
function candidates(ix: StoreIndex, near: Hit[], renamed: Hit[]): Candidate[] {
  const kept = new Map<string, Hit>();
  for (const hit of renamed) {
    if (kept.size < MAX_CANDIDATES) kept.set(keyOf(hit), hit);
  }
  const room = MAX_CANDIDATES - kept.size;
  const firstNear = firstOf(
    near.filter((hit) => !kept.has(keyOf(hit))),
    room,
    compareHits(ix),
  );
  return [...firstNear, ...kept.values()].map((hit) => candidateOf(ix, hit));
}

function candidateOf(ix: StoreIndex, hit: Hit): Candidate {
  if (hit.def === null) {
    return {
      id: ix.idOfFile(hit.file.id),
      kind: hit.file.test ? "test-file" : "file",
    };
  }
  return {
    id: ix.idOfDef(hit.def.id),
    kind: hit.def.kind,
    line: hit.def.startLine,
  };
}

const keyOf = (hit: Hit): string =>
  hit.def === null ? `f${hit.file.id}` : `d${hit.def.id}`;

// By level, then by rank, then path, then line (a file is line 0), then row order.
const compareHits =
  (ix: StoreIndex) =>
  (a: Hit, b: Hit): number =>
    a.level - b.level ||
    ix.compareFiles(a.file, b.file) ||
    (a.def?.startLine ?? 0) - (b.def?.startLine ?? 0) ||
    (a.def?.id ?? 0) - (b.def?.id ?? 0);

// The first k items in compare order, without sorting them all.
function firstOf<T>(
  items: readonly T[],
  k: number,
  compare: (a: T, b: T) => number,
): T[] {
  const out: T[] = [];
  if (k < 1) return out;
  for (const item of items) {
    const last = out.at(-1);
    if (out.length === k && last !== undefined && compare(item, last) >= 0)
      continue;
    let lo = 0;
    let hi = out.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compare(out[mid] as T, item) <= 0) lo = mid + 1;
      else hi = mid;
    }
    out.splice(lo, 0, item);
    if (out.length > k) out.pop();
  }
  return out;
}

// The stored files a path was renamed to, following renames up to MAX_RENAME_STEPS steps; a
// chain stops at the first stored path. Nearest first, then by path.
function renamedFiles(ask: Ask, path: string): FileInfo[] {
  const statement = ask.store.db.prepare(
    "SELECT new_path FROM renames WHERE old_path = ?",
  );
  const found: FileInfo[] = [];
  const seen = new Set([path]);
  let frontier = [path];
  for (let step = 0; step < MAX_RENAME_STEPS && frontier.length > 0; step++) {
    const next: string[] = [];
    for (const from of frontier) {
      const to = statement
        .all(from)
        .map((row) => String(row.new_path))
        .sort(comparePaths);
      for (const p of to) {
        if (seen.has(p)) continue;
        seen.add(p);
        const file = ask.ix.fileByPath.get(p);
        if (file !== undefined) found.push(file);
        else next.push(p);
      }
    }
    frontier = next;
  }
  return found;
}

// A file's definitions without its module row.
function defsOf(
  ix: StoreIndex,
  file: FileInfo,
): (DefInfo & { kind: DefKind })[] {
  return (ix.defsByFile.get(file.id) ?? []).filter(isNamed);
}

// The definitions whose qualname is name, or, with byName, whose name is name; in row order.
function defsCalled(
  ix: StoreIndex,
  name: string,
  byName: boolean,
): (DefInfo & { kind: DefKind })[] {
  const last = name.slice(name.lastIndexOf(".") + 1);
  const found = new Map<number, DefInfo & { kind: DefKind }>();
  for (const key of last === name ? [name] : [last, name]) {
    for (const def of ix.defsByName.get(key) ?? []) {
      if (
        isNamed(def) &&
        (def.qualname === name || (byName && def.name === name))
      ) {
        found.set(def.id, def);
      }
    }
  }
  return [...found.values()].sort((a, b) => a.id - b.id);
}

function fileOf(ix: StoreIndex, def: DefInfo): FileInfo {
  const file = ix.files.get(def.fileId);
  if (file === undefined)
    throw new RangeError(`the store has no file ${def.fileId}`);
  return file;
}

const isNamed = (def: DefInfo): def is DefInfo & { kind: DefKind } =>
  def.kind !== "module";

const basename = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1);
