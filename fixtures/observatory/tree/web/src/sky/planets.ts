import { MEAN_ELEMENTS } from "../orbits/elements";
import { Orbit } from "../orbits/kepler";
import { toRadians } from "../orbits/units";
import type { Body } from "./body";
import { magnitudeLimit } from "./catalog";

// The planets on their mean J2000 orbits, drawn as bodies: an Orbit has a body's shape.
export const PLANETS: readonly Body[] = MEAN_ELEMENTS.map((el) =>
  Object.assign(new Orbit(), {
    name: el.name,
    a: el.a,
    e: el.e,
    period: el.period,
    m0: toRadians(el.m0),
  }),
);

// Rough visual magnitudes near a typical opposition or greatest elongation.
const TYPICAL_MAGNITUDE: Readonly<Record<string, number>> = {
  Mercury: -0.4,
  Venus: -4.4,
  Mars: -1.6,
  Jupiter: -2.5,
  Saturn: 0.5,
};

// The planets bright enough to see under skies of this Bortle class; Earth is never one.
export function nakedEyePlanets(bortle: number): Body[] {
  const limit = magnitudeLimit(bortle);
  return PLANETS.filter(
    (planet) => (TYPICAL_MAGNITUDE[planet.name] ?? Number.POSITIVE_INFINITY) <= limit,
  );
}

export function planetNamed(name: string): Body | undefined {
  return PLANETS.find((planet) => planet.name === name);
}
