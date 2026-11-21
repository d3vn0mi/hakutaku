import { PLANETS } from "./planets";

export interface Star {
  name: string;
  ra: number; // right ascension, degrees
  dec: number; // declination, degrees
  magnitude: number; // visual magnitude: smaller is brighter
}

// The brightest stars of the night sky, as web/data/bright-stars.csv lists them.
export const BRIGHT_STARS: readonly Star[] = [
  { name: "Sirius", ra: 101.287, dec: -16.716, magnitude: -1.46 },
  { name: "Canopus", ra: 95.988, dec: -52.696, magnitude: -0.74 },
  { name: "Arcturus", ra: 213.915, dec: 19.182, magnitude: -0.05 },
  { name: "Vega", ra: 279.235, dec: 38.784, magnitude: 0.03 },
  { name: "Capella", ra: 79.172, dec: 45.998, magnitude: 0.08 },
  { name: "Rigel", ra: 78.634, dec: -8.202, magnitude: 0.13 },
  { name: "Procyon", ra: 114.825, dec: 5.225, magnitude: 0.34 },
  { name: "Betelgeuse", ra: 88.793, dec: 7.407, magnitude: 0.42 },
  { name: "Altair", ra: 297.696, dec: 8.868, magnitude: 0.76 },
  { name: "Aldebaran", ra: 68.98, dec: 16.509, magnitude: 0.86 },
  { name: "Spica", ra: 201.298, dec: -11.161, magnitude: 0.97 },
  { name: "Deneb", ra: 310.358, dec: 45.28, magnitude: 1.25 },
];

// The faintest magnitude the eye reaches under skies of this Bortle class, 1 (darkest) to 9.
export function magnitudeLimit(bortle: number): number {
  const b = Math.min(Math.max(Math.round(bortle), 1), 9);
  return 7.6 - 0.5 * (b - 1);
}

// Stars sorted brightest first, looked up by name in any case.
export class Catalog {
  private readonly stars: Star[];

  constructor(stars: readonly Star[] = BRIGHT_STARS) {
    this.stars = [...stars].sort((a, b) => a.magnitude - b.magnitude);
  }

  get size(): number {
    return this.stars.length;
  }

  lookup(name: string): Star | undefined {
    const wanted = name.toLowerCase();
    return this.stars.find((star) => star.name.toLowerCase() === wanted);
  }

  brightest(count: number): Star[] {
    return this.stars.slice(0, Math.max(0, count));
  }

  visible(bortle: number): Star[] {
    const limit = magnitudeLimit(bortle);
    return this.stars.filter((star) => star.magnitude <= limit);
  }

  // The names of the stars and of the planets, for the search box's suggestions.
  names(): string[] {
    return [...this.stars.map((star) => star.name), ...PLANETS.map((p) => p.name)];
  }
}
