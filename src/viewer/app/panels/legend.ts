// The one-line legend over the map: how to read it under the Structure lens.
const STRUCTURE =
  "Each dot is a file. The closer to the centre, the more of the code depends on it. Curves through the middle are imports between components.";

export function mountLegend(root: HTMLElement): void {
  root.textContent = STRUCTURE;
}
