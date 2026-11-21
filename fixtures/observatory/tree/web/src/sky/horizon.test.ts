import { describe, expect, it } from "vitest";
import { BRIGHT_STARS } from "./catalog";
import { aboveHorizon, altitudeOf, isCircumpolar } from "./horizon";

const LONDON = { latitude: 51.5, longitude: -0.13 };
const SYDNEY = { latitude: -33.9, longitude: 151.2 };
const JD = 2_461_285.0; // 2026-09-01 12:00 UTC

describe("horizon", () => {
  it("keeps altitudes between the horizon's two poles", () => {
    for (const star of BRIGHT_STARS) {
      const alt = altitudeOf(star, LONDON, JD);
      expect(alt).toBeGreaterThanOrEqual(-90);
      expect(alt).toBeLessThanOrEqual(90);
    }
  });

  it("lists only stars that are up, highest first", () => {
    const up = aboveHorizon(BRIGHT_STARS, LONDON, JD);
    const alts = up.map((star) => altitudeOf(star, LONDON, JD));
    expect(alts.every((alt) => alt > 0)).toBe(true);
    expect(alts).toEqual([...alts].sort((a, b) => b - a));
  });

  it("knows that Capella never sets over London, and that Canopus sets over Sydney", () => {
    const capella = BRIGHT_STARS.find((s) => s.name === "Capella");
    const canopus = BRIGHT_STARS.find((s) => s.name === "Canopus");
    expect(capella && isCircumpolar(capella, LONDON)).toBe(true);
    expect(canopus && isCircumpolar(canopus, SYDNEY)).toBe(false);
  });
});
