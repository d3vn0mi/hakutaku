// Constants of the orbit solver. Distances are in astronomical units and times in days, unless
// a name says otherwise.

export const AU_KM = 149_597_870.7;
export const DAY_SECONDS = 86_400;
// The Julian day of 2000-01-01 12:00 TT, the epoch the elements are given at.
export const J2000 = 2_451_545.0;
export const JULIAN_CENTURY_DAYS = 36_525;
export const TWO_PI = 2 * Math.PI;
export const DEG = Math.PI / 180;

// Newton's method stops when a step moves the eccentric anomaly by less than this, in radians,
// or after this many steps.
export const SOLVER_TOLERANCE = 1e-12;
export const SOLVER_MAX_STEPS = 32;
