// The list view (L): the map's files as an ordered list of buttons, the production files by rank
// and then, while Tests is on, the test files by path, under the filters in use. It is what a
// screen reader reads for the canvas, and what a browser that cannot draw the map shows in its
// place. It shows LIST_PAGE files, then LIST_PAGE more at each press of the button after them,
// which moves the focus to the first file it added. A press on a file selects that file.
// - Over the map, L opens the list with the focus on its first file; L again, Esc or a pick
//   closes it, and L or Esc gives the focus back to where it was.
// - In a browser that cannot draw the map, the list stands in the map's place, open for good: L
//   moves the focus to its first file, a pick leaves it open, and Esc climbs a level as anywhere.
import { LIST_PAGE } from "./constants.js";
import { h } from "./dom.js";
import { listFiles, listLabel } from "./filters.js";
import type { Model } from "./model.js";
import type { StateStore } from "./state.js";

export interface ListView {
  key(): void; // L
  escape(): boolean; // Esc: true when it closed the list
}

export function mountListView(
  root: HTMLElement,
  model: Model,
  state: StateStore,
  pick: (file: number) => void,
  fixed: boolean,
): ListView {
  const count = h("small");
  const list = h("ol");
  const none = h("p", { class: "none", text: "No file passes the filters." });
  const more = h("button", {
    class: "more",
    attrs: { type: "button" },
    on: { click: () => showMore() },
  });
  root.replaceChildren(
    h("h3", {}, document.createTextNode("Files, ranked "), count),
    list,
    none,
    more,
  );
  // with no file to focus, the focus goes to the list itself, which then says so
  root.tabIndex = -1;
  let files: number[] = [];
  let shown = 0;
  let opener: Element | null = null; // what had the focus when L opened the list

  const choose = (file: number) => {
    pick(file);
    if (!fixed) state.set({ listOpen: false });
  };
  const row = (file: number) =>
    h(
      "li",
      {},
      h("button", {
        class: "file",
        text: listLabel(model, file),
        attrs: { type: "button" },
        on: { click: () => choose(file) },
      }),
    );
  const showMoreButton = () => {
    const left = files.length - shown;
    more.textContent = `Show ${Math.min(LIST_PAGE, left)} more`;
    more.hidden = left <= 0;
  };
  const render = () => {
    const now = state.get();
    files = listFiles(model, now.filters, now.show.tests);
    shown = Math.min(LIST_PAGE, files.length);
    list.replaceChildren(...files.slice(0, shown).map(row));
    count.textContent = `${files.length} ${files.length === 1 ? "file" : "files"}`;
    none.hidden = files.length > 0;
    showMoreButton();
    root.scrollTop = 0;
  };
  const showMore = () => {
    const from = shown;
    shown = Math.min(shown + LIST_PAGE, files.length);
    list.append(...files.slice(from, shown).map(row));
    showMoreButton();
    list.children[from]?.querySelector("button")?.focus();
  };
  const focusFirst = () => {
    (list.querySelector("button") ?? root).focus();
  };
  const close = () => {
    const back = opener;
    opener = null;
    state.set({ listOpen: false });
    if (back instanceof HTMLElement && back.isConnected) back.focus();
  };
  const sync = (open: boolean) => {
    root.hidden = !open;
    if (open) render();
  };

  state.subscribe((now, before) => {
    if (now.listOpen !== before.listOpen) sync(now.listOpen);
    else if (
      now.listOpen &&
      (now.filters !== before.filters || now.show.tests !== before.show.tests)
    ) {
      render();
    }
  });
  if (fixed && !state.get().listOpen) state.set({ listOpen: true });
  else sync(state.get().listOpen);

  return {
    key() {
      if (fixed) {
        focusFirst();
      } else if (state.get().listOpen) {
        close();
      } else {
        opener = document.activeElement;
        state.set({ listOpen: true });
        focusFirst();
      }
    },
    escape() {
      if (fixed || !state.get().listOpen) return false;
      close();
      return true;
    },
  };
}
