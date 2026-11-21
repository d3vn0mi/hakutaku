import type { Body } from "./body";
import { BACKGROUND, type Canvas } from "./canvas";
import { defaultViewport } from "./projection";
import { drawSky } from "./render";
import { defaultLayers } from "./scene";

// One frame of the sky map at day t: the background, each layer back to front, then the bodies
// on top, at `scale` pixels per astronomical unit when one is given. Returns how many bodies
// were on the screen.
export function drawFrame(
  canvas: Canvas,
  bodies: readonly Body[],
  t: number,
  scale?: number,
): number {
  const view = defaultViewport(canvas.width, canvas.height);
  if (scale !== undefined) view.scale = scale;
  canvas.clear(BACKGROUND);
  for (const layer of defaultLayers()) {
    layer.draw(canvas, view, t);
  }
  return drawSky(canvas, bodies, t, view);
}
