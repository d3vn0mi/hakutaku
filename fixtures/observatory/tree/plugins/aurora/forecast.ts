// A rough aurora forecast from the planetary K index, Kp, which runs from 0 (quiet) to 9 (a
// severe storm).

// The Sun turns once in about 27 days as seen from Earth, so active regions come back round.
const ROTATION_DAYS = 27.27;
const QUIET_KP = 2;

// A modelled Kp for day t: a quiet background with one active region coming round each
// rotation. Good enough to shade a map; not a forecast to plan a night on.
export function kpAt(t: number): number {
  const phase = ((t % ROTATION_DAYS) + ROTATION_DAYS) % ROTATION_DAYS;
  const storm = Math.exp(-((phase - 4) ** 2) / 2);
  return Math.min(9, QUIET_KP + 5 * storm);
}

// The geomagnetic latitude, in degrees, down to which an aurora may be seen at this Kp.
export function visibleDownTo(kp: number): number {
  const clamped = Math.min(Math.max(kp, 0), 9);
  return 66.5 - 2.9 * clamped;
}

// The chance, from 0 to 1, that an observer at this latitude sees an aurora at this Kp.
export function auroraChance(kp: number, latitude: number): number {
  const margin = Math.abs(latitude) - visibleDownTo(kp);
  if (margin >= 5) return 0.9;
  if (margin <= -5) return 0;
  return 0.45 + margin * 0.09;
}
