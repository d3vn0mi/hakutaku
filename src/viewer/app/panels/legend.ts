// The one-line legend over the map: how to read it under the lens in use, with entry points on,
// or at Components depth for the grouping in use. It follows the state.
import { legendOf } from "../map/colors.js";
import type { StateStore } from "../state.js";

export function mountLegend(root: HTMLElement, state: StateStore): void {
  const show = () => {
    const text = legendOf(state.get());
    if (root.textContent !== text) root.textContent = text;
  };
  show();
  state.subscribe(show);
}
