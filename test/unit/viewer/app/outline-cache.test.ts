// Each file's outline as the map reads it: the last line of each definition and whether a test
// mentions it, parallel to the file's slice of the map's definitions, and the files that change
// together with it. A map that carries outlines answers from them; above the inline limit, a
// file's outline is fetched once, its IDs become indices, and nothing of another build or
// another file is taken in.
import { describe, expect, it } from "vitest";
import { parseId } from "../../../../src/model/ids.js";
import {
  fileIdOf,
  mapData,
  type OutlineData,
  outlineData,
} from "../../../../src/query/view/index.js";
import { openStore, type Store } from "../../../../src/store/index.js";
import type { DataSource } from "../../../../src/viewer/app/data-types.js";
import { buildModel, type Model } from "../../../../src/viewer/app/model.js";
import { createOutlineCache } from "../../../../src/viewer/app/outline-cache.js";
import { tinyStore } from "../tiny-store.js";
import { tinyModel } from "./helpers.js";

const open = (p: string): Store => {
  const s = openStore(p);
  if ("code" in s) throw new Error(s.reason);
  return s;
};

// A data source whose outline(id) answers outlineData for the file the ID names, as change()
// leaves it, and records each ID it is asked for. Nothing else is called.
function countingSource(
  calls: string[],
  change: (o: OutlineData) => OutlineData = (o) => o,
): DataSource {
  const store = open(tinyStore());
  const none = () =>
    Promise.reject(new Error("not called by the outline cache"));
  return {
    kind: "http",
    map: none,
    async outline(id) {
      calls.push(id);
      const ref = parseId(id);
      const file = ref?.kind === "file" ? fileIdOf(store, ref.path) : null;
      if (file === null) throw new Error(`the tiny store has no ${id}`);
      return change(outlineData(store, file));
    },
    source: none,
    history: none,
    tool: none,
  };
}

// The tiny store's map, with outlines and co-change left to be fetched: its 3 production files
// are over a limit of 2.
const fetchedModel = (): Model =>
  buildModel(
    mapData(open(tinyStore()), { stale: false, snippets: true, inlineUpTo: 2 }),
  );

const GRAPH = {
  endLine: [28, 12, 33, 38],
  tested: [1, 1, 0, 0],
  cochange: [[2, 3]],
};

describe("an inline map", () => {
  it("reads inline outlines without fetching", async () => {
    const calls: string[] = [];
    const c = createOutlineCache(tinyModel(), countingSource(calls));
    expect(c.peek(3)).toEqual({
      endLine: [28, 12, 33, 38],
      tested: [1, 1, 0, 0],
      cochange: [[2, 3]],
    });
    expect(calls).toEqual([]);
  });

  it("answers every file of the map, and get() fetches nothing", async () => {
    const calls: string[] = [];
    const c = createOutlineCache(tinyModel(), countingSource(calls));
    expect([c.peek(0), c.peek(1), c.peek(2), c.peek(4)]).toEqual([
      { endLine: [], tested: [], cochange: [] },
      { endLine: [10], tested: [0], cochange: [] },
      { endLine: [], tested: [], cochange: [[3, 3]] },
      { endLine: [4], tested: [0], cochange: [] },
    ]);
    expect(await c.get(3)).toBe(c.peek(3));
    expect(calls).toEqual([]);
  });

  it("knows no file outside the map", async () => {
    const c = createOutlineCache(tinyModel(), countingSource([]));
    for (const file of [-1, 5, 1.5, Number.NaN])
      expect(c.peek(file)).toBeNull();
    await expect(c.get(5)).rejects.toThrow(RangeError);
  });
});

