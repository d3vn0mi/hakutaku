import { describe, expect, it } from "vitest";
import {
  auToKm,
  daysToSeconds,
  kmToAu,
  normalizeAngle,
  toDegrees,
  toRadians,
} from "./units";

describe("units", () => {
  it("converts degrees and radians both ways", () => {
    expect(toRadians(180)).toBeCloseTo(Math.PI);
    expect(toDegrees(Math.PI / 2)).toBeCloseTo(90);
  });

  it("brings an angle into one turn", () => {
    expect(normalizeAngle(-Math.PI / 2)).toBeCloseTo((3 * Math.PI) / 2);
    expect(normalizeAngle(5 * Math.PI)).toBeCloseTo(Math.PI);
  });

  it("converts astronomical units and kilometres", () => {
    expect(kmToAu(auToKm(5.2))).toBeCloseTo(5.2);
  });

  it("counts the seconds in a day", () => {
    expect(daysToSeconds(1.5)).toBe(129_600);
  });
});
