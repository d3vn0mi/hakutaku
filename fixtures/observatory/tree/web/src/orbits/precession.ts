import { J2000, JULIAN_CENTURY_DAYS } from "./constants";
import { normalizeAngle, toRadians } from "./units";

// The general precession in longitude near J2000, in degrees per Julian century.
const PRECESSION_PER_CENTURY = 1.39697128;

// Julian centuries since J2000 at Julian day jd.
export function centuriesSinceJ2000(jd: number): number {
  return (jd - J2000) / JULIAN_CENTURY_DAYS;
}

// An ecliptic longitude in radians, moved from the equinox of J2000 to the equinox of date jd.
export function precessLongitude(longitude: number, jd: number): number {
  const shift = toRadians(PRECESSION_PER_CENTURY * centuriesSinceJ2000(jd));
  return normalizeAngle(longitude + shift);
}
