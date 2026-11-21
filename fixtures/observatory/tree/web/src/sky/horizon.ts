import { precessLongitude } from "../orbits/precession";
import { siderealDegrees } from "../time/julian";
import type { Star } from "./catalog";

const RAD = Math.PI / 180;

export interface Observer {
  latitude: number; // degrees, north positive
  longitude: number; // degrees, east positive
}

// A star's altitude above the horizon, in degrees, for an observer at Julian day jd. The
// catalog's places are for the equinox of J2000, so the right ascension is first moved on to
// the equinox of date, roughly, by the precession in longitude.
export function altitudeOf(star: Star, observer: Observer, jd: number): number {
  const ra = precessLongitude(star.ra * RAD, jd) / RAD;
  const lst = siderealDegrees(jd) + observer.longitude;
  const hourAngle = (lst - ra) * RAD;
  const dec = star.dec * RAD;
  const lat = observer.latitude * RAD;
  const sinAlt =
    Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(hourAngle);
  return Math.asin(Math.max(-1, Math.min(1, sinAlt))) / RAD;
}

// The stars above the horizon, highest first.
export function aboveHorizon(stars: readonly Star[], observer: Observer, jd: number): Star[] {
  return stars
    .map((star) => ({ star, alt: altitudeOf(star, observer, jd) }))
    .filter(({ alt }) => alt > 0)
    .sort((a, b) => b.alt - a.alt)
    .map(({ star }) => star);
}

// Whether a star never sets for this observer: circumpolar.
export function isCircumpolar(star: Star, observer: Observer): boolean {
  return (
    Math.abs(star.dec) > 90 - Math.abs(observer.latitude) &&
    Math.sign(star.dec) === Math.sign(observer.latitude)
  );
}
