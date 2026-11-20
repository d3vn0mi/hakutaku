// Name match levels, from closest to farthest. Case is folded with String.prototype.toLowerCase
// only, never by locale.

export type MatchLevel = "exact" | "case" | "prefix" | "substring";

// The levels in order, closest first.
export const MATCH_LEVELS: readonly MatchLevel[] = Object.freeze([
  "exact",
  "case",
  "prefix",
  "substring",
]);

// The closest level at which query matches one of names: exact when a name equals it; case when
// they are equal lower-cased; prefix when a lower-cased name starts with the lower-cased query;
// substring when one contains it. Null when no name matches.
export function matchLevel(
  query: string,
  names: readonly string[],
): MatchLevel | null {
  const folded = query.toLowerCase();
  let best = MATCH_LEVELS.length;
  for (const name of names) {
    if (name === query) return "exact";
    const lower = name.toLowerCase();
    const level =
      lower === folded
        ? 1
        : lower.startsWith(folded)
          ? 2
          : lower.includes(folded)
            ? 3
            : MATCH_LEVELS.length;
    if (level < best) best = level;
  }
  return MATCH_LEVELS[best] ?? null;
}
