// extractSnapshot against the installed engines: run `node dist/cli/main.js engines install
// --yes` once, and `npm run build` for the sandboxed run, before this file. Each repo is made
// with makeRepo, exported with exportRepo, and extracted with sandbox "none" unless a test says
// otherwise. Every build's engines are checked one by one, never through its result alone.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { main } from "../../../src/cli/main.js";
import { exportRepo, removeTree } from "../../../src/export/index.js";
import {
  type ExtractOptions,
  type ExtractResult,
  extractSnapshot,
} from "../../../src/extract/index.js";
import { DEFAULT_PROFILE } from "../../../src/profile/load.js";
import { compilerTier } from "../../../src/query/tiers.js";
import {
  type BuildFacts,
  openStore,
  readAttempt,
  readBuildFacts,
  type Store,
} from "../../../src/store/index.js";
import {
  brokenEnginesDir,
  enginesDirWithoutPython,
  standInEnginesDir,
} from "../../helpers/engines.js";
import { git, makeRepo, type RepoSpec } from "../../helpers/git.js";

const TIMEOUT = 300_000;

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) removeTree(dir);
});

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-oracle-extract-"));
  made.push(dir);
  return dir;
};

const DATE = "2026-03-02T10:00:00Z";
const lines = (...text: string[]): string => `${text.join("\n")}\n`;

const oneCommit = (files: RepoSpec["commits"][number]["files"]) =>
  makeRepo({ commits: [{ date: DATE, files }] });

// A TypeScript web part whose sky.ts calls orbit.ts's solve, which the compiler binds.
const SKY = {
  "web/src/orbit.ts": lines(
    "export function solve(t: number): number {",
    "  return t * 2;",
    "}",
  ),
  "web/src/sky.ts": lines(
    'import { solve } from "./orbit";',
    "export const day = solve(1);",
  ),
  "README.md": lines("# Sky", "", "Draws the sky."),
};

// A Python package under sim/src whose orbit.py imports units.py.
const EPHEMERIS = {
  "sim/src/observatory/__init__.py": lines("from . import orbit"),
  "sim/src/observatory/orbit.py": lines(
    "from .units import AU",
    "",
    "def period(a):",
    "    return a ** 1.5 * AU",
  ),
  "sim/src/observatory/units.py": lines("AU = 1.0"),
};

// The export of a repo's ref into a fresh directory, with a profile when one is given.
async function exportOf(
  repo: string,
  opts: { ref?: string; profile?: object } = {},
): Promise<string> {
  const root = tmp();
  let profile: string | undefined;
  if (opts.profile !== undefined) {
    profile = join(root, "profile.json");
    writeFileSync(profile, JSON.stringify(opts.profile));
  }
  const out = join(root, "export");
  await exportRepo({
    repo,
    ref: opts.ref ?? "HEAD",
    out,
    ...(profile === undefined ? {} : { profile }),
  });
  return out;
}

// A store path in a directory of its own.
const storePath = (): string => join(tmp(), "store", "store.sqlite");

const extract = (
  dir: string,
  out: string,
  more: Partial<ExtractOptions> = {},
): Promise<ExtractResult> =>
  extractSnapshot({ dir, out, sandbox: "none", ...more });

function opened(path: string): Store {
  const store = openStore(path);
  if ("code" in store) throw new Error(`${path}: ${store.reason}`);
  return store;
}

// Reads a store's meta and runs one query, then closes it.
function inStore<T>(path: string, read: (s: Store) => T): T {
  const store = opened(path);
  try {
    return read(store);
  } finally {
    store.close();
  }
}

const countOf = (s: Store, sql: string): number =>
  Number(s.db.prepare(sql).get()?.n);

const ALL_OK = [true, true, true, true, true];

// Each engine's status in build.json.
const statuses = (facts: BuildFacts | null) =>
  Object.fromEntries(
    Object.entries(facts?.engines ?? {}).map(([name, e]) => [name, e.status]),
  );

