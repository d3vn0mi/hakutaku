import { type SpawnOptions, spawn } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createRefReader,
  createRegistryHost,
  findEntry,
  hakutakuDirs,
  mapArgv,
  type RegistryEntry,
  type RegistryHostDeps,
  registryHost,
  saveEntry,
  storePathFor,
  UnknownRepoError,
} from "../../../src/registry/index.js";
import { createStoreCache, type Store } from "../../../src/store/index.js";
import {
  type Host,
  type HostError,
  type RefreshState,
  runTool,
} from "../../../src/tools/index.js";
import { emptyContent, miniStore } from "../../helpers/mini-store.js";
import { TINY_COMMIT, tinyStore } from "../../helpers/tiny.js";

// The real spawn, recorded, with unref watched on each child it returns.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(
      (command: string, args: readonly string[], options: SpawnOptions) => {
        const child = actual.spawn(command, args, options);
        vi.spyOn(child, "unref");
        return child;
      },
    ),
  };
});

const TINY = tinyStore(); // copied into each test's data directory

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

let root = "";
let checkout = "";

// Each test points the XDG variables at a fresh root, makes a checkout whose main is
// TINY_COMMIT, registers it as tiny and puts the tiny store in its place.
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hakutaku-host-"));
  made.push(root);
  vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
  checkout = join(root, "checkout");
  mkdirSync(join(checkout, ".git/refs/heads"), { recursive: true });
  writeFileSync(join(checkout, ".git/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(checkout, ".git/refs/heads/main"), `${TINY_COMMIT}\n`);
  saveEntry({
    id: "tiny",
    source: checkout,
    ref: "main",
    detail: "standard",
    noSource: false,
    snippets: true,
    profile: join(root, "p.json"),
  });
  mkdirSync(dirname(storePathFor("tiny")), { recursive: true });
  copyFileSync(TINY, storePathFor("tiny"));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const fake = (over: Partial<RegistryHostDeps> = {}): RegistryHostDeps => ({
  now: () => 0,
  refs: createRefReader(),
  stores: createStoreCache(),
  spawnMap: vi.fn(() => ({ done: new Promise<void>(() => {}) })),
  ...over,
});

// The saved entry for an id.
function entry(id: string): RegistryEntry {
  const found = findEntry(id);
  if (found === null) throw new Error(`no entry ${id}`);
  return found;
}

// What host.open answers, when it must be a store.
function opened(answer: Store | HostError): Store {
  if ("code" in answer) throw new Error(`not a store: ${answer.code}`);
  return answer;
}

// The host's refresh, when it must have one.
function refreshOf(h: Host): (repo: string) => RefreshState {
  if (h.refresh === undefined) throw new Error("no refresh");
  return (repo) => h.refresh?.(repo) ?? { state: "idle" };
}

// Writes tiny's attempt.json.
function attempt(fields: Record<string, string>): void {
  writeFileSync(
    join(dirname(storePathFor("tiny")), "attempt.json"),
    JSON.stringify({ commit: TINY_COMMIT, ...fields }),
  );
}

// Renames a new store built at commit over tiny's, as a build's swap does.
function swapStore(commit: string): void {
  const next = emptyContent("tiny");
  next.meta[0].commit_sha = commit;
  const tmp = `${storePathFor("tiny")}.new`;
  copyFileSync(miniStore(next), tmp);
  renameSync(tmp, storePathFor("tiny"));
}

// The error createRegistryHost throws for these repos.
function refusal(repos: string[] | "all"): unknown {
  try {
    createRegistryHost({ repos, allowRefresh: false }, fake());
  } catch (error) {
    return error;
  }
  throw new Error("no error");
}

it("fixes its repos at creation", () => {
  const h = createRegistryHost(
    { repos: ["tiny"], allowRefresh: false },
    fake(),
  );
  saveEntry({ ...entry("tiny"), id: "later" });
  expect(h.repos(null)).toEqual([
    { id: "tiny", ref: "main", detail: "standard" },
  ]);
  expect(() =>
    createRegistryHost({ repos: ["nope"], allowRefresh: false }, fake()),
  ).toThrow(UnknownRepoError);
  expect(
    createRegistryHost({ repos: "all", allowRefresh: false }, fake())
      .repos(null)
      .map((r) => r.id),
  ).toEqual(["later", "tiny"]);
});

it("reads freshness from ref files, with reasons", () => {
  const h = createRegistryHost(
    { repos: ["tiny"], allowRefresh: false },
    fake(),
  );
  expect(h.freshness("tiny")).toEqual({
    headCommit: TINY_COMMIT,
    stale: false,
  });
  writeFileSync(
    join(checkout, ".git/refs/heads/main"),
    "89abcdef0123456789abcdef0123456789abcdef\n",
  );
  expect(h.freshness("tiny")).toEqual({
    headCommit: "89abcdef0123456789abcdef0123456789abcdef",
    stale: true,
    reason: "main is at 89abcdef0123, the store at 0123456789ab",
  });
  writeFileSync(
    join(dirname(storePathFor("tiny")), "attempt.json"),
    JSON.stringify({
      at: "2026-11-16T10:00:00Z",
      commit: "89abcdef0123456789abcdef0123456789abcdef",
      result: "gates-failed",
      reason: "unresolved imports grew",
    }),
  );
  expect(h.freshness("tiny")).toMatchObject({
    stale: true,
    reason: "the last build failed its gates: unresolved imports grew",
  });
});

// Only a build puts the store and its attempt.json in place: a link in either place is never
// followed, so the store reads as unreadable and the attempt as none.
it.skipIf(process.platform === "win32")(
  "never follows a link in place of the store or its attempt",
  () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    const failed = join(elsewhere, "attempt.json");
    writeFileSync(
      failed,
      JSON.stringify({
        at: "2026-11-16T10:00:00Z",
        commit: TINY_COMMIT,
        result: "failed",
        reason: "planted",
      }),
    );
    symlinkSync(failed, join(dirname(storePathFor("tiny")), "attempt.json"));
    const h = createRegistryHost(
      { repos: ["tiny"], allowRefresh: true },
      fake(),
    );
    expect(h.freshness("tiny")).toEqual({
      headCommit: TINY_COMMIT,
      stale: false,
    });
    expect(refreshOf(h)("tiny")).toEqual({
      state: "queued",
      retryAfterSeconds: 600,
    });
    const store = join(elsewhere, "store.sqlite");
    copyFileSync(TINY, store);
    rmSync(storePathFor("tiny"));
    symlinkSync(store, storePathFor("tiny"));
    const g = createRegistryHost(
      { repos: ["tiny"], allowRefresh: false },
      fake(),
    );
    expect(g.open(null, "tiny")).toEqual({
      code: "not_built",
      reason: "store unreadable",
    });
    expect(g.freshness("tiny")).toEqual({
      headCommit: TINY_COMMIT,
      stale: true,
      reason: "not built: store unreadable",
    });
  },
);

it("gives unknown when the ref cannot be read", () => {
  saveEntry({ ...entry("tiny"), ref: "refs/heads/nope" });
  expect(
    createRegistryHost(
      { repos: ["tiny"], allowRefresh: false },
      fake(),
    ).freshness("tiny"),
  ).toMatchObject({ headCommit: null, stale: "unknown" });
});

it("reopens a swapped store", () => {
  const h = createRegistryHost(
    { repos: ["tiny"], allowRefresh: false },
    fake(),
  );
  expect(opened(h.open(null, "tiny")).meta.commit).toBe(TINY_COMMIT);
  const next = emptyContent("tiny");
  next.meta[0].commit_sha = "f".repeat(40);
  const tmp = `${storePathFor("tiny")}.new`;
  copyFileSync(miniStore(next), tmp);
  renameSync(tmp, storePathFor("tiny"));
  expect(opened(h.open(null, "tiny")).meta.commit).toBe("f".repeat(40));
});

it("refreshes at most once every 10 minutes", async () => {
  let now = 0;
  let finish: () => void = () => {};
  const spawnMap = vi.fn((_entry: RegistryEntry) => ({
    done: new Promise<void>((resolve) => {
      finish = resolve;
    }),
  }));
  const h = createRegistryHost(
    { repos: ["tiny"], allowRefresh: true },
    fake({ now: () => now, spawnMap }),
  );
  const refresh = refreshOf(h);
  expect(refresh("tiny")).toMatchObject({
    state: "queued",
    retryAfterSeconds: 600,
  });
  expect(spawnMap).toHaveBeenCalledWith(
    expect.objectContaining({ id: "tiny" }),
  );
  expect(mapArgv(entry("tiny"))).toEqual([
    "map",
    checkout,
    "--id",
    "tiny",
    "--ref",
    "main",
    "--detail",
    "standard",
  ]);
  expect(
    mapArgv({ ...entry("tiny"), noSource: true, snippets: false }),
  ).toEqual([
    "map",
    checkout,
    "--id",
    "tiny",
    "--ref",
    "main",
    "--detail",
    "standard",
    "--no-source",
    "--no-snippets",
  ]);
  now = 60_000;
  expect(refresh("tiny")).toMatchObject({
    state: "building",
    retryAfterSeconds: 540,
  });
  finish();
  await Promise.resolve();
  await Promise.resolve();
  now = 120_000;
  expect(refresh("tiny")).toMatchObject({
    state: "rate_limited",
    retryAfterSeconds: 480,
  });
  now = 600_000;
  expect(refresh("tiny")).toMatchObject({ state: "queued" });
  expect(spawnMap).toHaveBeenCalledTimes(2);
  expect(
    createRegistryHost({ repos: ["tiny"], allowRefresh: false }, fake())
      .refresh,
  ).toBeUndefined();
});

describe("its repos", () => {
  it("throws UnknownRepoError naming the unknown and the registered ids", () => {
    saveEntry({ ...entry("tiny"), id: "vega" });
    const error = refusal(["nope", "tiny", "x.y", "nope"]);
    expect(error).toBeInstanceOf(UnknownRepoError);
    expect(error).toMatchObject({
      name: "UnknownRepoError",
      message: "unknown repo: nope, x.y; registered: tiny, vega",
      unknown: ["nope", "x.y"],
      registered: ["tiny", "vega"],
    });
  });

  it("throws UnknownRepoError for an empty registry, named ids or all", () => {
    rmSync(join(hakutakuDirs().data, "registry.json"));
    expect(refusal(["tiny"])).toMatchObject({
      message: "no repo is registered; run hakutaku map <repo> first",
      unknown: ["tiny"],
      registered: [],
    });
    expect(refusal("all")).toMatchObject({
      message: "no repo is registered; run hakutaku map <repo> first",
      unknown: [],
      registered: [],
    });
  });

  it("serves each id once, in the order given, with its entry as it was at creation", () => {
    saveEntry({ ...entry("tiny"), id: "vega", ref: "dev", detail: "deep" });
    const h = createRegistryHost(
      { repos: ["vega", "tiny", "vega"], allowRefresh: false },
      fake(),
    );
    saveEntry({
      ...entry("tiny"),
      ref: "refs/heads/nope",
      detail: "quick",
      snippets: false,
    });
    expect(h.repos(null)).toEqual([
      { id: "vega", ref: "dev", detail: "deep" },
      { id: "tiny", ref: "main", detail: "standard" },
    ]);
    expect(h.freshness("tiny")).toEqual({
      headCommit: TINY_COMMIT,
      stale: false,
    });
    expect(h.snippets("tiny")).toBe(true);
    const listed = h.repos(null);
    listed.pop();
    if (listed[0] !== undefined) listed[0].ref = "x";
    expect(h.repos(null)).toEqual([
      { id: "vega", ref: "dev", detail: "deep" },
      { id: "tiny", ref: "main", detail: "standard" },
    ]);
  });

  it("opens only its own ids, never a path, and passes not_built through", () => {
    const stores = createStoreCache();
    const get = vi.fn((path: string) => stores.get(path));
    const h = createRegistryHost(
      { repos: ["tiny"], allowRefresh: false },
      fake({ stores: { get } }),
    );
    for (const repo of [
      "Tiny",
      "tiny/",
      " tiny",
      "../tiny",
      "",
      "later",
      storePathFor("tiny"),
    ]) {
      expect(h.open(null, repo)).toEqual({ code: "unknown_repo" });
    }
    expect(get).not.toHaveBeenCalled();
    rmSync(storePathFor("tiny"));
    expect(h.open(null, "tiny")).toEqual({
      code: "not_built",
      reason: "not built yet",
    });
    expect(get).toHaveBeenCalledWith(storePathFor("tiny"));
  });

  it("follows each entry's snippets, and takes the given or the default result cap", () => {
    saveEntry({ ...entry("tiny"), id: "quiet", snippets: false });
    const h = createRegistryHost(
      { repos: ["tiny", "quiet"], allowRefresh: false },
      fake(),
    );
    expect([
      h.snippets("tiny"),
      h.snippets("quiet"),
      h.snippets("nope"),
    ]).toEqual([true, false, false]);
    expect(h.maxResultChars).toBe(40000);
    expect(
      createRegistryHost(
        { repos: ["tiny"], allowRefresh: false, maxResultChars: 1200 },
        fake(),
      ).maxResultChars,
    ).toBe(1200);
  });

  it("throws on freshness or refresh for an id it does not serve", () => {
    const spawnMap = vi.fn(() => ({ done: Promise.resolve() }));
    const h = createRegistryHost(
      { repos: ["tiny"], allowRefresh: true },
      fake({ spawnMap }),
    );
    expect(() => h.freshness("nope")).toThrow(RangeError);
    expect(() => refreshOf(h)("nope")).toThrow(RangeError);
    expect(spawnMap).not.toHaveBeenCalled();
  });
});

describe("a swapped store", () => {
  it("describes the store open handed out until the run ends, and keeps it open", async () => {
    const h = createRegistryHost(
      { repos: ["tiny"], allowRefresh: false },
      fake(),
    );
    const store = opened(h.open(null, "tiny"));
    const count = () =>
      store.db.prepare("SELECT count(*) AS n FROM files").get();
    const files = count();
    swapStore("f".repeat(40));
    expect(h.freshness("tiny")).toEqual({
      headCommit: TINY_COMMIT,
      stale: false,
    });
    expect(count()).toEqual(files);
    await Promise.resolve();
    expect(h.freshness("tiny")).toEqual({
      headCommit: TINY_COMMIT,
      stale: true,
      reason: "main is at 0123456789ab, the store at ffffffffffff",
    });
    expect(opened(h.open(null, "tiny")).meta.commit).toBe("f".repeat(40));
  });

  it("answers a call whose store is swapped between open and freshness from the store it opened", () => {
    const stores = createStoreCache();
    let swapped = false;
    const get = (path: string) => {
      const store = stores.get(path);
      if (!swapped) {
        swapped = true;
        swapStore("f".repeat(40));
      }
      return store;
    };
    const h = createRegistryHost(
      { repos: ["tiny"], allowRefresh: false },
      fake({ stores: { get } }),
    );
    expect(
      runTool(h, null, "code_find", { repo: "tiny", name: "main" }),
    ).toMatchObject({
      ok: true,
      answer: { builtCommit: "0123456789ab", stale: false },
    });
    expect(swapped).toBe(true);
  });
});

describe("freshness", () => {
  it("reads a repo that is not built as stale, a failed attempt's reason first", () => {
    const h = createRegistryHost(
      { repos: ["tiny"], allowRefresh: false },
      fake(),
    );
    rmSync(storePathFor("tiny"));
    expect(h.freshness("tiny")).toEqual({
      headCommit: TINY_COMMIT,
      stale: true,
      reason: "not built: not built yet",
    });
    attempt({
      at: "2026-11-16T10:00:00Z",
      result: "gates-failed",
      reason: "unresolved imports grew",
    });
    expect(h.freshness("tiny")).toEqual({
      headCommit: TINY_COMMIT,
      stale: true,
      reason: "the last build failed its gates: unresolved imports grew",
    });
  });

  it("passes the ref reader's reasons through as they are", () => {
    saveEntry({ ...entry("tiny"), ref: "refs/heads/nope" });
    expect(
      createRegistryHost(
        { repos: ["tiny"], allowRefresh: false },
        fake(),
      ).freshness("tiny"),
    ).toEqual({
      headCommit: null,
      stale: "unknown",
      reason: "cannot resolve refs/heads/nope from ref files",
    });
    saveEntry({ ...entry("tiny"), ref: "main" });
    rmSync(join(checkout, ".git"), { recursive: true });
    expect(
      createRegistryHost(
        { repos: ["tiny"], allowRefresh: false },
        fake(),
      ).freshness("tiny"),
    ).toEqual({
      headCommit: null,
      stale: "unknown",
      reason: "not a git repository",
    });
  });
});

describe("refresh", () => {
  it("reports the last attempt, ok or failed, beside each state", async () => {
    let now = 0;
    const finishes: Array<() => void> = [];
    const spawnMap = vi.fn((_entry: RegistryEntry) => ({
      done: new Promise<void>((resolve) => {
        finishes.push(resolve);
      }),
    }));
    const refresh = refreshOf(
      createRegistryHost(
        { repos: ["tiny"], allowRefresh: true },
        fake({ now: () => now, spawnMap }),
      ),
    );
    expect(refresh("tiny")).toStrictEqual({
      state: "queued",
      retryAfterSeconds: 600,
    });
    attempt({
      at: "2026-11-16T10:00:00Z",
      result: "failed",
      reason: "interrupted or still running (pid 7): running ast-grep",
    });
    now = 1;
    expect(refresh("tiny")).toStrictEqual({
      state: "building",
      lastAttempt: {
        at: "2026-11-16T10:00:00Z",
        result: "failed",
        reason: "interrupted or still running (pid 7): running ast-grep",
      },
      retryAfterSeconds: 600,
    });
    finishes[0]?.();
    await Promise.resolve();
    attempt({ at: "2026-11-16T10:05:00Z", result: "skipped", reason: "x" });
    now = 300_500;
    expect(refresh("tiny")).toStrictEqual({
      state: "rate_limited",
      lastAttempt: { at: "2026-11-16T10:05:00Z", result: "ok" },
      retryAfterSeconds: 300,
    });
    attempt({ at: "2026-11-16T10:06:00Z", result: "gates-failed" });
    now = 600_000;
    expect(refresh("tiny")).toStrictEqual({
      state: "queued",
      lastAttempt: { at: "2026-11-16T10:06:00Z", result: "failed" },
      retryAfterSeconds: 600,
    });
    attempt({ at: "2026-11-16T10:20:00Z", result: "built" });
    now = 1_300_000; // a build still running past its 10 minutes
    expect(refresh("tiny")).toStrictEqual({
      state: "building",
      lastAttempt: { at: "2026-11-16T10:20:00Z", result: "ok" },
      retryAfterSeconds: 0,
    });
    expect(spawnMap).toHaveBeenCalledTimes(2);
  });

  it("cleans a failed attempt's reason again where it is shown: the home directory as ~, secrets redacted", () => {
    vi.stubEnv("HOME", "/srv/astronomer");
    // assembled here, never written whole
    const secret = ["gh", "p_", "Q7x2M4p9K3l8N5r6".repeat(3)].join("");
    const said = `ast-grep failed: exit code 2\ncannot read /srv/astronomer/sky.env: token=${secret}`;
    const shown =
      "ast-grep failed: exit code 2\ncannot read ~/sky.env: token=«redacted:github-token»";
    attempt({ at: "2026-11-16T10:00:00Z", result: "failed", reason: said });
    const host = createRegistryHost(
      { repos: ["tiny"], allowRefresh: true },
      fake(),
    );
    expect(refreshOf(host)("tiny")).toMatchObject({
      lastAttempt: { result: "failed", reason: shown },
    });
    expect(host.freshness("tiny").reason).toBe(
      `the last build failed: ${shown}`,
    );
  });

  it("keeps one state per repo, and ends a build whose done rejects", async () => {
    saveEntry({ ...entry("tiny"), id: "vega" });
    let now = 0;
    const spawnMap = vi.fn((e: RegistryEntry) => ({
      done:
        e.id === "vega"
          ? Promise.reject(new Error("no child"))
          : new Promise<void>(() => {}),
    }));
    const refresh = refreshOf(
      createRegistryHost(
        { repos: ["tiny", "vega"], allowRefresh: true },
        fake({ now: () => now, spawnMap }),
      ),
    );
    expect(refresh("tiny")).toMatchObject({ state: "queued" });
    expect(refresh("vega")).toMatchObject({ state: "queued" });
    await Promise.resolve();
    now = 1_000;
    expect(refresh("tiny")).toMatchObject({
      state: "building",
      retryAfterSeconds: 599,
    });
    expect(refresh("vega")).toMatchObject({
      state: "rate_limited",
      retryAfterSeconds: 599,
    });
    expect(spawnMap.mock.calls.map(([e]) => e.id)).toEqual(["tiny", "vega"]);
  });

  it("starts a new 10-minute window with each build it queues", async () => {
    let now = 0;
    const finishes: Array<() => void> = [];
    const spawnMap = vi.fn((_entry: RegistryEntry) => ({
      done: new Promise<void>((resolve) => {
        finishes.push(resolve);
      }),
    }));
    const refresh = refreshOf(
      createRegistryHost(
        { repos: ["tiny"], allowRefresh: true },
        fake({ now: () => now, spawnMap }),
      ),
    );
    expect(refresh("tiny")).toMatchObject({ state: "queued" });
    finishes[0]?.();
    await Promise.resolve();
    now = 700_000;
    expect(refresh("tiny")).toMatchObject({
      state: "queued",
      retryAfterSeconds: 600,
    });
    now = 760_000;
    expect(refresh("tiny")).toMatchObject({
      state: "building",
      retryAfterSeconds: 540,
    });
    finishes[1]?.();
    await Promise.resolve();
    now = 820_000;
    expect(refresh("tiny")).toMatchObject({
      state: "rate_limited",
      retryAfterSeconds: 480,
    });
    now = 1_299_999;
    expect(refresh("tiny")).toMatchObject({
      state: "rate_limited",
      retryAfterSeconds: 1,
    });
    now = 1_300_000;
    expect(refresh("tiny")).toMatchObject({ state: "queued" });
    expect(spawnMap).toHaveBeenCalledTimes(3);
  });

  it("ends the build of a child that cannot start, without an unhandled error", async () => {
    const actual =
      await vi.importActual<typeof import("node:child_process")>(
        "node:child_process",
      );
    // A working directory that does not exist: the spawn fails after it returns, with ENOENT.
    vi.mocked(spawn).mockImplementationOnce(((
      command: string,
      args: readonly string[],
      options: SpawnOptions,
    ) =>
      actual.spawn(command, args, {
        ...options,
        cwd: join(root, "missing"),
      })) as typeof spawn);
    const refresh = refreshOf(
      registryHost({ repos: ["tiny"], allowRefresh: true }),
    );
    expect(refresh("tiny")).toMatchObject({ state: "queued" });
    let state = refresh("tiny").state;
    for (let i = 0; i < 100 && state === "building"; i++) {
      await sleep(20);
      state = refresh("tiny").state;
    }
    expect(state).toBe("rate_limited");
  });

  it("registryHost reads the registry, and its refresh runs a detached child", async () => {
    const h = registryHost({ repos: ["tiny"], allowRefresh: true });
    expect(h.repos(null)).toEqual([
      { id: "tiny", ref: "main", detail: "standard" },
    ]);
    expect(h.freshness("tiny")).toEqual({
      headCommit: TINY_COMMIT,
      stale: false,
    });
    expect(opened(h.open(null, "tiny")).meta.commit).toBe(TINY_COMMIT);
    expect(h.maxResultChars).toBe(40000);
    expect(
      registryHost({ repos: ["tiny"], allowRefresh: false }).refresh,
    ).toBeUndefined();
    const spawned = vi.mocked(spawn);
    spawned.mockClear();
    const refresh = refreshOf(h);
    expect(refresh("tiny")).toMatchObject({ state: "queued" });
    expect(spawned.mock.calls).toEqual([
      [
        process.execPath,
        [
          fileURLToPath(new URL("../../../src/cli/main.js", import.meta.url)),
          "map",
          checkout,
          "--id",
          "tiny",
          "--ref",
          "main",
          "--detail",
          "standard",
        ],
        { detached: true, stdio: "ignore" },
      ],
    ]);
    expect(spawned.mock.results[0]?.value.unref).toHaveBeenCalledOnce();
    // From the sources there is no src/cli/main.js, so the child exits at once, and the
    // building state ends with it.
    let state = refresh("tiny").state;
    expect(state).toBe("building");
    for (let i = 0; i < 500 && state === "building"; i++) {
      await sleep(20);
      state = refresh("tiny").state;
    }
    expect(state).toBe("rate_limited");
  });
});
