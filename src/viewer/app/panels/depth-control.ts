// Depth, in the left panel: Components, the hubs alone; Core, the files that matter most; Files,
// every file. The depth in use is pressed, and D steps through them in this order.
import { DEPTHS } from "../depth.js";
import { h } from "../dom.js";
import type { Depth, StateStore } from "../state.js";

// Each depth's name, and a hint of what it shows.
const NAMES: Readonly<Record<Depth, readonly [string, string]>> = {
  components: ["Components", "the big picture"],
  core: ["Core", "what matters most"],
  files: ["Files", "every module"],
};

export function mountDepth(root: HTMLElement, state: StateStore): void {
  const buttons = DEPTHS.map((depth) => {
    const [name, hint] = NAMES[depth];
    const button = h(
      "button",
      {
        attrs: { type: "button", "aria-pressed": "false" },
        on: { click: () => state.set({ depth }) },
      },
      h("span", { text: name }),
      h("small", { text: hint }),
    );
    return [depth, button] as const;
  });
  root.replaceChildren(...buttons.map(([, button]) => button));
  const press = (now: Depth) => {
    for (const [depth, button] of buttons) {
      button.setAttribute("aria-pressed", String(depth === now));
    }
  };
  press(state.get().depth);
  state.subscribe((now, before) => {
    if (now.depth !== before.depth) press(now.depth);
  });
}
