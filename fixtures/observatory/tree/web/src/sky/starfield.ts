import type { Canvas } from "./canvas";
import { BRIGHT_STARS, type Star } from "./catalog";
import { DEFAULT_COLOR } from "./colors";
import { FIGURES, segmentsOf } from "./constellations";
import { project, type Viewport } from "./projection";

const FIGURE_COLOR = "#2c3e66";

// The background layer: the bright stars on a ring far outside the planets, each placed by its
// right ascension and sized by its magnitude, joined into constellation figures.
export class StarField {
  readonly name = "stars";

  constructor(
    private readonly stars: readonly Star[] = BRIGHT_STARS,
    private readonly ring = 40,
  ) {}

  draw(canvas: Canvas, view: Viewport, _t: number): void {
    const at = (star: Star): [number, number] => {
      const ra = (star.ra * Math.PI) / 180;
      return project([this.ring * Math.cos(ra), this.ring * Math.sin(ra)], view);
    };
    for (const figure of Object.keys(FIGURES)) {
      for (const [from, to] of segmentsOf(figure, this.stars)) {
        canvas.line([at(from), at(to)], FIGURE_COLOR);
      }
    }
    for (const star of this.stars) {
      const [x, y] = at(star);
      canvas.dot(x, y, this.radiusOf(star), DEFAULT_COLOR);
    }
  }

  // Brighter stars are drawn bigger, and none smaller than half a pixel.
  radiusOf(star: Star): number {
    return Math.max(0.5, 2.5 - 0.6 * star.magnitude);
  }
}
