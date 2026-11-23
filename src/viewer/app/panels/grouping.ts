// Group by, in the left panel: what the map's sectors and hubs gather files by, their component,
// their top-level folder or their language. The grouping in use is pressed. Choosing another
// hands it to choose(), which clears the selection and lays the map out again; pressing the one
// in use changes nothing.
import { h } from "../dom.js";
import type { Grouping, StateStore } from "../state.js";

const GROUPINGS: ReadonlyArray<readonly [Grouping, string, string]> = [
  ["component", "Component", "repo parts"],
  ["folder", "Folder", "top level"],
  ["language", "Language", "file type"],
];

export function mountGrouping(
  root: HTMLElement,
  state: StateStore,
  choose: (group: Grouping) => void,
): void {
  const buttons = GROUPINGS.map(
    ([group, label, hint]) =>
      [
        group,
        h(
          "button",
          {
            attrs: { type: "button", "aria-pressed": "false" },
            on: {
              click: () => {
                if (state.get().group !== group) choose(group);
              },
            },
          },
          h("span", { text: label }),
          h("small", { text: hint }),
        ),
      ] as const,
  );
  root.replaceChildren(...buttons.map(([, button]) => button));
  const press = (now: Grouping) => {
    for (const [group, button] of buttons) {
      button.setAttribute("aria-pressed", String(group === now));
    }
  };
  press(state.get().group);
  state.subscribe((now, before) => {
    if (now.group !== before.group) press(now.group);
  });
}
