// The page's keys, by KeyboardEvent.key: F or / finds, Esc climbs one level, 1, 2 and 3 choose
// the Structure, Risk and History lenses, and D steps to the next depth. A key typed into a field
// (an input, a select, a textarea or editable text), or pressed with Ctrl, Alt or Meta, belongs to
// the field or to the browser. Shift does not count: it only picks the character a key types.
// A key handled here does nothing else, so the F or / that moves the focus into the Find box is
// not typed into it.
import type { Lens } from "./state.js";

export interface KeyActions {
  find(): void;
  back(): void;
  lens(lens: Lens): void;
  depth(): void;
}

export function bindKeys(actions: KeyActions): void {
  const keys = new Map<string, () => void>([
    ["f", () => actions.find()],
    ["F", () => actions.find()],
    ["/", () => actions.find()],
    ["Escape", () => actions.back()],
    ["1", () => actions.lens("structure")],
    ["2", () => actions.lens("risk")],
    ["3", () => actions.lens("history")],
    ["d", () => actions.depth()],
    ["D", () => actions.depth()],
  ]);
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    if (e.ctrlKey || e.altKey || e.metaKey || typedInto(e.target)) return;
    const action = keys.get(e.key);
    if (action === undefined) return;
    e.preventDefault();
    action();
  });
}

function typedInto(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}
