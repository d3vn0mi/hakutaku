import { describe, expect, it } from "vitest";
import { daysSinceJ2000, fromJulianDay, julianDay, siderealDegrees } from "./julian";

describe("julian days", () => {
  it("knows the Julian day of J2000", () => {
    expect(julianDay(new Date("2000-01-01T12:00:00Z"))).toBe(2_451_545);
    expect(daysSinceJ2000(new Date("2000-01-02T12:00:00Z"))).toBe(1);
  });

  it("goes back from a Julian day to the same moment", () => {
    const moment = new Date("2026-09-01T12:00:00Z");
    expect(fromJulianDay(julianDay(moment)).toISOString()).toBe(moment.toISOString());
  });

  it("gives sidereal time in one turn", () => {
    const gmst = siderealDegrees(2_461_285.0);
    expect(gmst).toBeGreaterThanOrEqual(0);
    expect(gmst).toBeLessThan(360);
  });
});