it(
  "builds, then skips an unchanged input",
  async () => {
    const repo = await oneCommit(SKY);
    const head = git(repo, "rev-parse", "HEAD");
    const dir = await exportOf(repo);
    const out = storePath();
    const stages: string[] = [];
    const first = await extractSnapshot(
      { dir, out, sandbox: "none" },
      { onStage: (stage) => stages.push(stage) },
    );
    expect(stages).toEqual([
      "engine:ast-grep",
      "engine:dependency-cruiser",
      "engine:scip-typescript",
      "write-store",
      "gates",
      "swap",
    ]);
    expect(first).toMatchObject({ result: "built", commit: head });
    expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.gates.map((g) => g.ok)).toEqual(ALL_OK);
    expect(first.gates.map((g) => g.gate)).toEqual([
      "files-indexed",
      "unresolved-imports",
      "scip-duplicates",
      "denylist",
      "redaction",
    ]);
    expect(first.gates[0]?.detail).toBe("typescript 2/2");
    inStore(out, (s) => {
      expect(s.meta.commit).toBe(head);
      expect(s.run).toMatchObject({
        ref: "HEAD",
        contentHash: first.contentHash,
      });
      expect(s.meta.gates).toEqual(first.gates);
      expect(s.meta.coverage.tiers).toEqual({
        "ast-grep": "ran",
        "dependency-cruiser": "ran",
        grimp: "skipped",
        "scip-typescript": "ran",
      });
      expect(Object.keys(s.meta.engines).sort()).toEqual([
        "ast-grep",
        "dependency-cruiser",
        "scip-typescript",
      ]);
      expect(s.meta.coverage.pythonResolver).toBe("none");
      // the compiler bound sky.ts's call of solve
      expect(
        countOf(
          s,
          "SELECT COUNT(*) AS n FROM call_targets WHERE label = 'bound'",
        ),
      ).toBe(1);
    });
    const facts = readBuildFacts(out);
    expect(facts).toMatchObject({
      commit: head,
      ref: "HEAD",
      contentHash: first.contentHash,
      sandbox: "none",
      peakRssBytes: null,
    });
    expect(statuses(facts)).toEqual({
      "ast-grep": "ran",
      "dependency-cruiser": "ran",
      grimp: "skipped",
      "scip-typescript": "ran",
    });
    expect(facts?.engines["scip-typescript"]?.exitCode).toBe(0);
    expect(readAttempt(out)).toMatchObject({ commit: head, result: "built" });
    const inode = statSync(out).ino;

    const second = await extractSnapshot(
      { dir, out, sandbox: "none" },
      { onStage: (stage) => stages.push(stage) },
    );
    expect(stages).toHaveLength(6);
    expect(second).toEqual({
      result: "skipped",
      commit: head,
      contentHash: first.contentHash,
      gates: first.gates,
    });
    expect(statSync(out).ino).toBe(inode);
    expect(readAttempt(out)).toMatchObject({ commit: head, result: "skipped" });
    expect(readBuildFacts(out)).toEqual(facts);
    expect(readdirSync(dirname(out)).sort()).toEqual([
      "attempt.json",
      "build.json",
      "store.sqlite",
    ]);
  },
  TIMEOUT,
);

it(
  "fires each stage at its fixed point: an engine running, the temporary store written, the gates and the swap still ahead",
  async () => {
    const dir = await exportOf(await oneCommit(SKY));
    const out = storePath();
    const tmpStore = join(dirname(out), `store.tmp-${process.pid}.sqlite`);
    const seen: Array<{
      stage: string;
      attempt: string | undefined;
      tmp: boolean;
      store: boolean;
    }> = [];
    const r = await extractSnapshot(
      { dir, out, sandbox: "none" },
      {
        onStage: (stage) =>
          seen.push({
            stage,
            attempt: readAttempt(out)?.reason?.replace(/\(pid \d+\)/, "(pid)"),
            tmp: existsSync(tmpStore),
            store: existsSync(out),
          }),
      },
    );
    expect(r.result).toBe("built");
    const stage = (name: string) =>
      `interrupted or still running (pid): ${name}`;
    expect(seen).toEqual([
      {
        stage: "engine:ast-grep",
        attempt: stage("running ast-grep"),
        tmp: false,
        store: false,
      },
      {
        stage: "engine:dependency-cruiser",
        attempt: stage("running dependency-cruiser"),
        tmp: false,
        store: false,
      },
      {
        stage: "engine:scip-typescript",
        attempt: stage("running scip-typescript"),
        tmp: false,
        store: false,
      },
      {
        stage: "write-store",
        attempt: stage("writing the store"),
        tmp: true,
        store: false,
      },
      {
        stage: "gates",
        attempt: stage("checking the gates"),
        tmp: true,
        store: false,
      },
      {
        stage: "swap",
        attempt: stage("swapping the store"),
        tmp: true,
        store: false,
      },
    ]);
    expect(existsSync(tmpStore)).toBe(false);
    expect(readAttempt(out)?.result).toBe("built");
  },
  TIMEOUT,
);

