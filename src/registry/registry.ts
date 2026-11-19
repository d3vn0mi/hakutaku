// The registry: hakutaku's own repos, in <data>/registry.json, sorted by id.
//
// saveEntry writes a temporary file in the same directory and renames it over the registry, so
// a reader finds the old registry or the new one, never a part of either. It reads, changes and
// writes the whole file, so two saves at once could each keep only their own entry; hakutaku
// map saves under the build lock. A registry.json that is not a registry is refused, never read
// as empty: the next save would write over every entry it holds.
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  comparePaths,
  type Detail,
  REPO_ID_RE,
  type RepoId,
} from "../model/index.js";
import { type Guard, oneOf, shape } from "../store/read.js";
import { hakutakuDirs } from "./dirs.js";
import type { Registry, RegistryEntry } from "./types.js";

const isBoolean: Guard<boolean> = (v): v is boolean => typeof v === "boolean";

const isAbsolutePath: Guard<string> = (v): v is string =>
  typeof v === "string" && isAbsolute(v);

// One guard for what loadRegistry reads and what saveEntry writes, so no save writes an entry
// that a later load would refuse. Keys the type does not declare are let through, then dropped.
const isEntry = shape<RegistryEntry>({
  id: (v): v is RepoId => typeof v === "string" && REPO_ID_RE.test(v),
  source: isAbsolutePath,
  ref: (v): v is string => typeof v === "string" && v !== "",
  detail: oneOf<Detail>({ quick: true, standard: true, deep: true }),
  noSource: isBoolean,
  snippets: isBoolean,
  profile: isAbsolutePath,
});

const isHead = shape<{ version: 1; repos: unknown[] }>({
  version: (v): v is 1 => v === 1,
  repos: (v): v is unknown[] => Array.isArray(v),
});

export function loadRegistry(): Registry {
  const path = registryPath();
  const text = readText(path);
  if (text === null) return { version: 1, repos: [] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw notARegistry(path, "not JSON");
  }
  if (!isHead(value)) {
    throw notARegistry(path, "not { version: 1, repos: [...] }");
  }
  const repos: RegistryEntry[] = [];
  for (const [i, e] of value.repos.entries()) {
    if (!isEntry(e)) throw notARegistry(path, `repos[${i}] is not an entry`);
    repos.push(entryOf(e));
  }
  repos.sort(byId);
  for (let i = 1; i < repos.length; i++) {
    const id = repos[i]?.id;
    if (id === repos[i - 1]?.id) {
      throw notARegistry(path, `${id} is listed twice`);
    }
  }
  return { version: 1, repos };
}

// Adds the entry, or replaces the one with its id.
export function saveEntry(entry: RegistryEntry): void {
  if (!isEntry(entry)) {
    throw new TypeError(`not a registry entry: ${JSON.stringify(entry)}`);
  }
  const repos = loadRegistry().repos.filter((e) => e.id !== entry.id);
  repos.push(entryOf(entry));
  repos.sort(byId);
  writeWhole(
    registryPath(),
    `${JSON.stringify({ version: 1, repos }, null, 2)}\n`,
  );
}

export function findEntry(id: RepoId): RegistryEntry | null {
  return loadRegistry().repos.find((e) => e.id === id) ?? null;
}

const registryPath = (): string =>
  join(hakutakuDirs(process.env).data, "registry.json");

const byId = (a: RegistryEntry, b: RegistryEntry): number =>
  comparePaths(a.id, b.id);

// Exactly the type's keys, in its order, so the file's text does not depend on how a caller
// built the entry.
const entryOf = (e: RegistryEntry): RegistryEntry => ({
  id: e.id,
  source: e.source,
  ref: e.ref,
  detail: e.detail,
  noSource: e.noSource,
  snippets: e.snippets,
  profile: e.profile,
});

const notARegistry = (path: string, why: string): Error =>
  new Error(`${path}: not an hakutaku registry (${why})`);

// The registry's text, or null when there is none. A path that is not a regular file is refused
// before it is read: the read of a FIFO would block until a writer opened it.
function readText(path: string): string | null {
  let isFile: boolean;
  try {
    isFile = statSync(path).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
  if (!isFile) throw notARegistry(path, "not a regular file");
  return readFileSync(path, "utf8");
}

// The temporary file is named like the store's, <name>.tmp-<pid>.json, in the same directory,
// so the rename never crosses a file system.
function writeWhole(path: string, text: string): void {
  const dir = dirname(path);
  const tmp = join(dir, `registry.tmp-${process.pid}.json`);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
