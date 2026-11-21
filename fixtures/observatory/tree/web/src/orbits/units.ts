import { AU_KM, DAY_SECONDS, DEG, TWO_PI } from "./constants";

// An angle in degrees, in radians.
export function toRadians(degrees: number): number {
  return degrees * DEG;
}

// An angle in radians, in degrees.
export function toDegrees(radians: number): number {
  return radians / DEG;
}

// An angle in radians, brought into [0, 2 pi).
export function normalizeAngle(radians: number): number {
  const r = radians % TWO_PI;
  return r < 0 ? r + TWO_PI : r;
}

export function auToKm(au: number): number {
  return au * AU_KM;
}

export function kmToAu(km: number): number {
  return km / AU_KM;
}

export function daysToSeconds(days: number): number {
  return days * DAY_SECONDS;
}
