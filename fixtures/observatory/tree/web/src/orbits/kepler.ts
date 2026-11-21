import { SOLVER_MAX_STEPS, SOLVER_TOLERANCE, TWO_PI } from "./constants";
import { normalizeAngle } from "./units";

// Solves Kepler's equation, M = E - e sin E, for the eccentric anomaly E, by Newton's method.
// mean is the mean anomaly M in radians, and e the eccentricity, from 0 up to but not
// including 1.
export function solveKepler(mean: number, e: number): number {
  if (!(e >= 0 && e < 1)) {
    throw new RangeError(`not an elliptical orbit: e = ${e}`);
  }
  const m = normalizeAngle(mean);
  // Starting from pi converges where starting from M overshoots, at high eccentricities.
  let ecc = e < 0.8 ? m : Math.PI;
  for (let step = 0; step < SOLVER_MAX_STEPS; step++) {
    const delta = (ecc - e * Math.sin(ecc) - m) / (1 - e * Math.cos(ecc));
    ecc -= delta;
    if (Math.abs(delta) < SOLVER_TOLERANCE) break;
  }
  return ecc;
}

// A body on an elliptical orbit around the Sun, in the plane of its orbit, with the Sun at the
// origin and the perihelion on the +x axis. Set its elements once it is made:
//
//   const mars = Object.assign(new Orbit(), { name: "Mars", a: 1.524, e: 0.0934, period: 687 });
export class Orbit {
  name = "unnamed";
  a = 1; // semi-major axis, in astronomical units
  e = 0; // eccentricity
  period = 365.25; // sidereal period, in days
  m0 = 0; // mean anomaly at t = 0, in radians

  // Where the body is t days after t = 0, as [x, y] in astronomical units.
  position(t: number): [number, number] {
    const mean = this.m0 + (TWO_PI * t) / this.period;
    const ecc = solveKepler(mean, this.e);
    const x = this.a * (Math.cos(ecc) - this.e);
    const y = this.a * Math.sqrt(1 - this.e * this.e) * Math.sin(ecc);
    return [x, y];
  }
}