it(
  "skips scip-typescript at quick detail, and binds no call",
  async () => {
    const out = storePath();
    const r = await extract(await exportOf(await oneCommit(SKY)), out, {
      detail: "quick",
    });
    expect(r.result).toBe("built");
    expect(r.gates.map((g) => g.ok)).toEqual(ALL_OK);
    expect(r.gates[2]?.detail).toBe("scip-typescript did not run");
    inStore(out, (s) => {
      expect(s.meta.detail).toBe("quick");
      expect(s.meta.coverage.tiers).toEqual({
        "ast-grep": "ran",
        "dependency-cruiser": "ran",
        grimp: "skipped",
        "scip-typescript": "skipped",
      });
      expect(
        countOf(
          s,
          "SELECT COUNT(*) AS n FROM call_targets WHERE label = 'bound'",
        ),
      ).toBe(0);
    });
    expect(readBuildFacts(out)?.engines["scip-typescript"]).toEqual({
      status: "skipped",
      wallMs: 0,
      cpuMs: null,
      peakRssBytes: null,
      exitCode: null,
    });
  },
  TIMEOUT,
);

it(
  "keeps the previous store as store.prev.sqlite",
  async () => {
    const repo = await makeRepo({
      commits: [
        { date: DATE, files: SKY },
        {
          date: "2026-03-03T10:00:00Z",
          files: {
            "web/src/sky.ts": lines(
              'import { solve } from "./orbit";',
              "export const day = solve(2);",
            ),
          },
        },
      ],
    });
    const [previous, head] = ["HEAD~1", "HEAD"].map((ref) =>
      git(repo, "rev-parse", ref),
    );
    const out = storePath();
    const before = await extract(await exportOf(repo, { ref: "HEAD~1" }), out);
    expect(before).toMatchObject({ result: "built", commit: previous });
    expect(existsSync(join(dirname(out), "store.prev.sqlite"))).toBe(false);
    const after = await extract(await exportOf(repo), out);
    expect(after).toMatchObject({ result: "built", commit: head });
    expect(inStore(out, (s) => s.meta.commit)).toBe(head);
    expect(
      inStore(join(dirname(out), "store.prev.sqlite"), (s) => [
        s.meta.commit,
        s.run.contentHash,
      ]),
    ).toEqual([previous, before.contentHash]);
    expect(readBuildFacts(out)?.commit).toBe(head);
    expect(readdirSync(dirname(out)).sort()).toEqual([
      "attempt.json",
      "build.json",
      "store.prev.sqlite",
      "store.sqlite",
    ]);
  },
  TIMEOUT,
);

it(
  "degrades when scip-typescript fails",
  async () => {
    const dir = await exportOf(await oneCommit(SKY));
    // the control: the installed engines bind the call
    const control = storePath();
    expect((await extract(dir, control)).result).toBe("built");
    expect(
      inStore(control, (s) =>
        countOf(
          s,
          "SELECT COUNT(*) AS n FROM call_targets WHERE label = 'bound'",
        ),
      ),
    ).toBe(1);

    const out = storePath();
    const r = await extract(dir, out, {
      enginesDir: brokenEnginesDir("scip-typescript"),
    });
    expect(r.result).toBe("built");
    expect(r.gates.map((g) => g.ok)).toEqual(ALL_OK);
    expect(r.gates[2]?.detail).toBe("scip-typescript did not run");
    inStore(out, (s) => {
      expect(s.meta.coverage.tiers).toEqual({
        "ast-grep": "ran",
        "dependency-cruiser": "ran",
        grimp: "skipped",
        "scip-typescript": "failed",
      });
      expect(s.meta.engines["scip-typescript"]).toBeUndefined();
      expect(
        countOf(
          s,
          "SELECT COUNT(*) AS n FROM call_targets WHERE label = 'bound'",
        ),
      ).toBe(0);
      // the call falls back to its scoped target
      expect(
        countOf(
          s,
          "SELECT COUNT(*) AS n FROM call_targets WHERE label = 'scoped'",
        ),
      ).toBe(1);
    });
    const facts = readBuildFacts(out);
    expect(statuses(facts)).toEqual({
      "ast-grep": "ran",
      "dependency-cruiser": "ran",
      grimp: "skipped",
      "scip-typescript": "failed",
    });
    expect(facts?.engines["scip-typescript"]?.exitCode).toBe(1);
    expect(facts?.warnings).toContain("scip-typescript failed: exit code 1");
  },
  TIMEOUT,
);

