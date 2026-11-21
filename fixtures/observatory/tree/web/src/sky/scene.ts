import type { Layer } from "./layer";
import { StarField } from "./starfield";

// The layers of the default sky, back to front. Plugins add theirs after these.
export function defaultLayers(): Layer[] {
  return [new StarField()];
}
