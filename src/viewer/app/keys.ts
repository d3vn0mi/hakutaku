// The page's keys, by KeyboardEvent.key: Esc climbs one level. A key typed into a field (an
// input, a select, a textarea or editable text), or pressed with Ctrl, Alt or Meta, belongs to
// the field or to the browser. Shift does not count: it only picks the character a key types.
export interface KeyActions {
  back(): void;
}

export function bindKeys(actions: KeyActions): void {
  const keys = new Map<string, () => void>([["Escape", () => actions.back()]]);
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