it(
  "degrades when dependency-cruiser fails, counting no cycle as a disagreement",
  async () => {
    // a run-time cycle between catalog.ts and planets.ts
    const repo = await oneCommit({
      "web/src/catalog.ts": lines(
        'import { planets } from "./planets";',
        "export const catalog = () => planets.length;",
      ),
      "web/src/planets.ts": lines(
        'import { catalog } from "./catalog";',
        "export const planets = [catalog];",
      ),
    });
    const out = storePath();
    const r = await extract(await exportOf(repo), out, {
      enginesDir: brokenEnginesDir("dependency-cruiser"),
    });
    expect(r.result).toBe("built");
    expect(r.gates.map((g) => g.ok)).toEqual(ALL_OK);
    inStore(out, (s) => {
      expect(s.meta.coverage.tiers).toEqual({
        "ast-grep": "ran",
        "dependency-cruiser": "failed",
        grimp: "skipped",
        "scip-typescript": "ran",
      });
      expect(s.meta.coverage.cycleDifferences).toBe(0);
      expect(countOf(s, "SELECT COUNT(*) AS n FROM cycles")).toBe(2);
      // the imports come from the first fallback, SCIP's edges, resolved
      expect(
        s.db
          .prepare("SELECT producer, resolved FROM imports ORDER BY id")
          .all(),
      ).toEqual([
        { producer: "scip-typescript", resolved: 1 },
        { producer: "scip-typescript", resolved: 1 },
      ]);
    });
    expect(statuses(readBuildFacts(out))["dependency-cruiser"]).toBe("failed");
  },
  TIMEOUT,
);

it(
  "keeps a rename of a path the profile denies out of the store",
  async () => {
    const repo = await makeRepo({
      commits: [
        {
          date: DATE,
          files: { "README.md": lines("# Sky"), "drafts/keys.txt": "k\n" },
        },
        {
          date: "2026-03-03T10:00:00Z",
          rename: ["drafts/keys.txt", "drafts/old-keys.txt"],
          files: { "docs/a.md": lines("a") },
        },
        {
          date: "2026-03-04T10:00:00Z",
          rename: ["docs/a.md", "docs/b.md"],
          files: {},
        },
      ],
    });
    const out = storePath();
    const profile = { ...DEFAULT_PROFILE, denylist: { extra: ["drafts/**"] } };
    const r = await extract(await exportOf(repo, { profile }), out);
    expect(r.result).toBe("built");
    expect(
      inStore(out, (s) =>
        s.db.prepare("SELECT old_path, new_path FROM renames").all(),
      ),
    ).toEqual([{ old_path: "docs/a.md", new_path: "docs/b.md" }]);
  },
  TIMEOUT,
);

it(
  "fails the build when ast-grep fails, leaving only the attempt",
  async () => {
    const repo = await oneCommit(SKY);
    const out = storePath();
    await expect(
      extract(await exportOf(repo), out, {
        enginesDir: brokenEnginesDir("ast-grep"),
      }),
    ).rejects.toThrow("ast-grep failed: exit code 1");
    expect(readAttempt(out)).toMatchObject({
      commit: git(repo, "rev-parse", "HEAD"),
      result: "failed",
      reason: "ast-grep failed: exit code 1",
    });
    expect(readdirSync(dirname(out))).toEqual(["attempt.json"]);
  },
  TIMEOUT,
);

it(
  "keeps host paths and secrets out of a failed build's attempt, naming each directory by token",
  async () => {
    const repo = await oneCommit(SKY);
    const dir = await exportOf(repo);
    const out = storePath();
    // assembled here, never written whole
    const secret = ["gh", "p_", "Q7x2M4p9K3l8N5r6".repeat(3)].join("");
    const enginesDir = standInEnginesDir("ast-grep", {
      sh: `#!/bin/sh\necho "cannot scan $*; token=${secret}" >&2\nexit 2\n`,
    });
    await expect(extract(dir, out, { enginesDir })).rejects.toThrow(
      /^ast-grep failed: exit code 2\ncannot scan scan --config <export>\/sgconfig\.yml /,
    );
    const reason = readAttempt(out)?.reason ?? "";
    expect(reason).toMatch(
      /^ast-grep failed: exit code 2\ncannot scan scan --config <export>\/sgconfig\.yml .* <snapshot>; token=«redacted:github-token»$/,
    );
    expect(reason).not.toContain(dirname(dir));
    expect(reason).not.toContain(secret);
    // any error the build records is cleaned, not only an engine's: here a hook's, which
    // names the snapshot
    await expect(
      extractSnapshot(
        { dir, out, sandbox: "none" },
        {
          onStage: () => {
            throw new Error(`stopped at ${join(dir, "snapshot", "web")}`);
          },
        },
      ),
    ).rejects.toThrow("stopped at");
    expect(readAttempt(out)?.reason).toBe("stopped at <snapshot>/web");
  },
  TIMEOUT,
);

