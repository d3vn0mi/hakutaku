import { describe, expect, it } from "vitest";
import { defaultViewport, onScreen, project } from "./projection";

describe("projection", () => {
  const view = defaultViewport(800, 600);

  it("puts the Sun in the middle of the screen", () => {
    expect(project([0, 0], view)).toEqual([400, 300]);
  });

  it("draws +y upwards", () => {
    const [, y] = project([0, 1], view);
    expect(y).toBeLessThan(300);
  });

  it("rotates counter-clockwise", () => {
    const turned = { ...view, rotation: Math.PI / 2 };
    const [x, y] = project([1, 0], turned);
    expect(x).toBeCloseTo(400);
    expect(y).toBeCloseTo(250);
  });

  it("tells what falls on the screen", () => {
    expect(onScreen([10, 10], view)).toBe(true);
    expect(onScreen([-1, 10], view)).toBe(false);
  });
});
