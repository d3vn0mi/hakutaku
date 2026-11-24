// hakutaku map on the sample, end to end, through main(argv, io). Each test points the XDG
// variables at a fresh root, as the registry's helpers read them. The installed engines are read
// when this file loads, before the variables move, and passed with --engines-dir: the fresh root
// holds none, and map would install them there. Run `node dist/cli/main.js engines install --yes`
// once before this file.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CliIO } from "../../../src/cli/commands/index.js";
import { main } from "../../../src/cli/main.js";
import { defaultEnginesDir } from "../../../src/engines/index.js";
import { removeTree } from "../../../src/export/index.js";
import {
  exportDirFor,
  findEntry,
  hakutakuDirs,
  profilePathFor,
  storePathFor,
} from "../../../src/registry/index.js";
import { openStore } from "../../../src/store/index.js";
import { git, makeRepo } from "../../helpers/git.js";
import { requireInCI } from "../../helpers/live.js";
import { samplePythonProbe, sampleRepo } from "../../helpers/sample.js";

const TIMEOUT = 300_000;
const ENGINES_DIR = defaultEnginesDir();
const PYTHON = samplePythonProbe();

const roots: string[] = [];
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "hakutaku-map-"));
  roots.push(root);
  vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(() => {
  for (const root of roots.splice(0)) removeTree(root);
});

// Runs one command; out is its stdout's lines, err its whole stderr.
async function run(
  argv: string[],
): Promise<{ code: number; out: string[]; err: string }> {
  let out = "";
  let err = "";
  const io: CliIO = {
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    stdin: new PassThrough(),
    env: process.env,
    isTTY: false,
  };
  const code = await main(argv, io);
  return {
    code,
    out: out === "" ? [] : out.replace(/\n$/, "").split("\n"),
    err,
  };
}

// The commands named next: view, then mcp, in one column.
const NEXT = [
  "next  hakutaku view observatory    the map, in your browser",
  "      hakutaku mcp observatory     the tools, for an agent",
];

// The summary's built line, found by its name: a python line follows it where grimp did not run.
const builtLine = (out: string[]): string | undefined =>
  out.find((line) => line.startsWith("  built "));

it(
  "maps the sample end to end and registers it",
  async (ctx) => {
    requireInCI(ctx, PYTHON);
    const repo = await sampleRepo();
    const head = git(repo, "rev-parse", "HEAD");
    // an export of another commit, which the build removes
    const stale = exportDirFor("observatory", "0".repeat(40));
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "export.json"), "{}\n");

    const first = await run([
      "map",
      repo,
      "--id",
      "observatory",
      "--sandbox",
      "none",
      "--yes",
      "--engines-dir",
      ENGINES_DIR,
    ]);
    expect(first.code, first.err).toBe(0);
    expect(first.out[0]).toMatch(
      /^hakutaku \d+\.\d+\.\d+ \u00b7 observatory at [0-9a-f]{12} \(HEAD\), standard detail$/,
    );
    expect(first.out[0]).toContain(` at ${head.slice(0, 12)} (HEAD)`);
    // six more lines, then the view and mcp lines; no python line, since grimp read the imports
    expect(first.out.slice(1).map((line) => line.slice(0, 13))).toEqual([
      "  files      ",
      "  imports    ",
      "  callers    ",
      "  entry      ",
      "  core       ",
      "  built      ",
      "next  hakutak",
      "      hakutak",
    ]);
    expect(first.out[6]).toMatch(
      /^ {2}built {6}\d+ s \u00b7 peak \? \u00b7 store \d+\.\d MB \u00b7 sandbox: none$/,
    );
    expect(first.out.slice(-2)).toEqual(NEXT);
    // the profile was generated, written for review byte for byte, and said on stderr
    const profile = profilePathFor("observatory");
    expect(readFileSync(profile)).toEqual(
      readFileSync(join(exportDirFor("observatory", head), "profile.json")),
    );
    expect(first.err).toMatch(
      /^aliases \d+ \u00b7 python roots sim\/src \u00b7 components .+ \u00b7 launch manifests \d+$/m,
    );
    expect(first.err).toContain(`wrote ${profile}\n`);
    expect(findEntry("observatory")).toEqual({
      id: "observatory",
      source: realpathSync(repo),
      ref: "HEAD",
      detail: "standard",
      noSource: false,
      snippets: true,
      profile,
    });
    expect(findEntry("observatory")?.detail).toBe("standard");
    // the store is in place at HEAD, and only this commit's export is left
    const store = openStore(storePathFor("observatory"));
    if ("code" in store) throw new Error(store.reason);
    try {
      expect(store.meta.commit).toBe(head);
      expect(store.meta.coverage.pythonResolver).toBe("grimp");
    } finally {
      store.close();
    }
    expect(readdirSync(dirname(stale))).toEqual([head]);

    // a path already registered keeps its entry's settings: the same id, ref and profile
    const second = await run([
      "map",
      repo,
      "--sandbox",
      "none",
      "--engines-dir",
      ENGINES_DIR,
    ]);
    expect(second.code, second.err).toBe(0);
    expect(builtLine(second.out)).toMatch(
      /^ {2}built {6}skipped: the store at [0-9a-f]{12} is current$/,
    );
    expect(builtLine(second.out)).toContain(head.slice(0, 12));
    expect(second.out.slice(-2)).toEqual(NEXT);
    expect(second.out.slice(0, 6)).toEqual(first.out.slice(0, 6));
    expect(second.err).not.toContain("wrote ");
  },
  TIMEOUT,
);

