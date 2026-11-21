import type { Canvas } from "./canvas";
import type { Viewport } from "./projection";

// One layer of the sky map, drawn back to front before the bodies: the star field, then any
// plugin's overlay.
export interface Layer {
  readonly name: string;
  draw(canvas: Canvas, view: Viewport, t: number): void;
}