describe("above the inline limit", () => {
  it("fetches once above the inline limit", async () => {
    const calls: string[] = [];
    const m = fetchedModel();
    const c = createOutlineCache(m, countingSource(calls));
    expect(c.peek(3)).toBeNull();
    expect(await c.get(3)).toEqual({
      endLine: [28, 12, 33, 38],
      tested: [1, 1, 0, 0],
      cochange: [[2, 3]],
    });
    await c.get(3);
    expect(calls).toEqual(["tiny:src/core/graph.ts"]);
  });

  it("shares one fetch between callers, and peek() answers once it has arrived", async () => {
    const calls: string[] = [];
    const c = createOutlineCache(fetchedModel(), countingSource(calls));
    const [a, b] = await Promise.all([c.get(3), c.get(3)]);
    expect(a).toBe(b);
    expect(c.peek(3)).toBe(a);
    expect(await c.get(2)).toEqual({
      endLine: [],
      tested: [],
      cochange: [[3, 3]],
    });
    expect(calls).toEqual([
      "tiny:src/core/graph.ts",
      "tiny:src/core/graph.test.ts",
    ]);
  });

  it("drops an ID the map does not hold", async () => {
    // the IDs the map does not hold come first, so each is passed over, not the end of the list
    const c = createOutlineCache(
      fetchedModel(),
      countingSource([], (o) => ({
        ...o,
        defs: [
          { ...o.defs[0], id: "tiny:src/core/graph.ts#gone", endLine: 99 },
          { ...o.defs[0], id: "other:src/core/graph.ts#Graph", endLine: 98 },
          ...o.defs,
        ],
        cochange: [
          { id: "tiny:src/core/gone.ts", commits: 9 },
          { id: "other:src/core/graph.test.ts", commits: 8 },
          { id: "tiny:src/core/", commits: 7 },
          { id: "not an ID", commits: 6 },
          ...o.cochange,
        ],
      })),
    );
    expect(await c.get(3)).toEqual(GRAPH);
  });

  it("places each definition by its ID, and keeps the first line of one the answer lacks", async () => {
    const c = createOutlineCache(
      fetchedModel(),
      countingSource([], (o) => ({
        ...o,
        defs: [...o.defs].reverse().filter((d) => d.qualname !== "Graph.add"),
      })),
    );
    // the answer's definitions come in reverse and are each placed by their ID; Graph.add (lines
    // 9-12, mentioned by a test), left out of the answer, ends at its first line, unmentioned
    expect(await c.get(3)).toEqual({
      endLine: [28, 9, 33, 38],
      tested: [1, 0, 0, 0],
      cochange: [[2, 3]],
    });
  });

  it("refuses an outline from another build, keeps none, and asks again", async () => {
    const calls: string[] = [];
    const c = createOutlineCache(
      fetchedModel(),
      countingSource(calls, (o) => ({ ...o, builtCommit: "b0b0b0b0b0b0" })),
    );
    await expect(c.get(3)).rejects.toThrow(/b0b0b0b0b0b0/);
    expect(c.peek(3)).toBeNull();
    await expect(c.get(3)).rejects.toThrow(/another build/);
    expect(calls).toEqual(["tiny:src/core/graph.ts", "tiny:src/core/graph.ts"]);
  });

  it("refuses an answer about another file", async () => {
    const c = createOutlineCache(
      fetchedModel(),
      countingSource([], (o) => ({ ...o, file: "tiny:src/cli/main.ts" })),
    );
    await expect(c.get(3)).rejects.toThrow(/tiny:src\/cli\/main\.ts/);
    expect(c.peek(3)).toBeNull();
  });

  it("asks again after a failed fetch", async () => {
    const calls: string[] = [];
    let fail = true;
    const working = countingSource(calls);
    const source: DataSource = {
      ...working,
      outline: (id) => {
        if (!fail) return working.outline(id);
        calls.push(id);
        return Promise.reject(new Error("no answer from the server"));
      },
    };
    const c = createOutlineCache(fetchedModel(), source);
    await expect(c.get(3)).rejects.toThrow("no answer from the server");
    fail = false;
    expect(await c.get(3)).toEqual(GRAPH);
    expect(calls).toHaveLength(2);
  });
});
