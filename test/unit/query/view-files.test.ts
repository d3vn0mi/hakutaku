import { describe, expect, it } from "vitest";
import {
  fileIdOf,
  historyData,
  outlineData,
  sourceData,
} from "../../../src/query/view/index.js";
import { openStore } from "../../../src/store/index.js";
import { emptyContent, miniStore } from "../../helpers/mini-store.js";
import {
  TINY_SOURCES,
  TINY_TIME,
  tinyContent,
  tinyStore,
} from "../viewer/tiny-store.js";

const open = (p: string) => {
  const s = openStore(p);
  if ("code" in s) throw new Error(s.reason);
  return s;
};
// The source of a tiny store file, which always has one.
const sourceOf = (fileId: number) => {
  const s = sourceData(open(tinyStore()), fileId);
  if (s === null) throw new Error(`file ${fileId} has no source`);
  return s;
};

describe("outlineData", () => {
  it("gives a file's definitions with their IDs, and its co-change partners", () => {
    const o = outlineData(open(tinyStore()), 4);
    expect([o.builtCommit, o.file]).toEqual([
      "4f2a9c1e07b3",
      "tiny:src/core/graph.ts",
    ]);
    expect(o.defs.map((d) => d.id)).toEqual([
      "tiny:src/core/graph.ts#Graph",
      "tiny:src/core/graph.ts#Graph.add",
      "tiny:src/core/graph.ts#helper",
      "tiny:src/core/graph.ts#helper(2)",
    ]);
    expect(o.defs[1]).toEqual({
      id: "tiny:src/core/graph.ts#Graph.add",
      qualname: "Graph.add",
      ordinal: 1,
      kind: "method",
      line: 9,
      endLine: 12,
      exported: true,
      usedByFiles: 1,
      mentionedByTests: true,
    });
    expect(o.cochange).toEqual([
      { id: "tiny:src/core/graph.test.ts", commits: 3 },
    ]);
  });
});
describe("sourceData", () => {
  it("gives the redacted text, its definitions and the call sites in the file", () => {
    const s = sourceOf(2);
    expect([s.file, s.lines, s.text]).toEqual([
      "tiny:src/cli/main.ts",
      12,
      TINY_SOURCES["src/cli/main.ts"],
    ]);
    expect(s.defs).toEqual([
      {
        id: "tiny:src/cli/main.ts#main",
        kind: "function",
        line: 3,
        endLine: 10,
      },
    ]);
    expect(s.sites).toEqual([
      {
        line: 5,
        col: 3,
        target: "tiny:src/core/graph.ts#Graph.add",
        label: "bound",
        collision: false,
      },
    ]);
  });
  it("counts redactions and keeps call sites inside the file", () => {
    const s = sourceOf(4);
    expect(s.redactions).toBe(1);
    expect(s.sites).toEqual([
      {
        line: 32,
        col: 5,
        target: "tiny:src/core/graph.ts#Graph.add",
        label: "bound",
        collision: false,
      },
    ]);
  });
  it("counts every redaction mark, two on one line included", () => {
    const content = emptyContent("marks");
    const text =
      "a = «redacted:generic-api-key» b = «redacted:generic-api-key»\nc = «redacted:generic-api-key»\n";
    content.files.push({
      id: 1,
      path: "keys.py",
      lang: "python",
      kind: "code",
      component_id: null,
      lines: 2,
      bytes: new TextEncoder().encode(text).length,
      blob_sha: "c".repeat(40),
      mode: "100644",
      link_target: null,
      entry: 0,
      has_source: 1,
    });
    content.sources.push({ file_id: 1, text });
    const s = sourceData(open(miniStore(content)), 1);
    expect(s?.redactions).toBe(3);
  });
  it("orders call sites by line, then column", () => {
    const content = tinyContent();
    // main.ts line 12 calls main at column 20, after the call at 5:3 and before the other files'
    const at = 1;
    content.call_sites.splice(at, 0, {
      id: 0,
      file_id: 2,
      line: 12,
      col: 20,
      enclosing_def_id: 1,
      callee_name: "main",
      receiver_text: null,
      producer: "ast-grep",
    });
    content.call_targets.splice(at, 0, {
      site_id: 0,
      def_id: 2,
      label: "bound",
      collision: 0,
    });
    content.call_sites = content.call_sites.map((c, i) => ({
      ...c,
      id: i + 1,
    }));
    content.call_targets = content.call_targets.map((t, i) => ({
      ...t,
      site_id: i + 1,
    }));
    const s = sourceData(open(miniStore(content)), 2);
    expect(s?.sites.map((x) => [x.line, x.col, x.target])).toEqual([
      [5, 3, "tiny:src/core/graph.ts#Graph.add"],
      [12, 20, "tiny:src/cli/main.ts#main"],
    ]);
  });
  it("is null for a file without stored source", () => {
    expect(sourceData(open(tinyStore({ noSource: true })), 2)).toBeNull();
  });
});
describe("historyData", () => {
  it("gives the 26 weeks, oldest first", () => {
    const h = historyData(open(tinyStore()));
    expect(h.weeks).toHaveLength(26);
    expect(h.weeks[0]).toEqual({ start: TINY_TIME - 26 * 604800, commits: 0 });
    expect(h.weeks[25]).toEqual({ start: TINY_TIME - 604800, commits: 3 });
  });
});
describe("fileIdOf", () => {
  it("matches a stored path exactly and nothing else", () => {
    const st = open(tinyStore());
    expect(fileIdOf(st, "src/core/graph.ts")).toBe(4);
    for (const p of [
      "src/core/Graph.ts",
      "./src/core/graph.ts",
      "src/core/",
      "../src/core/graph.ts",
      "/src/core/graph.ts",
      "",
    ])
      expect(fileIdOf(st, p)).toBeNull();
  });
  it("does not take a lone surrogate for the U+FFFD that SQLite compares it as", () => {
    const replacement = `a${String.fromCharCode(0xfffd)}.ts`;
    const content = emptyContent("odd");
    content.files.push({
      id: 1,
      path: replacement,
      lang: null,
      kind: "doc",
      component_id: null,
      lines: 1,
      bytes: 2,
      blob_sha: "c".repeat(40),
      mode: "100644",
      link_target: null,
      entry: 0,
      has_source: 0,
    });
    const st = open(miniStore(content));
    expect(fileIdOf(st, replacement)).toBe(1);
    expect(fileIdOf(st, `a${String.fromCharCode(0xd800)}.ts`)).toBeNull();
  });
});
describe("a file id the store does not hold", () => {
  it("is refused, not answered with another file's data", () => {
    const st = open(tinyStore());
    for (const id of [0, 6]) {
      expect(() => outlineData(st, id)).toThrow(RangeError);
      expect(() => sourceData(st, id)).toThrow(RangeError);
    }
  });
});
