import { describe, expect, it } from "vitest";
import { storeIndex } from "../../../src/query/index.js";
import {
  openTiny,
  TINY_COMMIT,
  TINY_CTX,
  tinyContent,
} from "../../helpers/tiny.js";

it("writes a valid store that opens", () => {
  const s = openTiny();
  expect(s.meta.repoId).toBe("tiny");
  expect(s.meta.commit).toBe(TINY_COMMIT);
  expect(storeIndex(s).fileByPath.get("lib/orbit.ts")).toMatchObject({
    id: 9,
    rank: 1,
    production: true,
    test: false,
    hasSource: true,
  });
  expect(storeIndex(s)).toBe(storeIndex(s)); // memoized per Store
});

describe("the tiny store", () => {
  it("holds the rows of its tables", () => {
    const c = tinyContent();
    const counts = Object.fromEntries(
      Object.entries(c).map(([table, rows]) => [
        table,
        Array.isArray(rows) ? rows.length : -1,
      ]),
    );
    expect(counts).toEqual({
      meta: 1,
      components: 4,
      files: 15,
      sources: 5,
      definitions: 16,
      externals: 2,
      imports: 14,
      call_sites: 10,
      call_targets: 9,
      refs: 5,
      entry_points: 3,
      file_metrics: 13,
      def_metrics: 16,
      cochange: 4,
      cycles: 2,
      rule_findings: 1,
      timeline: 26,
      renames: 1,
      text_index: 42,
      run: -1,
    });
    expect(c.timeline[0]).toEqual({
      week_start: 1767225600 - 26 * 604800,
      commits: 0,
    });
    expect(c.timeline.slice(24)).toEqual([
      { week_start: 1767225600 - 2 * 604800, commits: 1 },
      { week_start: 1767225600 - 604800, commits: 2 },
    ]);
    expect(
      c.text_index.filter((r) => r.file_id === 9).map((r) => r.line),
    ).toEqual([1, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16]);
  });

  it("describes a standard build in its meta", () => {
    const { meta } = openTiny();
    expect(meta).toMatchObject({
      detail: "standard",
      noSource: false,
      commitTime: 1767225600,
      engines: {
        "ast-grep": "0.0.0",
        "dependency-cruiser": "0.0.0",
        grimp: "0.0.0",
        "scip-typescript": "0.0.0",
      },
    });
    expect(meta.coverage).toEqual({
      files: 15,
      indexed: { python: 2, shell: 1, typescript: 10 },
      unresolvedImports: 0,
      callSites: { bound: 7, scoped: 1, unresolved: 2 },
      redactions: 1,
      tiers: {
        "ast-grep": "ran",
        "dependency-cruiser": "ran",
        grimp: "ran",
        "scip-typescript": "ran",
      },
      pythonResolver: "grimp",
      computedImports: 1,
      unmatchedScipDefinitions: 0,
      unmatchedBoundUses: 0,
      cycleDifferences: 0,
      noSourceFiles: 0,
      denied: 1,
      cycleSeverity: "warn",
    });
  });

  it("applies its options", () => {
    const quick = openTiny({ detail: "quick" }).meta;
    expect(quick.detail).toBe("quick");
    expect(quick.coverage.tiers["scip-typescript"]).toBe("skipped");
    const tiers = { grimp: "ran", "scip-typescript": "fallback" } as const;
    expect(openTiny({ tiers }).meta.coverage.tiers).toEqual(tiers);
    expect(
      openTiny({ cycleSeverity: "error" }).meta.coverage.cycleSeverity,
    ).toBe("error");
    const bare = tinyContent({ noSource: true });
    expect(bare.meta[0]?.no_source).toBe(1);
    expect(bare.sources).toEqual([]);
    expect(bare.text_index).toEqual([]);
    expect(bare.files.every((f) => f.has_source === 0)).toBe(true);
    expect(openTiny({ noSource: true }).meta.noSource).toBe(true);
  });

  it("gives the query context of a fresh, built tiny store", () =>
    expect(TINY_CTX).toEqual({
      repo: "tiny",
      builtCommit: TINY_COMMIT.slice(0, 12),
      stale: false,
      snippets: true,
    }));
});