it(
  "keeps host paths out of build.json's warnings, as a driver's own message names them",
  async () => {
    const repo = await oneCommit(SKY);
    const out = storePath();
    // dependency-cruiser leaves no output, so its driver cannot read the file it names
    const enginesDir = standInEnginesDir("dependency-cruiser", {
      node: 'import { rmSync } from "node:fs";\nrmSync("depcruise.out.json");\n',
    });
    expect(
      (await extract(await exportOf(repo), out, { enginesDir })).result,
    ).toBe("built");
    const warnings = readBuildFacts(out)?.warnings ?? [];
    expect(warnings).toContain(
      "dependency-cruiser failed: cannot read its output (ENOENT: no such file or directory, open '<work>/depcruise.out.json')",
    );
    expect(warnings.join("\n")).not.toContain(dirname(out));
  },
  TIMEOUT,
);

it(
  "refuses --sandbox require where no sandbox works, naming each repair with its probe's evidence",
  async () => {
    const repo = await oneCommit(SKY);
    const dir = await exportOf(repo);
    const out = storePath();
    // neither bwrap nor systemd-run on the PATH, probed afresh
    vi.stubEnv("PATH", tmp());
    try {
      vi.resetModules();
      const fresh = await import("../../../src/extract/index.js");
      const refusal = [
        "--sandbox require: no sandbox: bubblewrap is not installed; no user manager can be reached",
        "bwrap: could not start: ENOENT",
        "systemd-run: could not start: ENOENT",
      ].join("\n");
      await expect(
        fresh.extractSnapshot({ dir, out, sandbox: "require" }),
      ).rejects.toThrow(refusal);
      expect(readAttempt(out)?.reason).toBe(refusal);
    } finally {
      vi.unstubAllEnvs();
    }
  },
  TIMEOUT,
);

it(
  "stores a secret-shaped package name and link target redacted, and the redaction gate stays green",
  async () => {
    // assembled here, never written whole
    const secret = ["gh", "p_", "Q7x2M4p9K3l8N5r6".repeat(3)].join("");
    const repo = await oneCommit({
      ...SKY,
      "web/src/vault.ts": lines(
        `import key from "${secret}";`,
        "export { key };",
      ),
      "keys/current": { link: `../vault/${secret}` },
    });
    const out = storePath();
    const r = await extract(await exportOf(repo), out);
    expect(r.result).toBe("built");
    expect(r.gates.map((g) => g.ok)).toEqual(ALL_OK);
    inStore(out, (s) => {
      expect(
        s.db.prepare("SELECT ecosystem, name FROM externals").all(),
      ).toEqual([{ ecosystem: "npm", name: "«redacted:github-token»" }]);
      expect(
        s.db
          .prepare("SELECT link_target FROM files WHERE path = 'keys/current'")
          .get(),
      ).toEqual({ link_target: "../vault/«redacted:github-token»" });
    });
  },
  TIMEOUT,
);

it(
  "records a tier that ran out of memory with its repair, and rebuilds over it only at another memory cap",
  async () => {
    const repo = await oneCommit(SKY);
    const dir = await exportOf(repo);
    const out = storePath();
    // Node's own words, then the exit code an abort has through a shell, with no core dumped
    const enginesDir = standInEnginesDir("scip-typescript", {
      node: 'process.stderr.write("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\\n"); process.exit(134);\n',
    });
    const repair =
      "ran out of JavaScript heap; rebuild with a larger --memory-max";
    expect((await extract(dir, out, { enginesDir })).result).toBe("built");
    inStore(out, (s) => {
      expect(s.meta.coverage.tiers["scip-typescript"]).toBe("failed");
      expect(s.meta.coverage.outOfMemory).toEqual({
        memoryMax: "3G",
        tiers: { "scip-typescript": repair },
      });
      expect(compilerTier(s, "typescript")).toEqual({
        ran: false,
        reason: `scip-typescript ${repair}`,
      });
    });
    const facts = readBuildFacts(out);
    expect(statuses(facts)["scip-typescript"]).toBe("failed");
    expect(facts?.warnings).toContain(
      `scip-typescript failed: ${repair}\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`,
    );
    // the same cap would end the same way, so that build is skipped; another one is built
    expect((await extract(dir, out, { enginesDir })).result).toBe("skipped");
    expect(
      (await extract(dir, out, { enginesDir, memoryMax: "4G" })).result,
    ).toBe("built");
    inStore(out, (s) =>
      expect(s.meta.coverage.outOfMemory?.memoryMax).toBe("4G"),
    );
  },
  TIMEOUT,
);

