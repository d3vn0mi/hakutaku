// The Show toggles in the left panel: code files, tests, libraries and import curves, each with
// its count. A toggle sets the state, and follows it when something else changes it.
import { h } from "../dom.js";
import type { Model } from "../model.js";
import type { StateStore, ViewState } from "../state.js";

type Shown = keyof ViewState["show"];

export function mountShow(
  root: HTMLElement,
  model: Model,
  state: StateStore,
): void {
  const counts = model.map.counts;
  const rows: Array<[Shown, string, number]> = [
    ["production", "Code files", counts.productionFiles],
    ["tests", "Tests", counts.tests],
    ["libraries", "Libraries", counts.libraries],
    ["curves", "Import curves", counts.importEdges],
  ];
  const boxes = new Map<Shown, HTMLInputElement>();
  root.replaceChildren(
    ...rows.map(([shown, label, n]) => {
      const box = h("input", {
        attrs: { type: "checkbox" },
        on: {
          change: () =>
            state.set({ show: { ...state.get().show, [shown]: box.checked } }),
        },
      });
      box.checked = state.get().show[shown];
      boxes.set(shown, box);
      return h(
        "label",
        {},
        box,
        document.createTextNode(label),
        h("span", { class: "n", text: n.toLocaleString("en-US") }),
      );
    }),
  );
  state.subscribe((now, before) => {
    if (now.show === before.show) return;
    for (const [shown, box] of boxes) box.checked = now.show[shown];
  });
}
