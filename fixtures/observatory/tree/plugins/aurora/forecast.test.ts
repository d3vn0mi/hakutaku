import { describe, expect, it } from "vitest";
import { auroraChance, kpAt, visibleDownTo } from "./forecast";

describe("aurora forecast", () => {
  it("keeps Kp between quiet and 9", () => {
    for (let t = 0; t < 60; t += 0.5) {
      expect(kpAt(t)).toBeGreaterThanOrEqual(2);
      expect(kpAt(t)).toBeLessThanOrEqual(9);
    }
  });

  it("brings the aurora further south as Kp rises", () => {
    expect(visibleDownTo(8)).toBeLessThan(visibleDownTo(2));
  });

  it("gives a high chance far north and none near the equator", () => {
    expect(auroraChance(5, 70)).toBeCloseTo(0.9);
    expect(auroraChance(5, 10)).toBe(0);
  });
});