it(
  "records an engine that passed its timeout as timed-out, and one that exited non-zero as failed",
  async () => {
    const repo = await oneCommit(SKY);
    const dir = await exportOf(repo);
    // at quick detail ast-grep and dependency-cruiser run, and scip-typescript does not
    const build = (enginesDir: string, out: string) =>
      extractSnapshot(
        { dir, out, sandbox: "none", detail: "quick", enginesDir },
        { engineTimeoutMs: 2000 },
      );
    const hung = storePath();
    const r = await build(
      standInEnginesDir("dependency-cruiser", {
        node: "setTimeout(() => {}, 60000);\n",
      }),
      hung,
    );
    expect(r.result).toBe("built");
    const facts = readBuildFacts(hung);
    expect(statuses(facts)).toEqual({
      "ast-grep": "ran",
      "dependency-cruiser": "timed-out",
      grimp: "skipped",
      "scip-typescript": "skipped",
    });
    expect(facts?.warnings).toContain(
      "dependency-cruiser failed: timed out after 2 s",
    );
    inStore(hung, (s) =>
      expect(s.meta.coverage.tiers["dependency-cruiser"]).toBe("failed"),
    );
    // the control: within the same timeout, an engine that exits 1 failed
    const broken = storePath();
    await build(brokenEnginesDir("dependency-cruiser"), broken);
    expect(statuses(readBuildFacts(broken))["dependency-cruiser"]).toBe(
      "failed",
    );
  },
  TIMEOUT,
);

it(
  "fails the gate when unresolved imports grow from the current store, which keeps serving",
  async () => {
    // a limit of 100%, so that only the growth can fail
    const profile = {
      ...DEFAULT_PROFILE,
      gates: { maxUnresolvedRelativeImports: 1 },
    };
    const repo = await makeRepo({
      commits: [
        { date: DATE, files: SKY },
        {
          date: "2026-03-03T10:00:00Z",
          files: {
            "web/src/legend.ts": lines(
              'import { solve } from "./orbit";',
              'import { label } from "./labels";',
              "export const text = label(solve(3));",
            ),
          },
        },
      ],
    });
    const out = storePath();
    const before = await extract(
      await exportOf(repo, { ref: "HEAD~1", profile }),
      out,
    );
    expect(before.result).toBe("built");
    expect(inStore(out, (s) => s.meta.coverage.unresolvedImports)).toBe(0);
    const after = await extract(await exportOf(repo, { profile }), out);
    const reason =
      "unresolved-imports: 1 unresolved relative imports, up from 0 in the current store";
    expect(after).toMatchObject({
      result: "gates-failed",
      contentHash: null,
      reason,
    });
    expect(inStore(out, (s) => s.run.contentHash)).toBe(before.contentHash);
    expect(readAttempt(out)).toMatchObject({ result: "gates-failed", reason });
    expect(readBuildFacts(out)?.contentHash).toBe(before.contentHash);
    expect(readdirSync(dirname(out)).sort()).toEqual([
      "attempt.json",
      "build.json",
      "store.sqlite",
    ]);
  },
  TIMEOUT,
);

