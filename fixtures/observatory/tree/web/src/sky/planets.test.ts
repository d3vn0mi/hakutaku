import { describe, expect, it } from "vitest";
import { nakedEyePlanets, PLANETS, planetNamed } from "./planets";

describe("planets", () => {
  it("lists the six planets out to Saturn", () => {
    expect(PLANETS.map((p) => p.name)).toEqual([
      "Mercury",
      "Venus",
      "Earth",
      "Mars",
      "Jupiter",
      "Saturn",
    ]);
  });

  it("finds a planet by name", () => {
    expect(planetNamed("Mars")?.name).toBe("Mars");
    expect(planetNamed("Pluto")).toBeUndefined();
  });

  it("sees fewer planets under a brighter sky, and never Earth", () => {
    expect(nakedEyePlanets(9).length).toBeLessThanOrEqual(nakedEyePlanets(1).length);
    expect(nakedEyePlanets(1).map((p) => p.name)).not.toContain("Earth");
  });
});
