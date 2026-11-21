import { describe, expect, it } from "vitest";
import { describeSource, toOrbit } from "./ephemeris-client";

describe("ephemeris client", () => {
  it("names the service's host as the source", () => {
    expect(describeSource()).toBe("ephemeris.example.org");
  });

  it("makes an orbit from a record, the mean anomaly in radians", () => {
    const orbit = toOrbit({
      name: "Mars",
      a: 1.524,
      e: 0.0934,
      period: 686.98,
      m0: 180,
      epoch: "2000-01-01T12:00:00Z",
    });
    expect(orbit.name).toBe("Mars");
    expect(orbit.m0).toBeCloseTo(Math.PI);
  });
});
