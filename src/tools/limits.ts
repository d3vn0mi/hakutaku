// Every number of the agent contract, and the three measures the tools share: a result's
// size, a cut that marks itself, and a length counted as a person counts characters.

// The most a result may measure (see measure), unless the host sets its own maxResultChars.
export const DEFAULT_MAX_RESULT_CHARS = 40000;
// The most text a location carries, in UTF-16 units.
export const MAX_TEXT_CHARS = 240;
// The most lines one code_snippet call returns.
export const MAX_SNIPPET_LINES = 120;
// The shortest search text, in code points.
export const MIN_SEARCH_CHARS = 3;

const limit = (dflt: number, max: number) =>
  Object.freeze({ default: dflt, max });

// Each paged tool's `limit`: its default, and the most it accepts. code_impact counts the
// nodes it reaches: definitions, files and tests.
export const LIMITS: Readonly<
  Record<
    | "code_find"
    | "code_callers"
    | "code_references"
    | "code_impact"
    | "code_deps"
    | "code_rules"
    | "code_search_text",
    { default: number; max: number }
  >
> = Object.freeze({
  code_find: limit(20, 200),
  code_callers: limit(50, 200),
  code_references: limit(100, 500),
  code_impact: limit(50, 200),
  code_deps: limit(100, 500),
  code_rules: limit(100, 500),
  code_search_text: limit(50, 200),
});

// The fixed caps of the lists inside an answer, which take the form { total, top }.
export const INLINE_CAPS = Object.freeze({
  explain: Object.freeze({
    importedBy: 8,
    imports: 8,
    changesTogetherWith: 6,
    definitions: 8,
  }),
  component: Object.freeze({ core: 6, entryPoints: 6 }),
  library: Object.freeze({ importedBy: 8 }),
  repo: Object.freeze({
    coreSet: 12,
    components: 12,
    dependsOn: 12,
    entryPoints: 12,
    hotspots: 8,
    cycles: 6,
  }),
});

// The most candidates an ambiguous or not_found error lists; its message gives the full count.
export const MAX_CANDIDATES = 20;
// The longest string argument, in UTF-16 units. A longer one is invalid_argument before any work.
export const MAX_ARG_CHARS = 4096;
// The most of a model's input an error message quotes (see echo).
export const ECHO_CHARS = 120;
// The longest path_glob.
export const MAX_GLOB_CHARS = 256;
// The hotspot score from which a file counts as a hotspot.
export const HOTSPOT_MARK = 0.35;
// The core set's default share: it carries at least this share of the PageRank.
export const CORE_SHARE = 0.5;
// A repo is rebuilt at most once in this many seconds.
export const REFRESH_INTERVAL_SECONDS = 600;

// A result's size: the length of the text the MCP server sends for it.
export function measure(value: unknown): number {
  return JSON.stringify(value, null, 2).length;
}

// U+2026 HORIZONTAL ELLIPSIS, one UTF-16 unit.
const ELLIPSIS = "…";

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

// s, at most max UTF-16 units long. A longer s keeps its first max - 1 units and ends with an
// ellipsis; where that cut would split a surrogate pair, it keeps one unit less.
export function cutText(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max < 1) return "";
  let end = max - 1;
  if (
    end > 0 &&
    isHighSurrogate(s.charCodeAt(end - 1)) &&
    isLowSurrogate(s.charCodeAt(end))
  ) {
    end -= 1;
  }
  return `${s.slice(0, end)}${ELLIPSIS}`;
}

// The length of s in code points, as a person counts characters. A lone surrogate counts as one.
export function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}