it(
  "builds a Python-only repo, a docs-only repo and an empty repo",
  async () => {
    const skipped = {
      "ast-grep": "skipped",
      "dependency-cruiser": "skipped",
      grimp: "skipped",
      "scip-typescript": "skipped",
    };
    const cases: Array<{
      name: string;
      files: RepoSpec["commits"][number]["files"];
      tiers: Record<string, string>;
      pythonResolver: string;
      indexed: string;
    }> = [
      {
        name: "python",
        files: EPHEMERIS,
        tiers: { ...skipped, "ast-grep": "ran", grimp: "ran" },
        pythonResolver: "grimp",
        indexed: "python 3/3",
      },
      {
        name: "docs",
        files: {
          "README.md": lines("# Observatory"),
          "docs/guide.md": lines("Point the telescope north."),
        },
        tiers: skipped,
        pythonResolver: "none",
        indexed: "no TypeScript, JavaScript or Python files",
      },
      {
        name: "empty",
        files: {},
        tiers: skipped,
        pythonResolver: "none",
        indexed: "no TypeScript, JavaScript or Python files",
      },
    ];
    for (const c of cases) {
      const repo = await oneCommit(c.files);
      const out = storePath();
      const r = await extract(await exportOf(repo), out);
      expect(r.result, c.name).toBe("built");
      expect(
        r.gates.map((g) => g.ok),
        c.name,
      ).toEqual(ALL_OK);
      expect(r.gates[0]?.detail, c.name).toBe(c.indexed);
      inStore(out, (s) => {
        expect(s.meta.coverage.tiers, c.name).toEqual(c.tiers);
        expect(s.meta.coverage.pythonResolver, c.name).toBe(c.pythonResolver);
        expect(countOf(s, "SELECT COUNT(*) AS n FROM files"), c.name).toBe(
          Object.keys(c.files).length,
        );
      });
      expect(statuses(readBuildFacts(out)), c.name).toEqual(c.tiers);
    }
    // the empty repo's tree is empty
    const empty = await oneCommit({});
    expect(git(empty, "ls-tree", "-r", "HEAD")).toBe("");
  },
  TIMEOUT,
);

it(
  "falls back to hakutaku's resolver without Python",
  async () => {
    const dir = await exportOf(await oneCommit(EPHEMERIS));
    const imports = (path: string) =>
      inStore(path, (s) =>
        s.db
          .prepare(
            "SELECT f.path AS src, d.path AS dst, i.producer AS producer FROM imports i JOIN files f ON f.id = i.src_file_id LEFT JOIN files d ON d.id = i.dst_file_id ORDER BY i.id",
          )
          .all(),
      );
    // the control: with Python, grimp resolves them
    const control = storePath();
    expect((await extract(dir, control)).result).toBe("built");
    expect(imports(control)).toEqual([
      {
        src: "sim/src/observatory/__init__.py",
        dst: "sim/src/observatory/orbit.py",
        producer: "grimp",
      },
      {
        src: "sim/src/observatory/orbit.py",
        dst: "sim/src/observatory/units.py",
        producer: "grimp",
      },
    ]);

    const out = storePath();
    const r = await extract(dir, out, {
      enginesDir: enginesDirWithoutPython(),
    });
    expect(r.result).toBe("built");
    expect(r.gates.map((g) => g.ok)).toEqual(ALL_OK);
    inStore(out, (s) => {
      expect(s.meta.coverage.pythonResolver).toBe("hakutaku-resolver");
      expect(s.meta.coverage.tiers).toEqual({
        "ast-grep": "ran",
        "dependency-cruiser": "skipped",
        grimp: "fallback",
        "scip-typescript": "skipped",
      });
      expect(s.meta.coverage.unresolvedImports).toBe(0);
    });
    expect(imports(out)).toEqual([
      {
        src: "sim/src/observatory/__init__.py",
        dst: "sim/src/observatory/orbit.py",
        producer: "hakutaku-resolver",
      },
      {
        src: "sim/src/observatory/orbit.py",
        dst: "sim/src/observatory/units.py",
        producer: "hakutaku-resolver",
      },
    ]);
    expect(readBuildFacts(out)?.engines.grimp).toEqual({
      status: "fallback",
      wallMs: 0,
      cpuMs: null,
      peakRssBytes: null,
      exitCode: null,
    });
  },
  TIMEOUT,
);

