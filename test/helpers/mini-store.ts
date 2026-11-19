// Small stores for unit tests. emptyContent is valid content with meta filled and every other
// table empty; miniStore writes content into a fresh directory under the OS temp directory,
// removed after the last test of the file that made it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import type { RepoId } from "../../src/model/index.js";
import {
  SCHEMA_VERSION,
  type StoreContent,
  writeStore,
} from "../../src/store/index.js";
import { HAKUTAKU_VERSION } from "../../src/version.js";

// vitest's workers end without an "exit" event, so the directories go in a file-level hook.
const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

export function emptyContent(repo: RepoId = "observatory"): StoreContent {
  return {
    meta: [
      {
        schema_version: SCHEMA_VERSION,
        hakutaku_version: HAKUTAKU_VERSION,
        repo_id: repo,
        commit_sha: "fedcba9876543210fedcba9876543210fedcba98",
        commit_time: 1767225600, // 2026-01-01T00:00:00Z
        detail: "standard",
        no_source: 0,
        engines: {},
        engine_lock_hash: "0".repeat(64),
        profile_hash: "0".repeat(64),
        rules_hash: "",
        coverage: {
          files: 0,
          indexed: {},
          unresolvedImports: 0,
          callSites: { bound: 0, scoped: 0, unresolved: 0 },
          redactions: 0,
          tiers: {},
          pythonResolver: "none",
          computedImports: 0,
          unmatchedScipDefinitions: 0,
          unmatchedBoundUses: 0,
          cycleDifferences: 0,
          noSourceFiles: 0,
          denied: 0,
          cycleSeverity: "warn",
        },
        gates: [
          { gate: "files-indexed", ok: true, detail: "passed" },
          { gate: "unresolved-imports", ok: true, detail: "passed" },
          { gate: "scip-duplicates", ok: true, detail: "passed" },
          { gate: "denylist", ok: true, detail: "passed" },
          { gate: "redaction", ok: true, detail: "passed" },
        ],
      },
    ],
    components: [],
    files: [],
    sources: [],
    definitions: [],
    externals: [],
    imports: [],
    call_sites: [],
    call_targets: [],
    refs: [],
    entry_points: [],
    file_metrics: [],
    def_metrics: [],
    cochange: [],
    cycles: [],
    rule_findings: [],
    timeline: [],
    renames: [],
    text_index: [],
    run: { ref: "HEAD", built_at: "2026-01-01T00:00:00Z" },
  };
}

export function miniStore(content: StoreContent): string {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-store-"));
  made.push(dir);
  const path = join(dir, "store.sqlite");
  writeStore(path, content);
  return path;
}