it(
  "exits 1 naming the profile when generation finds conflicts",
  async () => {
    const repo = await makeRepo({
      commits: [
        {
          date: "2026-09-01T12:00:00Z",
          files: {
            "a/package.json": '{ "name": "@obs/core", "main": "src/index.ts" }',
            "a/src/index.ts": "export const core = 1;\n",
            "b/package.json": '{ "name": "@obs/core", "main": "src/index.ts" }',
            "b/src/index.ts": "export const core = 2;\n",
          },
        },
      ],
    });
    const r = await run([
      "map",
      repo,
      "--id",
      "skychart",
      "--sandbox",
      "none",
      "--engines-dir",
      ENGINES_DIR,
    ]);
    expect(r.code).toBe(1);
    const profile = profilePathFor("skychart");
    expect(r.err).toBe(
      [
        'two packages export "@obs/core": a/src/index.ts and b/src/index.ts; name one in the profile',
        'two packages export "@obs/core/*": a/src/* and b/src/*; name one in the profile',
        `name one in the profile: ${profile}`,
        "",
      ].join("\n"),
    );
    expect(r.out).toEqual([]);
    // nothing written: no profile, no entry, no store, and the export removed itself
    expect(existsSync(profile)).toBe(false);
    expect(findEntry("skychart")).toBeNull();
    expect(existsSync(dirname(storePathFor("skychart")))).toBe(false);
    expect(
      readdirSync(join(hakutakuDirs().cache, "exports", "skychart")),
    ).toEqual([]);
  },
  TIMEOUT,
);

// The profile at path with no Python root, so that no Python file is indexed and a gate fails.
function withoutPythonRoots(path: string, into: string): void {
  const profile = JSON.parse(readFileSync(path, "utf8"));
  profile.python.roots = [];
  mkdirSync(dirname(into), { recursive: true });
  writeFileSync(into, `${JSON.stringify(profile, null, 2)}\n`);
}

