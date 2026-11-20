import { describe, expect, it } from "vitest";
import {
  type ListAdapter,
  measure,
  type PageFields,
  pageList,
  pageNote,
  pageText,
  withPageFields,
} from "../../../src/tools/index.js";

// The paging fields of a page, read from any answer.
type Page = Partial<PageFields>;

interface Item {
  id: string;
  pad: string;
}
const list = (n: number, size: number) => ({
  id: "x:",
  builtCommit: "0123456789ab",
  stale: false,
  items: Array.from(
    { length: n },
    (_, i): Item => ({ id: `x:f${i}`, pad: "p".repeat(size) }),
  ),
  view: "#",
});
type List = ReturnType<typeof list>;
const flat: ListAdapter<List, Item> = {
  items: (a) => a.items,
  rebuild: (a, p) => ({ ...a, items: p }),
};

interface Site {
  line: number;
  col: number;
  label: string;
  text: string;
}
interface Caller {
  id: string;
  file: string;
  test: boolean;
  hop: number;
  part?: string;
  sites: Site[];
}
interface Link {
  from: string;
  to: string;
  line: number;
}
interface Finding {
  kind: string;
  id: string;
  severity: string;
  rule?: string;
  files?: string[];
  from?: string;
  to?: string;
  part?: string;
  chain: Link[];
}

// Every page from a first call without offset, following nextOffset to the end.
const follow = <P extends Page>(call: (offset?: number) => P): P[] => {
  let last = call();
  const pages = [last];
  while (last.hasMore) {
    if (pages.length > 1000) throw new Error("paging does not end");
    last = call(last.nextOffset);
    pages.push(last);
  }
  return pages;
};
const all = <A extends object, I>(
  answer: A,
  adapter: ListAdapter<A, I>,
  limit: number,
  maxChars: number,
) =>
  follow(
    (offset) =>
      pageList(answer, adapter, { offset, limit, maxChars }) as A & Page,
  );
const windows = <A extends { lines: string[] }>(answer: A, maxChars: number) =>
  follow((offset) => pageText(answer, { offset, maxChars }) as A & Page);

