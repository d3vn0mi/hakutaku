// The hostile fixtures for tests: fixtures/hostile/make.mjs run into a fresh directory under the
// OS temp directory on every call, removed after the last test of the file that made it, with
// the cases fixtures/hostile/cases.json lists. A case fires when anything appears in canaryDir,
// or when the marker line of markerFile appears where it must not.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";
import type { Detail } from "../../src/model/index.js";

const HOSTILE = fileURLToPath(
  new URL("../../fixtures/hostile/", import.meta.url),
);

export type HostileCaseId =
  | "pyright-interpreter"
  | "sgconfig"
  | "git-config"
  | "smudge-filter"
  | "show-signature"
  | "fsmonitor-hooks"
  | "depcruise-config"
  | "python-shadow"
  | "symlink-host"
  | "dotdot-path"
  | "injected-comment"
  | "markup-names"
  | "minified-50mb";

export interface HostileCase {
  id: HostileCaseId;
  stage: string; // "export", "extract", "query" or "viewer"
  vector: string;
  expect: string;
  detail: Detail;
}

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

export async function hostileFixtures(): Promise<{
  dir: string;
  canaryDir: string;
  markerFile: string;
  cases: HostileCase[];
}> {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-hostile-"));
  made.push(dir);
  execFileSync(process.execPath, [join(HOSTILE, "make.mjs"), dir], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const cases: HostileCase[] = JSON.parse(
    readFileSync(join(HOSTILE, "cases.json"), "utf8"),
  );
  return {
    dir,
    canaryDir: join(dir, "canary"),
    markerFile: join(dir, "host", "secret.txt"),
    cases,
  };
}