it(
  "exits 3 when the gates fail, saying whether a previous store keeps serving",
  async (ctx) => {
    requireInCI(ctx, PYTHON);
    const repo = await sampleRepo();
    const head = git(repo, "rev-parse", "HEAD");
    const argv = ["--sandbox", "none", "--engines-dir", ENGINES_DIR];
    const built = await run(["map", repo, "--id", "observatory", ...argv]);
    expect(built.code, built.err).toBe(0);
    const profile = profilePathFor("observatory");

    // a first build of another id, with a broken profile: no store was there before
    withoutPythonRoots(profile, profilePathFor("skychart"));
    const first = await run(["map", repo, "--id", "skychart", ...argv]);
    expect(first.code, first.err).toBe(3);
    expect(first.out).toEqual([]);
    expect(first.err).toMatch(/^gates failed: .+; no store is built yet\n$/);
    expect(existsSync(storePathFor("skychart"))).toBe(false);

    // the registered repo, with its profile broken: its store stays in place
    withoutPythonRoots(profile, profile);
    const again = await run(["map", repo, ...argv]);
    expect(again.code, again.err).toBe(3);
    expect(again.out).toEqual([]);
    expect(again.err).toMatch(
      /^gates failed: .+; the previous store keeps serving\n$/,
    );
    const store = openStore(storePathFor("observatory"));
    if ("code" in store) throw new Error(store.reason);
    try {
      expect(store.meta.commit).toBe(head);
    } finally {
      store.close();
    }
  },
  TIMEOUT,
);

it(
  "warns that freshness will read unknown where the ref files cannot name the ref",
  async () => {
    const repo = await sampleRepo();
    const prev = git(repo, "rev-parse", "HEAD~1");
    const r = await run([
      "map",
      repo,
      "--id",
      "sky",
      "--ref",
      "HEAD~1",
      "--detail",
      "quick",
      "--no-snippets",
      "--sandbox",
      "none",
      "--engines-dir",
      ENGINES_DIR,
    ]);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain(
      "hakutaku: the freshness of sky will read unknown: cannot resolve HEAD~1 from ref files\n",
    );
    expect(r.out[0]).toContain(
      `sky at ${prev.slice(0, 12)} (HEAD~1), quick detail`,
    );
    expect(findEntry("sky")).toMatchObject({
      ref: "HEAD~1",
      detail: "quick",
      snippets: false,
    });
    // map on the same path again, with no flag: the entry's id, ref and detail, so the store is
    // current; its snippets setting stays as it was
    const again = await run([
      "map",
      repo,
      "--sandbox",
      "none",
      "--engines-dir",
      ENGINES_DIR,
    ]);
    expect(again.code, again.err).toBe(0);
    expect(again.out[0]).toContain(
      `sky at ${prev.slice(0, 12)} (HEAD~1), quick detail`,
    );
    expect(builtLine(again.out)).toBe(
      `  built      skipped: the store at ${prev.slice(0, 12)} is current`,
    );
    expect(findEntry("sky")?.snippets).toBe(false);
    expect(findEntry("observatory")).toBeNull();
  },
  TIMEOUT,
);

// A data, config and cache directory reached through a symbolic link, as every directory under
// macOS's temporary directory is (/var is a link to /private/var), or a home on a linked mount.
// The engines name the files they resolve by their real path, so the build must read the export
// by that path too, or every relative import would leave the snapshot.
it(
  "maps the sample when hakutaku's directories are reached through a link",
  async () => {
    const repo = await sampleRepo();
    const real = mkdtempSync(join(tmpdir(), "hakutaku-map-real-"));
    roots.push(real);
    const link = `${real}-link`;
    symlinkSync(real, link);
    try {
      vi.stubEnv("XDG_DATA_HOME", join(link, "data"));
      vi.stubEnv("XDG_CONFIG_HOME", join(link, "config"));
      vi.stubEnv("XDG_CACHE_HOME", join(link, "cache"));
      const r = await run([
        "map",
        repo,
        "--id",
        "linked",
        "--detail",
        "quick",
        "--sandbox",
        "none",
        "--engines-dir",
        ENGINES_DIR,
      ]);
      expect(r.code, r.err).toBe(0);
      expect(r.out[0]).toMatch(
        / linked at [0-9a-f]{12} \(HEAD\), quick detail$/,
      );
      expect(existsSync(storePathFor("linked"))).toBe(true);
    } finally {
      unlinkSync(link);
    }
  },
  TIMEOUT,
);
