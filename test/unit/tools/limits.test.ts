import { describe, expect, it } from "vitest";
import {
  CORE_SHARE,
  codePoints,
  cutText,
  DEFAULT_MAX_RESULT_CHARS,
  ECHO_CHARS,
  HOTSPOT_MARK,
  INLINE_CAPS,
  LIMITS,
  MAX_ARG_CHARS,
  MAX_CANDIDATES,
  MAX_GLOB_CHARS,
  MAX_SNIPPET_LINES,
  MAX_TEXT_CHARS,
  MIN_SEARCH_CHARS,
  measure,
  REFRESH_INTERVAL_SECONDS,
} from "../../../src/tools/limits.js";

describe("limits", () => {
  it("pins the spec's numbers", () => {
    expect([
      DEFAULT_MAX_RESULT_CHARS,
      MAX_TEXT_CHARS,
      MAX_SNIPPET_LINES,
      MIN_SEARCH_CHARS,
    ]).toEqual([40000, 240, 120, 3]);
    expect(LIMITS).toEqual({
      code_find: { default: 20, max: 200 },
      code_callers: { default: 50, max: 200 },
      code_references: { default: 100, max: 500 },
      code_impact: { default: 50, max: 200 },
      code_deps: { default: 100, max: 500 },
      code_rules: { default: 100, max: 500 },
      code_search_text: { default: 50, max: 200 },
    });
    expect(INLINE_CAPS).toEqual({
      explain: {
        importedBy: 8,
        imports: 8,
        changesTogetherWith: 6,
        definitions: 8,
      },
      component: { core: 6, entryPoints: 6 },
      library: { importedBy: 8 },
      repo: {
        coreSet: 12,
        components: 12,
        dependsOn: 12,
        entryPoints: 12,
        hotspots: 8,
        cycles: 6,
      },
    });
    expect([
      MAX_CANDIDATES,
      MAX_ARG_CHARS,
      ECHO_CHARS,
      MAX_GLOB_CHARS,
      HOTSPOT_MARK,
      CORE_SHARE,
      REFRESH_INTERVAL_SECONDS,
    ]).toEqual([20, 4096, 120, 256, 0.35, 0.5, 600]);
  });
  it("measures as JSON.stringify(value, null, 2).length", () => {
    expect(measure({ a: [1, "é"] })).toBe(
      JSON.stringify({ a: [1, "é"] }, null, 2).length,
    );
  });
  it("cuts text to the limit with an ellipsis and never splits a surrogate pair", () => {
    expect(cutText("abc", 5)).toBe("abc");
    expect(cutText("abcdef", 5)).toBe("abcd…");
    const cut = cutText(`${"a".repeat(238)}😀zz`, 240); // unit 238 is the pair's high half
    expect(cut).toBe(`${"a".repeat(238)}…`);
  });
  it("counts code points, not UTF-16 units", () => {
    expect(codePoints("😀😀")).toBe(2);
  });
});
