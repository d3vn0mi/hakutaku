// A deliberately broken profile fails a gate, and the store the build would have replaced keeps
// serving, with the failure recorded as the last attempt. Both cases first build the sample
// normally into a fresh store, then build the same commit again from a broken export: one whose
// profile has no Python root, and one whose TypeScript and dependency-cruiser configs resolve
// nodenext-style, where a relative specifier must name its file's extension. Each broken export
// is made with a copy of the sample's profile; its rules file is named outright, since a
// profile's rules path is read from the profile's own directory. The tests need the Python the
// engines were installed with, so that the first build runs every engine: where it does not
// start, they are skipped, and in CI they fail. Run `node dist/cli/main.js engines install
// --yes` once.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { defaultEnginesDir } from "../../../src/engines/index.js";
import { exportRepo, removeTree } from "../../../src/export/index.js";
import {
  type ExtractResult,
  extractSnapshot,
} from "../../../src/extract/index.js";
import { openStore, readAttempt } from "../../../src/store/index.js";
import { git } from "../../helpers/git.js";
import { requireInCI } from "../../helpers/live.js";
import { samplePythonProbe, sampleRepo } from "../../helpers/sample.js";

const TIMEOUT = 300_000;
const SAMPLE = fileURLToPath(
  new URL("../../../fixtures/observatory/", import.meta.url),
);
const PROFILE = join(SAMPLE, "profile.json");
const RULES = join(SAMPLE, "rules.json");
const ENGINES_DIR = defaultEnginesDir();
const PYTHON = samplePythonProbe();

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) removeTree(dir);
});

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-oracle-broken-profile-"));
  made.push(dir);
  return dir;
};

const extract = (dir: string, out: string): Promise<ExtractResult> =>
  extractSnapshot({ dir, out, enginesDir: ENGINES_DIR, sandbox: "none" });

// The sample's main branch, exported with the profile at profile (the sample's own when
// absent) into a fresh directory.
async function exportOf(profile?: string): Promise<string> {
  const out = join(tmp(), "export");
  await exportRepo({
    repo: await sampleRepo(),
    ref: "main",
    out,
    id: "observatory",
    profile: profile ?? PROFILE,
    ...(profile === undefined ? {} : { rules: RULES }),
  });
  return out;
}

// A copy of the sample's profile, written as JSON after change has edited it.
function profileCopy(
  change: (profile: { python: { roots: string[] } }) => void,
): string {
  const profile = JSON.parse(readFileSync(PROFILE, "utf8"));
  change(profile);
  const path = join(tmp(), "profile.json");
  writeFileSync(path, `${JSON.stringify(profile)}\n`);
  return path;
}

// Rewrites the JSON file at path, with change applied to its value.
function edit<T>(path: string, change: (value: T) => void): void {
  const value = JSON.parse(readFileSync(path, "utf8")) as T;
  change(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function commitOf(path: string): string {
  const store = openStore(path);
  if ("code" in store) throw new Error(`${path}: ${store.reason}`);
  try {
    return store.meta.commit;
  } finally {
    store.close();
  }
}

// The sample built normally into a fresh store, checked engine by engine: the store's path and
// the commit it holds.
async function builtStore(): Promise<{ store: string; head: string }> {
  const store = join(tmp(), "store", "store.sqlite");
  const r = await extract(await exportOf(), store);
  expect(r.result).toBe("built");
  const s = openStore(store);
  if ("code" in s) throw new Error(`${store}: ${s.reason}`);
  try {
    expect(s.meta.coverage.tiers).toEqual({
      "ast-grep": "ran",
      "dependency-cruiser": "ran",
      grimp: "ran",
      "scip-typescript": "ran",
      "scip-python": "skipped",
    });
  } finally {
    s.close();
  }
  const head = git(await sampleRepo(), "rev-parse", "HEAD");
  expect(commitOf(store)).toBe(head);
  return { store, head };
}

it(
  "fails the gate for a missing Python root and keeps the previous store",
  async (ctx) => {
    requireInCI(ctx, PYTHON);
    const { store, head } = await builtStore();
    const broken = await exportOf(
      profileCopy((profile) => {
        profile.python.roots = [];
      }),
    );
    const r = await extract(broken, store);
    expect(r.result).toBe("gates-failed");
    expect(r.gates.find((g) => g.gate === "files-indexed")).toMatchObject({
      ok: false,
      detail: expect.stringMatching(
        /^python \d+\/\d+: missing sim\/src\/observatory\//,
      ),
    });
    expect(commitOf(store)).toBe(head);
    expect(readAttempt(store)).toMatchObject({
      commit: head,
      result: "gates-failed",
      reason: expect.stringContaining("files-indexed: python"),
    });
  },
  TIMEOUT,
);

it(
  "fails the gate for nodenext-style resolution and keeps the previous store",
  async (ctx) => {
    requireInCI(ctx, PYTHON);
    const { store, head } = await builtStore();
    // The profile is unchanged in meaning, but its copy is written with other bytes: the skip
    // key holds the profile's bytes, not the generated configs', so a build of the same commit
    // and profile would be skipped as the store already in place.
    const broken = await exportOf(profileCopy(() => {}));
    edit<{ compilerOptions: Record<string, unknown> }>(
      join(broken, "tsconfig.json"),
      ({ compilerOptions }) => {
        compilerOptions.module = "nodenext";
        compilerOptions.moduleResolution = "nodenext";
      },
    );
    edit<{ options: { enhancedResolveOptions: { extensions: string[] } } }>(
      join(broken, "depcruise.json"),
      ({ options }) => {
        options.enhancedResolveOptions.extensions = [];
      },
    );
    const r = await extract(broken, store);
    expect(r.result).toBe("gates-failed");
    expect(r.gates.find((g) => g.gate === "unresolved-imports")?.ok).toBe(
      false,
    );
    expect(commitOf(store)).toBe(head);
    expect(readAttempt(store)).toMatchObject({
      commit: head,
      result: "gates-failed",
      reason: expect.stringContaining("unresolved-imports: "),
    });
  },
  TIMEOUT,
);
