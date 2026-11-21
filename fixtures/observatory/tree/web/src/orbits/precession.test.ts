import { describe, expect, it } from "vitest";
import { J2000 } from "./constants";
import { centuriesSinceJ2000, precessLongitude } from "./precession";

describe("precession", () => {
  it("counts no time at J2000", () => {
    expect(centuriesSinceJ2000(J2000)).toBe(0);
    expect(precessLongitude(1, J2000)).toBeCloseTo(1);
  });

  it("moves a longitude by about 1.4 degrees a century", () => {
    const moved = precessLongitude(0, J2000 + 36_525);
    expect((moved * 180) / Math.PI).toBeCloseTo(1.397, 3);
  });
});
