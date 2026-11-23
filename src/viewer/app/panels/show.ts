// The Show toggles in the left panel: code files, tests, libraries and import curves, each with
// its count. A toggle sets the state, and follows it when something else changes it. Tests can
// change nothing at Core and Components depth, which draw no tests, unless the list view is open
// over the map or in its place, since it lists them at every depth: there the toggle is off, and
// a line under it says why. It is off through aria-disabled, not disabled, so that it keeps the
// focus when a key turns it off and Tab still reaches it and its reason; a click, Space
// included, then changes nothing.
import { h } from "../dom.js";
import type { Model } from "../model.js";
import type { StateStore, ViewState } from "../state.js";

type Shown = keyof ViewState["show"];

const WHY_NO_TESTS = "The map shows tests at Files depth only.";

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
  const why = h("p", {
    class: "why",
    text: WHY_NO_TESTS,
    attrs: { id: "tests-why" },
  });
  root.replaceChildren(
    ...rows.flatMap(([shown, label, n]) => {
      const box = h("input", {
        attrs: { type: "checkbox" },
        on: {
          click: (e) => {
            if (box.getAttribute("aria-disabled") === "true")
              e.preventDefault();
          },
          change: () =>
            state.set({ show: { ...state.get().show, [shown]: box.checked } }),
        },
      });
      box.checked = state.get().show[shown];
      boxes.set(shown, box);
      const row = h(
        "label",
        {},
        box,
        document.createTextNode(label),
        h("span", { class: "n", text: n.toLocaleString("en-US") }),
      );
      return shown === "tests" ? [row, why] : [row];
    }),
  );
  const tests = boxes.get("tests");
  // Tests is off while nothing it shows is drawn or listed, and says why
  const follow = (now: ViewState) => {
    const off = !now.listOpen && now.depth !== "files";
    if (tests === undefined) return;
    why.hidden = !off;
    if (off) {
      tests.setAttribute("aria-disabled", "true");
      tests.setAttribute("aria-describedby", why.id);
    } else {
      tests.removeAttribute("aria-disabled");
      tests.removeAttribute("aria-describedby");
    }
  };
  follow(state.get());
  state.subscribe((now, before) => {
    if (now.show !== before.show) {
      for (const [shown, box] of boxes) box.checked = now.show[shown];
    }
    if (now.depth !== before.depth || now.listOpen !== before.listOpen) {
      follow(now);
    }
  });
}
