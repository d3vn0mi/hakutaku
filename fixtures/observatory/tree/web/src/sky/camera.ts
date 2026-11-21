import { Orbit } from "../orbits/kepler";

// A camera over the plane of the solar system: the point it looks at, in astronomical units,
// and its zoom, in screen pixels per astronomical unit.
export class Camera {
  private center: [number, number] = [0, 0];
  zoom = 100;

  constructor(
    readonly width = 800,
    readonly height = 600,
  ) {}

  // The point the camera looks at.
  position(): [number, number] {
    return [this.center[0], this.center[1]];
  }

  lookAt(x: number, y: number): void {
    this.center = [x, y];
  }

  // Zooms so that a circle of this radius, in astronomical units, fills the shorter side.
  frame(radius: number, margin = 1.1): void {
    this.zoom = Math.min(this.width, this.height) / (2 * radius * margin);
  }

  // Looks at the Sun and zooms out until the orbit's aphelion fits.
  frameOrbit(orbit: Orbit): void {
    this.lookAt(0, 0);
    this.frame(orbit.a * (1 + orbit.e));
  }

  // A point in astronomical units, in pixels from the screen's top left corner.
  toScreen(x: number, y: number): [number, number] {
    return [
      this.width / 2 + (x - this.center[0]) * this.zoom,
      this.height / 2 - (y - this.center[1]) * this.zoom,
    ];
  }
}
