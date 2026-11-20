import { expect, it } from "vitest";
import {
  locationText,
  readSource,
  sourceLines,
} from "../../../src/query/index.js";
import {
  openStore,
  type Store,
  type StoreContent,
} from "../../../src/store/index.js";
import { emptyContent, miniStore } from "../../helpers/mini-store.js";
import { openTiny, TINY_CTX } from "../../helpers/tiny.js";

// A store of n code files f000.ts …, each with a stored source: texts[i], or "line <i>".
function sourcesStore(n: number, texts: readonly string[] = []): Store {
  const c: StoreContent = emptyContent("tiny");
  for (let i = 0; i < n; i++) {
    const text = texts[i] ?? `line ${i}`;
    c.files.push({
      id: i + 1,
      path: `f${String(i).padStart(3, "0")}.ts`,
      lang: "typescript",
      kind: "code",
      component_id: null,
      lines: 1,
      bytes: text.length,
      blob_sha: "c".repeat(40),
      mode: "100644",
      link_target: null,
      entry: 0,
      has_source: 1,
    });
    c.sources.push({ file_id: i + 1, text });
  }
  return openStore(miniStore(c)) as Store;
}

it("reads redacted source lines", () => {
  const s = openTiny();
  expect(sourceLines(s, 2)?.[4]).toBe(
    '  const key = "«redacted:generic-api-key»";',
  );
  expect(readSource(s, 4)).toBeNull(); // camera.ts has no stored source
});

it("location text is trimmed, cut at 240 and absent when snippets are off", () => {
  const s = openTiny();
  expect(locationText(s, TINY_CTX, 10, 6)).toBe("const p = body.position(t);");
  expect(
    locationText(s, { ...TINY_CTX, snippets: false }, 10, 6),
  ).toBeUndefined();
  expect(locationText(s, TINY_CTX, 4, 1)).toBeUndefined();
  expect(locationText(s, TINY_CTX, 10, 99)).toBeUndefined();
  const long = sourcesStore(1, [`    ${"x".repeat(300)}  `]);
  expect(locationText(long, TINY_CTX, 1, 1)).toBe(`${"x".repeat(239)}…`);
});

it("reads every line of a source, and nothing for a line that does not exist", () => {
  const s = openTiny();
  expect(readSource(s, 14)).toBe(
    "def helper():\n    return 1\n\ndef helper():\n    return 2",
  );
  expect(sourceLines(s, 9)).toHaveLength(16);
  expect(sourceLines(s, 9)?.[1]).toBe("");
  expect(locationText(s, TINY_CTX, 9, 2)).toBe("");
  for (const line of [0, -1, 1.5, 17, Number.NaN])
    expect(locationText(s, TINY_CTX, 9, line)).toBeUndefined();
});

it("counts a source's lines as the store does: no line after a final newline", () => {
  const s = sourcesStore(3, ["a\nb\n", "", "\n"]);
  expect(sourceLines(s, 1)).toEqual(["a", "b"]);
  expect(sourceLines(s, 2)).toEqual([]);
  expect(sourceLines(s, 3)).toEqual([""]);
  expect(locationText(s, TINY_CTX, 1, 3)).toBeUndefined();
});

it("reads nothing from a store built without sources", () => {
  const s = openTiny({ noSource: true });
  expect(readSource(s, 2)).toBeNull();
  expect(sourceLines(s, 2)).toBeNull();
  expect(locationText(s, TINY_CTX, 2, 1)).toBeUndefined();
});

it("keeps the lines of the last 64 files read per store, read-only", () => {
  const s = sourcesStore(65);
  const first = sourceLines(s, 1);
  expect(first).toEqual(["line 0"]);
  expect(Object.isFrozen(first)).toBe(true);
  expect(sourceLines(s, 1)).toBe(first);
  const second = sourceLines(s, 2);
  for (let id = 3; id <= 64; id++) sourceLines(s, id); // 64 files kept
  expect(sourceLines(s, 1)).toBe(first); // read again: 2 is now the oldest
  sourceLines(s, 65); // a 65th file: 2 goes
  expect(sourceLines(s, 1)).toBe(first);
  const again = sourceLines(s, 2);
  expect(again).toEqual(second);
  expect(again).not.toBe(second);
  expect(sourceLines(openTiny(), 2)).not.toBe(sourceLines(openTiny(), 2));
});
