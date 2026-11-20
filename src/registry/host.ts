// registryHost: hakutaku's own Host, built from the registry. Its repos are fixed when it is
// created. It opens a repo's store through a store cache on every call, so a store that a build
// swapped is reopened; it reads freshness from the checkout's ref files and the last attempt;
// and, only when refresh is allowed, it runs `hakutaku map` for a repo at most once every 10
// minutes. It never opens a path a caller passes: a repo is one of its own ids, or unknown.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { RepoId } from "../model/index.js";
import {
  type Attempt,
  createStoreCache,
  type NotBuilt,
  readAttempt,
  type Store,
} from "../store/index.js";
import type { Host, LastAttempt, RefreshState } from "../tools/host.js";
import {
  DEFAULT_MAX_RESULT_CHARS,
  REFRESH_INTERVAL_SECONDS,
} from "../tools/limits.js";
import { storePathFor } from "./dirs.js";
import { computeFreshness } from "./freshness.js";
import { createRefReader } from "./refs.js";
import { loadRegistry } from "./registry.js";
import type { RefResult, RegistryEntry } from "./types.js";

// A repo id that has no registry entry, or an empty registry. hakutaku mcp and hakutaku query
// report it as a usage error.
export class UnknownRepoError extends Error {
  readonly unknown: RepoId[];
  readonly registered: RepoId[];

  constructor(unknown: RepoId[], registered: RepoId[]) {
    super(
      registered.length === 0
        ? "no repo is registered; run hakutaku map <repo> first"
        : `unknown repo: ${unknown.join(", ")}; registered: ${registered.join(", ")}`,
    );
    this.name = "UnknownRepoError";
    this.unknown = [...unknown];
    this.registered = [...registered];
  }
}

// What the host reads and runs, so that tests can give their own.
export interface RegistryHostDeps {
  now(): number; // ms
  refs: (repoPath: string, ref: string) => RefResult;
  stores: { get(path: string): Store | NotBuilt };
  spawnMap(entry: RegistryEntry): { done: Promise<void> }; // runs `hakutaku <mapArgv(entry)>`
}

const REFRESH_MS = REFRESH_INTERVAL_SECONDS * 1000;

// The arguments of the build a refresh runs. Every setting of the entry is passed, so a refresh
// rebuilds with the entry's own settings, whatever map's defaults are.
export function mapArgv(entry: RegistryEntry): string[] {
  const argv = [
    "map",
    entry.source,
    "--id",
    entry.id,
    "--ref",
    entry.ref,
    "--detail",
    entry.detail,
  ];
  if (entry.noSource) argv.push("--no-source");
  if (!entry.snippets) argv.push("--no-snippets");
  return argv;
}

export function createRegistryHost(
  opts: {
    repos: RepoId[] | "all";
    allowRefresh: boolean;
    maxResultChars?: number;
  },
  deps: RegistryHostDeps,
): Host {
  const entries = fixedEntries(opts.repos);

  // An id this host serves, for the calls that only runTool's gate reaches.
  const served = (repo: string): RegistryEntry => {
    const entry = entries.get(repo);
    if (entry === undefined) {
      throw new RangeError(
        `not a repo of this host: ${JSON.stringify(repo.slice(0, 120))}`,
      );
    }
    return entry;
  };

  // What open handed out in the current synchronous run, by repo, until the next microtask.
  // runTool calls open, then freshness, then queries the store open gave it. Were freshness to
  // ask the cache again after a build swapped the store, the cache would close that store before
  // the query reads it, and stale would describe a store the answer does not come from.
  let handedOut: Map<string, Store | NotBuilt> | undefined;
  const handOut = (repo: string, store: Store | NotBuilt): Store | NotBuilt => {
    if (handedOut === undefined) {
      const run = new Map<string, Store | NotBuilt>();
      handedOut = run;
      queueMicrotask(() => {
        if (handedOut === run) handedOut = undefined;
      });
    }
    handedOut.set(repo, store);
    return store;
  };

  const host: Host = {
    repos: () =>
      [...entries.values()].map((e) => ({
        id: e.id,
        ref: e.ref,
        detail: e.detail,
      })),
    open: (_ctx, repo) => {
      const entry = entries.get(repo);
      if (entry === undefined) return { code: "unknown_repo" };
      return handOut(entry.id, deps.stores.get(storePathFor(entry.id)));
    },
    freshness: (repo) => {
      const entry = served(repo);
      const path = storePathFor(entry.id);
      const store = handedOut?.get(entry.id) ?? deps.stores.get(path);
      return computeFreshness(
        "code" in store ? store : store.meta.commit,
        deps.refs(entry.source, entry.ref),
        readAttempt(path),
        entry.ref,
      );
    },
    snippets: (repo) => entries.get(repo)?.snippets ?? false,
    maxResultChars: opts.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS,
  };
  if (opts.allowRefresh) {
    const builds = new Map<string, { running: boolean; lastStart?: number }>();
    host.refresh = (repo) => {
      const entry = served(repo);
      const lastAttempt = lastAttemptOf(readAttempt(storePathFor(entry.id)));
      let build = builds.get(entry.id);
      if (build === undefined) {
        build = { running: false };
        builds.set(entry.id, build);
      }
      const now = deps.now();
      if (build.lastStart !== undefined) {
        // The seconds left in the 10 minutes since the last build started, rounded up.
        const left = Math.ceil((build.lastStart + REFRESH_MS - now) / 1000);
        if (build.running) {
          return refreshState("building", lastAttempt, Math.max(0, left));
        }
        if (now - build.lastStart < REFRESH_MS) {
          return refreshState("rate_limited", lastAttempt, left);
        }
      }
      const { done } = deps.spawnMap(entry);
      const started = build;
      started.running = true;
      started.lastStart = now;
      const over = (): void => {
        started.running = false;
      };
      done.then(over, over);
      return refreshState("queued", lastAttempt, REFRESH_INTERVAL_SECONDS);
    };
  }
  return host;
}

