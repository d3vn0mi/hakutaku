// The lenses in the top bar: Structure, Risk and History, each pressed while the map shows it,
// and Ownership, shown but disabled until there is a decision on what an owner is. Keys 1, 2 and
// 3 choose the same lenses, as each button says in aria-keyshortcuts. A lens other than
// Structure turns the entry points off. The keys move no focus, so a change of lens is said in
// the live region, as a change of depth is, unless a selection made it: the selection says what
// it selected there instead.
import { h } from "../dom.js";
import type { Lens, StateStore } from "../state.js";

const LENSES: ReadonlyArray<readonly [Lens, string, string]> = [
  ["structure", "Structure", "1"],
  ["risk", "Risk", "2"],
  ["history", "History", "3"],
];
const OWNERSHIP = "Later: it needs a decision on what an owner is";

// A lens's name, as its button shows it.
const nameOf = (lens: Lens): string =>
  LENSES.find(([l]) => l === lens)?.[1] ?? lens;

// Shows the map under a lens, in one change of the state.
export function setLens(state: StateStore, lens: Lens): void {
  state.set(lens === "structure" ? { lens } : { lens, entriesOn: false });
}

export function mountLens(
  root: HTMLElement,
  state: StateStore,
  live: HTMLElement,
): void {
  const buttons = LENSES.map(
    ([lens, label, key]) =>
      [
        lens,
        h("button", {
          text: label,
          attrs: {
            type: "button",
            "aria-pressed": "false",
            "aria-keyshortcuts": key,
            title: `Key ${key}`,
          },
          on: { click: () => setLens(state, lens) },
        }),
      ] as const,
  );
  const ownership = h("button", {
    text: "Ownership",
    attrs: {
      type: "button",
      "aria-pressed": "false",
      disabled: "",
      title: OWNERSHIP,
    },
  });
  root.replaceChildren(...buttons.map(([, button]) => button), ownership);
  const press = (now: Lens) => {
    for (const [lens, button] of buttons) {
      button.setAttribute("aria-pressed", String(lens === now));
    }
  };
  press(state.get().lens);
  state.subscribe((now, before) => {
    if (now.lens === before.lens) return;
    press(now.lens);
    if (now.sel === before.sel) live.textContent = `Lens: ${nameOf(now.lens)}.`;
  });
}
