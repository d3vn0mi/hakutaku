// The colour each body is drawn in, by name. Any other body takes the default colour.
const COLORS: Readonly<Record<string, string>> = {
  Mercury: "#b1adad",
  Venus: "#e6d3a3",
  Earth: "#6b93d6",
  Mars: "#c1440e",
  Jupiter: "#d8ca9d",
  Saturn: "#e3e0c0",
};

export const DEFAULT_COLOR = "#f5f3ce";

export function colorFor(name: string): string {
  return COLORS[name] ?? DEFAULT_COLOR;
}

// A star's colour from its B-V colour index: blue-white for hot stars, orange for cool ones.
export function starColor(bv: number): string {
  if (bv < 0) return "#aabfff";
  if (bv < 0.6) return "#f8f7ff";
  if (bv < 1.4) return "#ffd2a1";
  return "#ffb56c";
}