describe("pageList", () => {
  it("returns an answer that fits unchanged on a first call", () => {
    const a = list(3, 10);
    expect(pageList(a, flat, { limit: 50, maxChars: 40000 })).toBe(a);
  });
  it("pages an oversized answer under the cap, with the fields after stale", () => {
    const p = pageList(list(500, 400), flat, {
      limit: 500,
      maxChars: 40000,
    }) as List & Page;
    expect(measure(p)).toBeLessThanOrEqual(40000);
    expect(Object.keys(p)).toEqual([
      "id",
      "builtCommit",
      "stale",
      "offset",
      "returned",
      "total",
      "hasMore",
      "nextOffset",
      "note",
      "items",
      "view",
    ]);
    expect(p).toMatchObject({
      offset: 0,
      total: 500,
      hasMore: true,
      nextOffset: p.returned,
      note: `items 1-${p.returned} of 500; call again with offset ${p.returned} for the next page`,
    });
  });
  it("paging by nextOffset returns each item once, in order", () => {
    const a = list(500, 400);
    const pages = all(a, flat, 500, 40000);
    expect(pages.flatMap((p) => p.items.map((i) => i.id))).toEqual(
      a.items.map((i) => i.id),
    );
    expect(pages.at(-1)).not.toHaveProperty("nextOffset");
    expect(pages.at(-1)?.note).toMatch(/; this is the last page$/);
  });
  it("a page holds the longest run that fits", () => {
    const a = list(500, 400);
    const pages = all(a, flat, 500, 40000);
    expect(pages.length).toBeGreaterThan(2);
    for (const p of pages.filter((q) => q.hasMore)) {
      const o = p.offset ?? 0;
      const r = p.returned ?? 0;
      // The same page with one more item, its fields as pageList words them.
      const longer = pageList(a, flat, {
        offset: o,
        limit: r + 1,
        maxChars: 1e9,
      }) as List & Page;
      expect(longer.returned).toBe(r + 1);
      expect(measure(longer)).toBeGreaterThan(40000);
    }
  });
  it("limit caps a page even when more would fit", () => {
    expect(
      pageList(list(30, 10), flat, { limit: 20, maxChars: 40000 }),
    ).toMatchObject({ returned: 20, hasMore: true, nextOffset: 20 });
  });
  it("an explicit offset always carries paging fields", () => {
    expect(
      pageList(list(3, 10), flat, { offset: 0, limit: 50, maxChars: 40000 }),
    ).toMatchObject({
      offset: 0,
      returned: 3,
      total: 3,
      hasMore: false,
      note: "items 1-3 of 3; this is the last page",
    });
  });
  it("an offset past the end gives an empty last page", () => {
    const p = pageList(list(3, 10), flat, {
      offset: 10,
      limit: 50,
      maxChars: 40000,
    });
    expect(p).toMatchObject({
      offset: 10,
      returned: 0,
      total: 3,
      hasMore: false,
      note: "no items at offset 10; there are 3",
      items: [],
    });
  });
  it("takes the whole remainder when only the last page fits", () => {
    const a = {
      builtCommit: "0123456789ab",
      stale: false,
      items: ["a", "b", "c", "d"],
    };
    const s: ListAdapter<typeof a, string> = {
      items: (x) => x.items,
      rebuild: (x, p) => ({ ...x, items: p }),
    };
    const cap = measure(pageList(a, s, { offset: 0, limit: 4, maxChars: 1e9 }));
    expect(
      measure(pageList(a, s, { offset: 0, limit: 3, maxChars: 1e9 })),
    ).toBeGreaterThan(cap); // the premise
    const p = pageList(a, s, { offset: 0, limit: 10, maxChars: cap });
    expect((p as typeof a & Page).returned).toBe(4);
  });
  it("splits an item whose own list is too large, and the parts rebuild it", () => {
    const sites = Array.from(
      { length: 300 },
      (_, i): Site => ({
        line: i + 1,
        col: 1,
        label: "bound",
        text: "t".repeat(100),
      }),
    );
    const callers: Caller[] = [
      { id: "x:b#g", file: "x:b", test: false, hop: 1, sites },
    ];
    const a = {
      id: "x:a#f",
      builtCommit: "0123456789ab",
      stale: false,
      callers,
      view: "#",
    };
    const ad: ListAdapter<typeof a, Caller> = {
      items: (x) => x.callers,
      rebuild: (x, p) => ({ ...x, callers: p }),
      split: { lists: ["sites"], partBefore: "sites" },
    };
    const pages = all(a, ad, 50, 5000);
    const units = pages.flatMap((p) => p.callers);
    for (const p of pages) expect(measure(p)).toBeLessThanOrEqual(5000);
    expect(Object.keys(units[0])).toEqual([
      "id",
      "file",
      "test",
      "hop",
      "part",
      "sites",
    ]);
    expect(units.map((u) => u.part)).toEqual(
      units.map((_, k) => `${k + 1}/${units.length}`),
    );
    expect(units.flatMap((u) => u.sites)).toEqual(sites);
  });
  it("splits across two lists in order", () => {
    const files = Array.from({ length: 200 }, (_, i) => `x:f${i}`);
    const chain = files.map(
      (f, i): Link => ({ from: f, to: `x:g${i}`, line: i + 1 }),
    );
    const findings: Finding[] = [
      { kind: "cycle", id: "x:f0", severity: "warn", files, chain },
    ];
    const a = { builtCommit: "0123456789ab", stale: false, findings };
    const ad: ListAdapter<typeof a, Finding> = {
      items: (x) => x.findings,
      rebuild: (x, p) => ({ ...x, findings: p }),
      split: { lists: ["files", "chain"], partBefore: "chain" },
    };
    const units = all(a, ad, 100, 4000).flatMap((p) => p.findings);
    expect(Object.keys(units[0])).toEqual([
      "kind",
      "id",
      "severity",
      "files",
      "part",
      "chain",
    ]);
    expect(units.flatMap((u) => u.files)).toEqual(files);
    expect(units.flatMap((u) => u.chain)).toEqual(chain);
  });
  it("a page holds at least one unit even when one unit alone is over the cap", () => {
    expect(
      pageList(list(3, 100), flat, { limit: 50, maxChars: 50 }),
    ).toMatchObject({ returned: 1, hasMore: true, nextOffset: 1 });
  });
  it("fills only the split lists an item has", () => {
    const chain = Array.from(
      { length: 200 },
      (_, i): Link => ({ from: `x:a${i}`, to: `x:b${i}`, line: i + 1 }),
    );
    const findings: Finding[] = [
      {
        kind: "violation",
        id: "x:a0",
        severity: "error",
        rule: "ui-not-to-db",
        from: "x:a0",
        to: "x:b0",
        chain,
      },
    ];
    const a = { builtCommit: "0123456789ab", stale: false, findings };
    const ad: ListAdapter<typeof a, Finding> = {
      items: (x) => x.findings,
      rebuild: (x, p) => ({ ...x, findings: p }),
      split: { lists: ["files", "chain"], partBefore: "chain" },
    };
    const units = all(a, ad, 100, 4000).flatMap((p) => p.findings);
    expect(units.length).toBeGreaterThan(1);
    for (const u of units) {
      expect(Object.keys(u)).toEqual([
        "kind",
        "id",
        "severity",
        "rule",
        "from",
        "to",
        "part",
        "chain",
      ]);
    }
    expect(units.flatMap((u) => u.chain)).toEqual(chain);
  });
  it("marks a part last when the item has no partBefore key", () => {
    const sites = Array.from(
      { length: 100 },
      (_, i): Site => ({ line: i + 1, col: 1, label: "bound", text: "t" }),
    );
    const a = {
      builtCommit: "0123456789ab",
      stale: false,
      callers: [{ id: "x:b#g", sites }],
    };
    const ad: ListAdapter<typeof a, { id: string; sites: Site[] }> = {
      items: (x) => x.callers,
      rebuild: (x, p) => ({ ...x, callers: p }),
      split: { lists: ["sites"], partBefore: "file" },
    };
    const units = all(a, ad, 50, 3000).flatMap((p) => p.callers);
    expect(units.length).toBeGreaterThan(1);
    expect(Object.keys(units[0])).toEqual(["id", "sites", "part"]);
    expect(units.flatMap((u) => u.sites)).toEqual(sites);
  });
  it("keeps an oversized item whole when it has nothing to split", () => {
    const small: Caller = {
      id: "x:b#g",
      file: "x:b",
      test: false,
      hop: 1,
      sites: [],
    };
    const big: Caller = { ...small, id: `x:b#${"g".repeat(5000)}` };
    const a = {
      builtCommit: "0123456789ab",
      stale: false,
      callers: [small, big],
    };
    const ad: ListAdapter<typeof a, Caller> = {
      items: (x) => x.callers,
      rebuild: (x, p) => ({ ...x, callers: p }),
      split: { lists: ["sites"], partBefore: "sites" },
    };
    const pages = all(a, ad, 50, 2000);
    expect(pages.flatMap((p) => p.callers)).toEqual([small, big]);
    expect(pages.at(-1)).toMatchObject({ offset: 1, returned: 1, total: 2 });
  });
});