export function registryHost(opts: {
  repos: RepoId[] | "all";
  allowRefresh: boolean;
  maxResultChars?: number;
}): Host {
  return createRegistryHost(opts, {
    now: Date.now,
    refs: createRefReader(),
    stores: createStoreCache(),
    spawnMap: spawnDetached,
  });
}

// The entries a host serves, fixed now: the ids given, once each, in order, or every registered
// entry, sorted by id. Each is frozen, so a later change to the registry, or a spawnMap, changes
// nothing the host serves.
function fixedEntries(repos: RepoId[] | "all"): Map<string, RegistryEntry> {
  const registered = loadRegistry().repos;
  const fixed = new Map<string, RegistryEntry>();
  if (repos === "all") {
    for (const entry of registered) fixed.set(entry.id, Object.freeze(entry));
  } else {
    const byId = new Map(registered.map((e) => [e.id, e]));
    const unknown: RepoId[] = [];
    for (const id of repos) {
      const entry = byId.get(id);
      if (entry === undefined) {
        if (!unknown.includes(id)) unknown.push(id);
      } else if (!fixed.has(id)) {
        fixed.set(id, Object.freeze(entry));
      }
    }
    if (unknown.length > 0) {
      throw new UnknownRepoError(
        unknown,
        registered.map((e) => e.id),
      );
    }
  }
  if (registered.length === 0) throw new UnknownRepoError([], []);
  return fixed;
}

// A build that built or was skipped is ok; any other is failed, with its reason when it has one.
function lastAttemptOf(attempt: Attempt | null): LastAttempt | undefined {
  if (attempt === null) return undefined;
  if (attempt.result === "built" || attempt.result === "skipped") {
    return { at: attempt.at, result: "ok" };
  }
  return attempt.reason === undefined
    ? { at: attempt.at, result: "failed" }
    : { at: attempt.at, result: "failed", reason: attempt.reason };
}

function refreshState(
  state: "queued" | "building" | "rate_limited",
  lastAttempt: LastAttempt | undefined,
  retryAfterSeconds: number,
): RefreshState {
  return lastAttempt === undefined
    ? { state, retryAfterSeconds }
    : { state, lastAttempt, retryAfterSeconds };
}

// The CLI next to this module: dist/cli/main.js in the package.
const CLI_MAIN = fileURLToPath(new URL("../cli/main.js", import.meta.url));

// Runs `hakutaku <mapArgv(entry)>` with the node that runs this process, as a detached child
// this process does not wait for. done resolves when the child exits, or cannot start.
function spawnDetached(entry: RegistryEntry): { done: Promise<void> } {
  const child = spawn(process.execPath, [CLI_MAIN, ...mapArgv(entry)], {
    detached: true,
    stdio: "ignore",
  });
  const done = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  child.unref();
  return { done };
}
