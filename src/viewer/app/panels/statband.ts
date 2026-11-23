// The stat band over the map: the map's counts, each a button holding its number over its label.
// - code files: every file again, at Files depth under Structure, with the entry points off;
// - entry points: Structure, with the entry points marked in orange, or unmarked again; the
//   button is pressed while they are marked;
// - components: Components depth;
// - cycles: the Risk lens, with the first file of the first cycle selected;
// - tests: shows the tests on the map.
// A depth is picked through pick, which remembers it, as the depth control picks one.
// Under it, at Core depth, the coverage line says what share of the production files carries at
// least half of what the code depends on.
import type { MapData } from "../../../query/view/types.js";
import { coverageLine } from "../depth.js";
import { h } from "../dom.js";
import type { Model } from "../model.js";
import type { Depth, Sel, StateStore } from "../state.js";
import { setLens } from "./lens.js";

type Stat = "files" | "entries" | "components" | "cycles" | "tests";

export function mountStatband(
  root: HTMLElement,
  model: Model,
  state: StateStore,
  select: (sel: Sel) => void,
  pick: (depth: Depth) => void,
): void {
  const counts = model.map.counts;
  const stats: Array<[Stat, number, string]> = [
    ["files", counts.productionFiles, "code files"],
    ["entries", counts.entryPoints, "entry points"],
    ["components", counts.components, "components"],
    ["cycles", counts.cycles, counts.cycles === 1 ? "cycle" : "cycles"],
    ["tests", counts.tests, "tests"],
  ];
  const marked = () => {
    const now = state.get();
    return now.lens === "structure" && now.entriesOn;
  };
  const actions: Record<Stat, () => void> = {
    files: () => {
      state.set({ lens: "structure", entriesOn: false });
      pick("files");
    },
    entries: () => state.set({ lens: "structure", entriesOn: !marked() }),
    components: () => pick("components"),
    cycles: () => {
      setLens(state, "risk");
      const first = model.map.cycles[0]?.[0];
      if (first !== undefined) select({ kind: "file", file: first });
    },
    tests: () => state.set({ show: { ...state.get().show, tests: true } }),
  };
  const buttons = new Map(
    stats.map(([stat, n, label]) => [
      stat,
      h(
        "button",
        {
          attrs: { type: "button", "data-stat": stat },
          on: { click: () => actions[stat]() },
        },
        h("b", { text: n.toLocaleString("en-US") }),
        h("span", { text: label }),
      ),
    ]),
  );
  root.replaceChildren(...buttons.values());
  const entries = buttons.get("entries");
  const press = () => entries?.setAttribute("aria-pressed", String(marked()));
  press();
  state.subscribe(press);
}

// The coverage line in root, shown at Core depth only.
export function mountCoverage(
  root: HTMLElement,
  map: MapData,
  state: StateStore,
): void {
  root.textContent = coverageLine(map);
  const show = () => {
    root.hidden = state.get().depth !== "core";
  };
  show();
  state.subscribe((now, before) => {
    if (now.depth !== before.depth) show();
  });
}
