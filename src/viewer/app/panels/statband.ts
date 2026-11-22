// The stat band over the map: the map's counts, each a button holding its number over its label.
// The tests stat shows the tests on the map.
import { h } from "../dom.js";
import type { Model } from "../model.js";
import type { StateStore } from "../state.js";

type Stat = "files" | "entries" | "components" | "cycles" | "tests";

export function mountStatband(
  root: HTMLElement,
  model: Model,
  state: StateStore,
): void {
  const counts = model.map.counts;
  const stats: Array<[Stat, number, string]> = [
    ["files", counts.productionFiles, "code files"],
    ["entries", counts.entryPoints, "entry points"],
    ["components", counts.components, "components"],
    ["cycles", counts.cycles, counts.cycles === 1 ? "cycle" : "cycles"],
    ["tests", counts.tests, "tests"],
  ];
  const actions: Partial<Record<Stat, () => void>> = {
    tests: () => state.set({ show: { ...state.get().show, tests: true } }),
  };
  root.replaceChildren(
    ...stats.map(([stat, n, label]) =>
      h(
        "button",
        {
          attrs: { type: "button", "data-stat": stat },
          on: { click: () => actions[stat]?.() },
        },
        h("b", { text: n.toLocaleString("en-US") }),
        h("span", { text: label }),
      ),
    ),
  );
}
