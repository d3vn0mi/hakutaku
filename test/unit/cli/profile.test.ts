import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { CliIO } from "../../../src/cli/commands/index.js";
import { main } from "../../../src/cli/main.js";
import { makeRepo } from "../../helpers/git.js";
import { HOSTILE, HOSTILE_SHOWN, rawLines } from "../../helpers/terminal.js";

const USAGE = "usage: hakutaku profile <repo> [--ref <ref>] [--out <file>]\n";

const made: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("says an option it does not take on lines safe for a terminal", async () => {
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
  expect(await main(["profile", "repo", `--${HOSTILE}`], io)).toBe(2);
  expect(err).toMatch(/^hakutaku profile: .+\n/);
  expect(err).toContain(HOSTILE_SHOWN);
  expect(err.endsWith(USAGE)).toBe(true);
  expect(rawLines(err)).toEqual([]);
  expect(out).toBe("");
});

it("writes the profile where --out says, and names that file on a line safe for a terminal", async () => {
  const repo = await makeRepo({
    commits: [
      {
        date: "2026-01-01T00:00:00Z",
        files: { "web/sky.ts": "export const sky = 1;\n" },
      },
    ],
  });
  const root = mkdtempSync(join(tmpdir(), "hakutaku-profile-unit-"));
  made.push(root);
  vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
  const file = join(root, `${HOSTILE}.json`);
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
  expect(await main(["profile", repo, "--out", file], io), err).toBe(0);
  expect(existsSync(file)).toBe(true);
  // the last line names the file, and every line is safe
  expect(out.split("\n").slice(-2)).toEqual([
    `wrote ${join(root, `${HOSTILE_SHOWN}.json`)}`,
    "",
  ]);
  expect(rawLines(out)).toEqual([]);
});
