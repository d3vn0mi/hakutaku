import { describe, expect, it } from "vitest";
import { Camera } from "../sky/camera";
import { Orbit, solveKepler } from "./kepler";

const HALF = 365.25 / 2;

const orbit = new Orbit();

describe("solveKepler", () => {
  it("returns the mean anomaly on a circle", () => {
    expect(solveKepler(1.2, 0)).toBeCloseTo(1.2);
  });

  it("solves the equation for an eccentric orbit", () => {
    const ecc = solveKepler(0.5, 0.6);
    expect(ecc - 0.6 * Math.sin(ecc)).toBeCloseTo(0.5, 10);
  });

  it("refuses an orbit that is not an ellipse", () => {
    expect(() => solveKepler(1, 1)).toThrow(RangeError);
  });
});

describe("Orbit", () => {
  it("starts at perihelion, on the x axis", () => {
    expect(orbit.position(0)).toEqual([1, 0]);
  });

  it.each([[new Orbit()], [Object.assign(new Orbit(), { name: "copy" })]])(
    "is at aphelion after half a period (%#)",
    (o) => {
      expect(o.position(HALF)[0]).toBeCloseTo(-1);
    },
  );

  it("fits in a camera framed on it", () => {
    const camera = new Camera(800, 600);
    camera.frameOrbit(orbit);
    expect(camera.zoom).toBeCloseTo(600 / 2.2);
  });
});
