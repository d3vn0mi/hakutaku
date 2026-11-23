// Depth, in the left panel: Components, the hubs alone; Core, the files that matter most; Files,
// every file. The depth in use is pressed, and D steps through them in this order, with or
// without Shift, as each button says in aria-keyshortcuts. A button picks its depth through
// pick, which remembers it. D moves no focus, so a change of depth is said in the live region,
// unless a selection made it: the selection says what it selected there instead.
import { DEPTHS } from "../depth.js";
import { h } from "../dom.js";
import type { Depth, StateStore } from "../state.js";

// Each depth's name, and a hint of what it shows.
const NAMES: Readonly<Record<Depth, readonly [string, string]>> = {
  components: ["Components", "the big picture"],
  core: ["Core", "what matters most"],
  files: ["Files", "every module"],
};

export function mountDepth(
  root: HTMLElement,
  state: StateStore,
  live: HTMLElement,
  pick: (depth: Depth) => void,
): void {
  const buttons = DEPTHS.map((depth) => {
    const [name, hint] = NAMES[depth];
    const button = h(
      "button",
      {
        attrs: {
          type: "button",
          "aria-pressed": "false",
          "aria-keyshortcuts": "D Shift+D",
        },
        on: { click: () => pick(depth) },
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
    if (now.depth === before.depth) return;
    press(now.depth);
    if (now.sel === before.sel) {
      const [name, hint] = NAMES[now.depth];
      live.textContent = `Depth: ${name}, ${hint}.`;
    }
  });
}
