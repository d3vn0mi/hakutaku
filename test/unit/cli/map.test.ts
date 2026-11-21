// What hakutaku map says on stderr, up to the build: each test points the XDG variables at a
// fresh root whose config directory is named with HOSTILE, so that the path of the profile map
// names holds it, and the build itself is a stand-in that these tests never get past. The
// engines are stand-ins too, which verify.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CliIO } from "../../../src/cli/commands/index.js";
import { main } from "../../../src/cli/main.js";
import { removeTree } from "../../../src/export/index.js";
import { profilePathFor } from "../../../src/registry/index.js";
import { makeRepo } from "../../helpers/git.js";
import { HOSTILE, HOSTILE_SHOWN, rawLines } from "../../helpers/terminal.js";
import { fakeInstall } from "../engines/fake.js";

const extractSnapshot = vi.hoisted(() => vi.fn());
vi.mock("../../../src/extract/index.js", () => ({ extractSnapshot }));

const USAGE =
  "usage: hakutaku map <repo> [--id <id>] [--ref <ref>] [--detail quick|standard|deep] [--no-source] [--no-snippets] [--sandbox auto|require|none] [--engines-dir <path>] [--yes]\n";

const DATE = "2026-09-01T12:00:00Z";

const roots: string[] = [];
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "hakutaku-cli-map-"));
  roots.push(root);
  vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
  vi.stubEnv("XDG_CONFIG_HOME", join(root, HOSTILE));
  vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  extractSnapshot.mockReset();
});
afterAll(() => {
  for (const root of roots.splice(0)) removeTree(root);
});

async function run(
  argv: string[],
): Promise<{ code: number; out: string; err: string }> {
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
    env: {},
    isTTY: false,
  };
  const code = await main(["map", ...argv], io);
  return { code, out, err };
}

// A path that holds HOSTILE, as a terminal is shown it.
const shown = (path: string): string => path.replace(HOSTILE, HOSTILE_SHOWN);

// An option it does not take is named as given; a value it does not take, through
// JSON.stringify, which writes ESC as an escape and leaves the rest.
it("says a usage error on lines safe for a terminal", async () => {
  for (const [argv, text] of [
    [[`--${HOSTILE}`], HOSTILE_SHOWN],
    [["repo", "--detail", HOSTILE], "[2J?31m; ?map"],
    [["repo", "--sandbox", HOSTILE], "[2J?31m; ?map"],
    [["repo", "--id", HOSTILE], "[2J?31m; ?map"],
  ] as const) {
    const r = await run([...argv]);
    expect([argv, r.code]).toEqual([argv, 2]);
    expect(r.err).toMatch(/^hakutaku map: .+\n/);
    expect(r.err).toContain(text);
    expect(r.err.endsWith(USAGE)).toBe(true);
    expect(rawLines(r.err)).toEqual([]);
  }
});

it("names the profile to edit on a line safe for a terminal when generation finds conflicts", async () => {
  const repo = await makeRepo({
    commits: [
      {
        date: DATE,
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
    repo,
    "--id",
    "skychart",
    "--engines-dir",
    fakeInstall(),
  ]);
  expect(r.code).toBe(1);
  expect(r.err.split("\n").at(-2)).toBe(
    `name one in the profile: ${shown(profilePathFor("skychart"))}`,
  );
  expect(rawLines(r.err)).toEqual([]);
  expect(extractSnapshot).not.toHaveBeenCalled();
});

it("names the profile it wrote on a line safe for a terminal", async () => {
  extractSnapshot.mockRejectedValueOnce(new Error("the build is a stand-in"));
  const repo = await makeRepo({
    commits: [
      { date: DATE, files: { "src/sky.ts": "export const sky = 1;\n" } },
    ],
  });
  const r = await run([
    repo,
    "--id",
    "skychart",
    "--engines-dir",
    fakeInstall(),
  ]);
  expect(r.err).toContain(`\nwrote ${shown(profilePathFor("skychart"))}\n`);
  expect(rawLines(r.err)).toEqual([]);
  expect(r.err.endsWith("hakutaku: the build is a stand-in\n")).toBe(true);
  expect(r.code).toBe(1);
});