describe("pageText", () => {
  it("windows a long text, and the windows rebuild it exactly", () => {
    const lines = Array.from(
      { length: 120 },
      (_, i) => `${i}:${"s".repeat(300)}`,
    );
    const a = {
      id: "x:f",
      file: "x:f",
      builtCommit: "0123456789ab",
      stale: false,
      from: 1,
      to: 120,
      lines,
      truncated: false,
      redactions: 0,
      untrusted: true as const,
      view: "#f",
    };
    const ws = windows(a, 8000);
    for (const w of ws) expect(measure(w)).toBeLessThanOrEqual(8000);
    expect(ws.map((w) => w.lines.join("\n")).join("")).toBe(lines.join("\n"));
    expect(ws[0].note).toBe(
      `characters 1-${ws[0].returned} of ${lines.join("\n").length}; call again with offset ${ws[0].nextOffset} for the next window`,
    );
  });
  it("returns a snippet that fits unchanged on a first call", () => {
    const a = {
      builtCommit: "0123456789ab",
      stale: false,
      lines: ["one", "two"],
      untrusted: true as const,
    };
    expect(pageText(a, { maxChars: 40000 })).toBe(a);
  });
  it("a window holds the longest text that fits", () => {
    const lines = Array.from(
      { length: 120 },
      (_, i) => `${i}:${"s".repeat(300)}`,
    );
    const a = {
      builtCommit: "0123456789ab",
      stale: false,
      lines,
      untrusted: true as const,
    };
    const text = lines.join("\n");
    const ws = windows(a, 8000);
    expect(ws.length).toBeGreaterThan(2);
    for (const w of ws.filter((x) => x.hasMore)) {
      const o = w.offset ?? 0;
      const r = (w.returned ?? 0) + 1;
      const hasMore = o + r < text.length;
      const f = hasMore
        ? {
            offset: o,
            returned: r,
            total: text.length,
            hasMore,
            nextOffset: o + r,
          }
        : { offset: o, returned: r, total: text.length, hasMore };
      // The same window with one more character.
      const longer = withPageFields(
        { ...a, lines: text.slice(o, o + r).split("\n") },
        { ...f, note: pageNote("characters", f) },
      );
      expect(measure(longer)).toBeGreaterThan(8000);
    }
  });
  it("a window never splits a surrogate pair", () => {
    const a = {
      builtCommit: "0123456789ab",
      stale: false,
      lines: ["😀".repeat(5000)],
      untrusted: true as const,
    };
    const ws = windows(a, 3001);
    for (const w of ws) {
      expect(w.lines.join("\n")).not.toMatch(
        /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/,
      );
    }
  });
  it("a window that fits nothing still keeps a surrogate pair whole", () => {
    const a = {
      builtCommit: "0123456789ab",
      stale: false,
      lines: ["😀😀"],
      untrusted: true as const,
    };
    const ws = windows(a, 10);
    expect(ws.map((w) => w.lines)).toEqual([["😀"], ["😀"]]);
    expect(ws.map((w) => w.returned)).toEqual([2, 2]);
  });
  it("a window can cut inside one very long line", () => {
    const a = {
      builtCommit: "0123456789ab",
      stale: false,
      lines: ["L".repeat(100000)],
      untrusted: true as const,
    };
    const w = pageText(a, { maxChars: 40000 }) as typeof a & Page;
    expect(w.hasMore).toBe(true);
    expect(w.lines).toHaveLength(1);
    expect(measure(w)).toBeLessThanOrEqual(40000);
  });
});

