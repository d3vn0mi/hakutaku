import { describe, expect, it } from "vitest";
import { Camera } from "./camera";

describe("Camera", () => {
  it("maps the point it looks at to the screen's centre", () => {
    const camera = new Camera(800, 600);
    camera.lookAt(2, -1);
    expect(camera.toScreen(2, -1)).toEqual([400, 300]);
  });

  it("frames a radius on the shorter side", () => {
    const camera = new Camera(800, 600);
    camera.frame(3, 1);
    expect(camera.zoom).toBeCloseTo(100);
  });

  it("draws +y upwards", () => {
    const camera = new Camera();
    const [, y] = camera.toScreen(0, 1);
    expect(y).toBeLessThan(300);
  });
});
