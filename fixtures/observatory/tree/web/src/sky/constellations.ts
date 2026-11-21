import type { Star } from "./catalog";

// Stick figures of a few constellations, as pairs of star names to join with a line. Only the
// stars of the bright-star catalog appear, so the figures are sketches.
export const FIGURES: Readonly<Record<string, ReadonlyArray<[string, string]>>> = {
  Orion: [["Betelgeuse", "Rigel"]],
  "Summer Triangle": [
    ["Vega", "Deneb"],
    ["Deneb", "Altair"],
    ["Altair", "Vega"],
  ],
  "Winter Hexagon": [
    ["Sirius", "Procyon"],
    ["Procyon", "Capella"],
    ["Capella", "Aldebaran"],
    ["Aldebaran", "Rigel"],
    ["Rigel", "Sirius"],
  ],
};

// A figure's segments as pairs of stars, leaving out any segment whose stars are not given.
export function segmentsOf(figure: string, stars: readonly Star[]): Array<[Star, Star]> {
  const byName = new Map(stars.map((star) => [star.name, star]));
  const segments: Array<[Star, Star]> = [];
  for (const [from, to] of FIGURES[figure] ?? []) {
    const a = byName.get(from);
    const b = byName.get(to);
    if (a !== undefined && b !== undefined) segments.push([a, b]);
  }
  return segments;
}
