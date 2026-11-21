import { J2000 } from "../orbits/constants";

// The Julian day of 1970-01-01 00:00 UTC.
const UNIX_EPOCH_JD = 2_440_587.5;
const DAY_MS = 86_400_000;

// The Julian day of a moment.
export function julianDay(date: Date): number {
  return date.getTime() / DAY_MS + UNIX_EPOCH_JD;
}

// The moment of a Julian day.
export function fromJulianDay(jd: number): Date {
  return new Date(Math.round((jd - UNIX_EPOCH_JD) * DAY_MS));
}

// Days since J2000, the epoch the orbits are given at.
export function daysSinceJ2000(date: Date): number {
  return julianDay(date) - J2000;
}

// Greenwich mean sidereal time at Julian day jd, in degrees from 0 to 360.
export function siderealDegrees(jd: number): number {
  const gmst = 280.46061837 + 360.98564736629 * (jd - J2000);
  return ((gmst % 360) + 360) % 360;
}
