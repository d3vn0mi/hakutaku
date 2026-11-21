import { describeSource } from "../api/ephemeris-client";
import { colorFor, DEFAULT_COLOR } from "./colors";

export interface LegendEntry {
  label: string;
  color: string;
}

// The legend under the sky map: one entry per body drawn, in the colour it is drawn in, then a
// line saying where the positions came from.
export function legendFor(names: readonly string[]): LegendEntry[] {
  const entries = names.map((name) => ({ label: name, color: colorFor(name) }));
  entries.push({ label: `Positions: ${describeSource()}`, color: DEFAULT_COLOR });
  return entries;
}