describe("withPageFields and pageNote", () => {
  it("puts every paging field right after stale, and nextOffset only when set", () => {
    const a = {
      id: "x:",
      builtCommit: "0123456789ab",
      stale: false,
      items: [],
      view: "#",
    };
    const last = {
      offset: 0,
      returned: 3,
      total: 3,
      hasMore: false,
      note: "items 1-3 of 3; this is the last page",
    };
    const keys = [
      "id",
      "builtCommit",
      "stale",
      "offset",
      "returned",
      "total",
      "hasMore",
      "note",
      "items",
      "view",
    ];
    expect(Object.keys(withPageFields(a, last))).toEqual(keys);
    expect(
      withPageFields(a, { ...last, nextOffset: undefined }),
    ).not.toHaveProperty("nextOffset");
    const more = { ...last, returned: 2, hasMore: true, nextOffset: 2 };
    expect(Object.keys(withPageFields(a, more))).toEqual([
      ...keys.slice(0, 7),
      "nextOffset",
      ...keys.slice(7),
    ]);
    // A page paged again carries its fields once, as the second call gives them.
    const again = withPageFields(withPageFields(a, more), last);
    expect(Object.keys(again)).toEqual(keys);
    expect(again).toEqual(withPageFields(a, last));
    // An answer without stale carries them last.
    expect(Object.keys(withPageFields({ items: [] }, last))).toEqual([
      "items",
      "offset",
      "returned",
      "total",
      "hasMore",
      "note",
    ]);
  });
  it("words the three notes, in items and in characters", () => {
    expect(
      pageNote("items", {
        offset: 0,
        returned: 20,
        total: 45,
        hasMore: true,
        nextOffset: 20,
      }),
    ).toBe("items 1-20 of 45; call again with offset 20 for the next page");
    expect(
      pageNote("items", { offset: 40, returned: 5, total: 45, hasMore: false }),
    ).toBe("items 41-45 of 45; this is the last page");
    expect(
      pageNote("items", { offset: 50, returned: 0, total: 45, hasMore: false }),
    ).toBe("no items at offset 50; there are 45");
    expect(
      pageNote("characters", {
        offset: 0,
        returned: 100,
        total: 250,
        hasMore: true,
        nextOffset: 100,
      }),
    ).toBe(
      "characters 1-100 of 250; call again with offset 100 for the next window",
    );
    expect(
      pageNote("characters", {
        offset: 200,
        returned: 50,
        total: 250,
        hasMore: false,
      }),
    ).toBe("characters 201-250 of 250; this is the last window");
    expect(
      pageNote("characters", {
        offset: 300,
        returned: 0,
        total: 250,
        hasMore: false,
      }),
    ).toBe("no characters at offset 300; there are 250");
  });
});
