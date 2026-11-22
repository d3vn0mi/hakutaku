import { describe, expect, it } from "vitest";
import {
  ENTRY_KINDS,
  F,
  FILE_KINDS,
  INLINE_OUTLINES_UP_TO,
  mapData,
} from "../../../src/query/view/index.js";
import { openStore } from "../../../src/store/index.js";
import { emptyContent, miniStore } from "../../helpers/mini-store.js";
import { TINY_TIME, tinyContent, tinyStore } from "../viewer/tiny-store.js";

const open = (p: string) => {
  const s = openStore(p);
  if ("code" in s) throw new Error(s.reason);
  return s;
};
const tiny = (o: object = {}) =>
  mapData(open(tinyStore()), { stale: false, snippets: true, ...o });

describe("mapData", () => {
  it("lists every tracked file in store order, as tuples", () => {
    const m = tiny();
    expect(m.files.map((f) => f[0])).toEqual([
      "package.json",
      "src/cli/main.ts",
      "src/core/graph.test.ts",
      "src/core/graph.ts",
      "src/core/util.ts",
    ]);
    expect(m.files[0]).toEqual([
      "package.json",
      3,
      -1,
      -1,
      9,
      0,
      0,
      0,
      0,
      -1,
      0,
      4,
    ]);
    expect(m.files[1]).toEqual([
      "src/cli/main.ts",
      0,
      0,
      0,
      12,
      3,
      0.2,
      0.1,
      1,
      10,
      0,
      7,
    ]);
    expect(m.files[2]).toEqual([
      "src/core/graph.test.ts",
      1,
      0,
      1,
      20,
      0,
      0,
      0,
      2,
      3,
      0,
      4,
    ]);
    expect(m.files[3]).toEqual([
      "src/core/graph.ts",
      0,
      0,
      1,
      40,
      1,
      0.5,
      1,
      4,
      1,
      1,
      6,
    ]);
    expect(m.files[4]).toEqual([
      "src/core/util.ts",
      0,
      0,
      1,
      15,
      2,
      0.3,
      0,
      0,
      120,
      1,
      4,
    ]);
    expect(m.langs).toEqual(["typescript"]);
    expect(m.components).toEqual([
      ["src/cli", 1, 0, 12],
      ["src/core", 2, 1, 75],
    ]);
  });
  it("counts from the store, and states the core line over production files", () => {
    const m = tiny();
    expect(m.counts).toEqual({
      productionFiles: 3,
      tests: 1,
      components: 2,
      entryPoints: 1,
      cycles: 1,
      importEdges: 4,
      libraries: 2,
      definitions: 6,
    });
    expect(m.coreSet).toEqual({ files: 2, ofFiles: 3 });
    expect([m.format, m.repo, m.builtCommit, m.detail]).toEqual([
      1,
      "tiny",
      "4f2a9c1e07b3",
      "standard",
    ]);
  });
  it("carries imports, libraries, cycles and entry points as indices", () => {
    const m = tiny();
    expect(m.imports).toEqual([1, 3, 0, 2, 3, 0, 3, 4, 0, 4, 3, 0]);
    expect(m.externals).toEqual([
      [2, "fs", 1],
      [0, "kleur", 1],
    ]);
    expect(m.libImports).toEqual([1, 1, 3, 0]);
    expect(m.cycles).toEqual([[3, 4]]);
    expect(m.entries).toEqual([
      [1, ENTRY_KINDS.indexOf("bin"), 0, 4, "tiny", -1],
    ]);
  });
  it("indexes definitions without module scope, ordinals kept", () => {
    expect(tiny().defs).toEqual({
      file: [1, 3, 3, 3, 3, 4],
      name: ["main", "Graph", "Graph.add", "helper", "helper", "clamp"],
      ordinal: [1, 1, 1, 1, 2, 1],
      line: [3, 5, 9, 30, 35, 2],
      kind: [0, 1, 2, 0, 0, 0],
      exported: [1, 1, 1, 0, 0, 1],
      usedBy: [0, 1, 1, 0, 0, 0],
    });
  });
  it("inlines outlines and co-change up to the limit, and only then", () => {
    expect(INLINE_OUTLINES_UP_TO).toBe(2000);
    expect(tiny().outline).toEqual({
      endLine: [10, 28, 12, 33, 38, 4],
      tested: [0, 1, 1, 0, 0, 0],
    });
    expect(tiny().cochange).toEqual([2, 3, 3, 3, 2, 3]);
    const over = tiny({ inlineUpTo: 2 }); // 3 production files > 2
    expect([over.outline, over.cochange]).toEqual([null, null]);
    expect(over.defs.name).toHaveLength(6); // Find keeps every definition
  });
  it("is deterministic", () => {
    expect(JSON.stringify(tiny())).toBe(JSON.stringify(tiny()));
  });
  it("reports freshness and whether sources can be read", () => {
    expect(tiny({ stale: "unknown" }).stale).toBe("unknown");
    expect([tiny().sources, tiny({ snippets: false }).sources]).toEqual([
      true,
      false,
    ]);
    expect(
      mapData(open(tinyStore({ noSource: true })), {
        stale: false,
        snippets: true,
      }).sources,
    ).toBe(false);
  });
  it("of a store with no code files is empty but valid", () => {
    const m = mapData(open(miniStore(emptyContent("empty"))), {
      stale: false,
      snippets: true,
    });
    expect([m.files, m.imports, m.cycles, m.defs.name, m.cochange]).toEqual([
      [],
      [],
      [],
      [],
      [],
    ]);
    expect(m.counts).toEqual({
      productionFiles: 0,
      tests: 0,
      components: 0,
      entryPoints: 0,
      cycles: 0,
      importEdges: 0,
      libraries: 0,
      definitions: 0,
    });
    expect(m.coreSet).toEqual({ files: 0, ofFiles: 0 });
  });
  it("writes a component's path without its final slash, the root component as .", () => {
    const content = emptyContent("root");
    for (const [id, path] of [
      [1, "./"],
      [2, "lib/"],
    ] as const) {
      content.components.push({
        id,
        path,
        kind: "folder",
        parent_id: null,
        files: 0,
        tests: 0,
        lines: 0,
      });
    }
    const m = mapData(open(miniStore(content)), {
      stale: false,
      snippets: true,
    });
    expect(m.components).toEqual([
      [".", 0, 0, 0],
      ["lib", 0, 0, 0],
    ]);
  });
  it("still inlines outlines and co-change at exactly the limit", () => {
    const at = tiny({ inlineUpTo: 3 }); // 3 production files
    expect(at.outline?.endLine).toHaveLength(6);
    expect(at.cochange).toEqual([2, 3, 3, 3, 2, 3]);
  });
  it("keeps four significant digits of pagerank, and counts whole days down", () => {
    const content = tinyContent();
    const main = content.file_metrics[0];
    if (main === undefined) throw new Error("the tiny store has no metrics");
    // 10 days and about 0.58 of a day before the built commit
    content.file_metrics[0] = {
      ...main,
      pagerank: 0.123456,
      last_change: TINY_TIME - 10 * 86_400 - 50_000,
    };
    const file = mapData(open(miniStore(content)), {
      stale: false,
      snippets: true,
    }).files[1];
    expect([file?.[F.pagerank], file?.[F.changedDaysAgo]]).toEqual([
      0.1235, 10,
    ]);
  });
  it("counts test-support files with the tests", () => {
    const content = tinyContent();
    content.files = content.files.map((f) =>
      f.kind === "test" ? { ...f, kind: "test-support" } : f,
    );
    const m = mapData(open(miniStore(content)), {
      stale: false,
      snippets: true,
    });
    expect(m.counts.tests).toBe(1);
    expect(m.files[2]?.[F.kind]).toBe(FILE_KINDS.indexOf("test-support"));
  });
  it("points an entry point at its definition's place in defs, module scope left out", () => {
    const content = tinyContent();
    content.entry_points = content.entry_points.map((e) => ({
      ...e,
      def_id: 2, // main, store id 2 behind main.ts's module row, first in defs
    }));
    const m = mapData(open(miniStore(content)), {
      stale: false,
      snippets: true,
    });
    const def = m.entries[0]?.[5] ?? -1;
    expect([def, m.defs.name[def]]).toEqual([0, "main"]);
  });
});
