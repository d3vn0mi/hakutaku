// The engines, installed: run `node dist/cli/main.js engines install --yes` once, and
// `npm run build` before this file, since it runs dist/.
import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { defaultEnginesDir, verifyEngines } from "../../src/engines/index.js";
import { removeTree } from "../../src/export/index.js";

const MAIN = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));

// One temporary directory per test: every tmp() call in a test names the same one.
let current: string | undefined;
const tmp = (): string => {
  current ??= mkdtempSync(join(tmpdir(), "hakutaku-oracle-engines-"));
  return current;
};
afterEach(() => {
  if (current !== undefined) removeTree(current);
  current = undefined;
});

// The npm this test runs under, found on PATH as a shell would.
function npmPath(): string {
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(entry)) continue;
    const path = join(entry, "npm");
    try {
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return realpathSync(path);
    } catch {}
  }
  throw new Error("no npm on PATH");
}

// A directory holding links to node and npm and nothing else, for a PATH without Python.
function nodeAndNpmOnly(): string {
  const bin = join(tmp(), "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(npmPath(), join(bin, "npm"));
  return bin;
}

function runCli(
  argv: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...argv], {
      cwd: tmp(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (s: string) => {
      stdout += s;
    });
    child.stderr.setEncoding("utf8").on("data", (s: string) => {
      stderr += s;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

it("verifies the installed engines", () =>
  expect(verifyEngines(defaultEnginesDir())).toEqual({
    ok: true,
    problems: [],
  }));

it("installs without grimp when no suitable Python exists", async () => {
  // PATH is a temp directory holding links to node and npm only, so no python3 is found
  const r = await runCli(
    ["engines", "install", "--yes", "--engines-dir", join(tmp(), "e")],
    { PATH: nodeAndNpmOnly(), HOME: tmp() },
  );
  expect(r.code).toBe(0);
  expect(r.stderr).toMatch(
    /^grimp not installed: .*; Python imports will come from hakutaku's resolver$/m,
  );
  expect(
    JSON.parse(readFileSync(join(tmp(), "e/installed.json"), "utf8")).python,
  ).toBeNull();
  expect(verifyEngines(join(tmp(), "e"))).toEqual({ ok: true, problems: [] });
}, 300_000);