describe("storeIndex", () => {
  const s = openTiny();
  const ix = storeIndex(s);

  it("reads each file with its metrics, or their defaults without a row", () => {
    expect(ix.repo).toBe("tiny");
    expect(ix.files.size).toBe(15);
    expect(ix.files.get(1)).toEqual({
      id: 1,
      path: "README.md",
      kind: "doc",
      lang: null,
      componentId: null,
      lines: 3,
      mode: "100644",
      entry: false,
      hasSource: false,
      rank: null,
      fanIn: 0,
      fanOut: 0,
      churn: 0,
      hotspot: null,
      cycleId: null,
      core: false,
      production: false,
      test: false,
    });
    expect(ix.fileByPath.get("lib/orbit.test.ts")).toEqual({
      id: 8,
      path: "lib/orbit.test.ts",
      kind: "test",
      lang: "typescript",
      componentId: 2,
      lines: 5,
      mode: "100644",
      entry: false,
      hasSource: true,
      rank: null,
      fanIn: 0,
      fanOut: 2,
      churn: 4,
      hotspot: null,
      cycleId: null,
      core: false,
      production: false,
      test: true,
    });
    expect(ix.files.get(11)).toMatchObject({
      rank: 2,
      fanIn: 2,
      fanOut: 1,
      churn: 1,
      hotspot: 0.2,
      cycleId: 1,
      core: true,
    });
    expect(ix.fileByPath.get("scripts/sync-")).toMatchObject({
      lang: "shell",
      mode: "100755",
      entry: true,
      rank: 12,
      hotspot: 0,
    });
  });

  it("reads components by id and by path", () => {
    expect(ix.componentByPath.get("lib/")).toEqual({
      id: 2,
      path: "lib/",
      files: 8,
      tests: 1,
      lines: 51,
    });
    expect([...ix.components.keys()]).toEqual([1, 2, 3, 4]);
    expect(ix.componentByPath.get("lib")).toBeUndefined();
  });

  it("reads definitions with their metrics, by file and by name", () => {
    expect(ix.defs.get(11)).toEqual({
      id: 11,
      fileId: 9,
      qualname: "Orbit.position",
      ordinal: 1,
      name: "position",
      kind: "method",
      startLine: 12,
      startCol: 3,
      endLine: 14,
      exported: true,
      parentId: 10,
      usedByFiles: 1,
      usedByFilesBound: 0,
      mentionedByTests: true,
    });
    expect(ix.defs.get(15)).toMatchObject({ qualname: "helper", ordinal: 2 });
    expect(ix.defsByFile.get(9)?.map((d) => d.id)).toEqual([9, 10, 11]);
    expect(ix.defsByFile.get(8)?.map((d) => d.kind)).toEqual(["module"]);
    expect(ix.defsByName.get("position")?.map((d) => d.id)).toEqual([4, 11]);
    expect(ix.defsByName.get("helper")?.map((d) => d.id)).toEqual([14, 15]);
    expect(ix.defsByName.has("<module>")).toBe(false);
  });

  it("reads externals and imports in both directions", () => {
    expect(ix.externals.get(2)).toEqual({
      id: 2,
      ecosystem: "npm",
      name: "react",
      files: 1,
    });
    expect(ix.importsOut.get(6)).toEqual([
      {
        id: 5,
        src: 6,
        dstFile: 2,
        dstExternal: null,
        kind: "static",
        line: 1,
        specifier: "../app/main",
      },
      {
        id: 6,
        src: 6,
        dstFile: null,
        dstExternal: null,
        kind: "dynamic",
        line: 3,
        specifier: "`./plugins/$" + "{name}`",
      },
    ]);
    expect(ix.importsOut.get(2)?.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(ix.importsIn.get(9)?.map((e) => e.src)).toEqual([2, 8, 10]);
    expect(ix.importsIn.get(2)?.map((e) => e.id)).toEqual([5]);
  });

  it("formats each kind of ID, and refuses an id the store does not hold", () => {
    expect(ix.idOfFile(7)).toBe("tiny:lib/odd %231%3A%25.ts");
    expect(ix.idOfDef(15)).toBe("tiny:py/pkg/util.py#helper(2)");
    expect(ix.idOfDef(8)).toBe("tiny:lib/orbit.test.ts#<module>");
    expect(ix.idOfExternal(1)).toBe("tiny:node:fs");
    expect(ix.idOfComponent(2)).toBe("tiny:lib/");
    expect(() => ix.idOfFile(99)).toThrow(RangeError);
    expect(() => ix.idOfDef(0)).toThrow(RangeError);
  });

  it("orders files by rank, nulls last, then by path", () => {
    const order = [...ix.files.values()].sort(ix.compareFiles).map((f) => f.id);
    expect(order).toEqual([9, 11, 5, 10, 2, 3, 14, 4, 6, 7, 13, 15, 1, 8, 12]);
  });

  it("builds one index per Store", () =>
    expect(storeIndex(openTiny())).not.toBe(ix));
});
