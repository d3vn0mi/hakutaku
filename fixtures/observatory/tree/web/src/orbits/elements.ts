// Mean orbital elements of the planets at J2000: the semi-major axis a in astronomical units,
// the eccentricity e, the sidereal period in days, and the mean anomaly m0 in degrees.
export interface MeanElements {
  name: string;
  a: number;
  e: number;
  period: number;
  m0: number;
}

export const MEAN_ELEMENTS: readonly MeanElements[] = [
  { name: "Mercury", a: 0.387098, e: 0.20563, period: 87.969, m0: 174.796 },
  { name: "Venus", a: 0.723332, e: 0.006772, period: 224.701, m0: 50.115 },
  { name: "Earth", a: 1.000001, e: 0.016709, period: 365.256, m0: 358.617 },
  { name: "Mars", a: 1.523679, e: 0.0934, period: 686.98, m0: 19.373 },
  { name: "Jupiter", a: 5.2044, e: 0.0489, period: 4332.59, m0: 20.02 },
  { name: "Saturn", a: 9.5826, e: 0.0565, period: 10759.22, m0: 317.02 },
];

// The elements of the planet with this name, or undefined.
export function elementsOf(name: string): MeanElements | undefined {
  return MEAN_ELEMENTS.find((el) => el.name === name);
}