it(
  "prints one ExtractResult line and exits 3 when the gates fail",
  async () => {
    const repo = await oneCommit({
      "web/src/sky.ts": lines(
        'import { solve } from "./missing";',
        "export const day = solve(1);",
      ),
    });
    const head = git(repo, "rev-parse", "HEAD");
    const dir = await exportOf(repo, {
      profile: {
        ...DEFAULT_PROFILE,
        gates: { maxUnresolvedRelativeImports: 0 },
      },
    });
    const out = storePath();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["extract", dir, "--out", out, "--sandbox", "none"],
      {
        stdout: (s) => void stdout.push(s),
        stderr: (s) => void stderr.push(s),
        stdin: process.stdin,
        env: {},
        isTTY: false,
      },
    );
    expect(stderr).toEqual([]);
    expect(code).toBe(3);
    const text = stdout.join("");
    expect(text.indexOf("\n")).toBe(text.length - 1);
    const reason =
      "unresolved-imports: 1 of 1 relative imports unresolved (100.00%); limit 0.00%";
    const result = JSON.parse(text);
    expect(Object.keys(result)).toEqual([
      "result",
      "commit",
      "contentHash",
      "reason",
      "gates",
    ]);
    expect(result).toMatchObject({
      result: "gates-failed",
      commit: head,
      contentHash: null,
      reason,
    });
    expect(result.gates.map((g: { ok: boolean }) => g.ok)).toEqual([
      true,
      false,
      true,
      true,
      true,
    ]);
    expect(readAttempt(out)).toMatchObject({
      commit: head,
      result: "gates-failed",
      reason,
    });
    // nothing was swapped in, and nothing was left behind
    expect(readdirSync(dirname(out))).toEqual(["attempt.json"]);
  },
  TIMEOUT,
);

// Whether bubblewrap, and systemd-run beside it, work here.
const works = (argv: string[]): boolean =>
  process.platform === "linux" &&
  spawnSync(argv[0] ?? "", argv.slice(1), { stdio: "ignore", timeout: 30_000 })
    .status === 0;
const bwrapWorks = works([
  "bwrap",
  "--unshare-all",
  "--die-with-parent",
  "--ro-bind",
  "/",
  "/",
  "true",
]);
const systemdRunWorks = works([
  "systemd-run",
  "--user",
  "--wait",
  "--quiet",
  "--collect",
  "-p",
  "PrivateNetwork=yes",
  "true",
]);

it.runIf(bwrapWorks)(
  "builds the same store inside bubblewrap, and says so in build.json",
  async () => {
    const dir = await exportOf(await oneCommit({ ...SKY, ...EPHEMERIS }));
    const plain = storePath();
    const unsandboxed = await extract(dir, plain);
    expect(unsandboxed.result).toBe("built");

    const out = storePath();
    const r = await extract(dir, out, { sandbox: "require" });
    expect(r).toEqual({ ...unsandboxed });
    const facts = readBuildFacts(out);
    expect(facts?.sandbox).toBe("bubblewrap");
    expect(statuses(facts)).toEqual({
      "ast-grep": "ran",
      "dependency-cruiser": "ran",
      grimp: "ran",
      "scip-typescript": "ran",
    });
    if (systemdRunWorks) {
      // the scope that caps bubblewrap's memory is read from outside it
      expect(facts?.peakRssBytes).toBeGreaterThan(0);
      expect(facts?.warnings).not.toContain(
        "no memory cap: systemd-run is unavailable",
      );
    } else {
      expect(facts?.peakRssBytes).toBeNull();
      expect(facts?.warnings).toContain(
        "no memory cap: systemd-run is unavailable",
      );
    }
    // the build ran as pid 2 of bubblewrap's namespace, and left nothing behind
    expect(readdirSync(dirname(out)).sort()).toEqual([
      "attempt.json",
      "build.json",
      "store.sqlite",
    ]);
  },
  TIMEOUT,
);

it.runIf(bwrapWorks)(
  "fails a sandboxed build on a snapshot entry that is not a regular file, saying so once",
  async () => {
    const dir = await exportOf(await oneCommit(EPHEMERIS));
    // export writes regular files only: a link planted in its place is refused, never followed
    const file = join(dir, "snapshot", "sim", "src", "observatory", "units.py");
    chmodSync(dirname(file), 0o755);
    rmSync(file);
    symlinkSync("/etc/hostname", file);
    chmodSync(dirname(file), 0o555);
    const out = storePath();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["extract", dir, "--out", out, "--sandbox", "require"],
      {
        stdout: (s) => void stdout.push(s),
        stderr: (s) => void stderr.push(s),
        stdin: process.stdin,
        env: {},
        isTTY: false,
      },
    );
    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    // the sandboxed run printed its message on the stderr passed through; it is not repeated
    expect(stderr).toEqual([]);
    const reason =
      "the snapshot's sim/src/observatory/units.py is not a regular file";
    expect(readAttempt(out)).toMatchObject({ result: "failed", reason });
    expect(readdirSync(dirname(out))).toEqual(["attempt.json"]);
  },
  TIMEOUT,
);
