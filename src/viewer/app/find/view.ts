// The Find box, a combobox over its list of matches. Typing searches the index, and the list under
// the box shows the best matches, the first one active: each name as text beside its kind, with
// the whole name in its title where the list cuts it. The arrows move the active match round the
// list, and open the list again once it is closed; Enter or a click picks a match; Esc closes the
// list and leaves the box. Focus stays in the box, whose aria-activedescendant names the active
// match, so the matches take no focus, and a press on one keeps it there. A query that matches
// nothing lists one option that says so: disabled, never selected, and it picks nothing. Each
// search is measured as the performance entry hakutaku:find.
import { h } from "../dom.js";
import type { FindHit, FindIndex, FindKind } from "./index.js";

// What each kind of match is called beside its name.
const KIND_NAMES: Readonly<Record<FindKind, string>> = {
  file: "file",
  "test-file": "test file",
  function: "function",
  class: "class",
  method: "method",
  constant: "constant",
  type: "type",
  library: "library",
};
const NOTHING = "Nothing matches.";

export interface FindBox {
  focus(): void; // focuses the box with its text selected, so typing replaces it
}

export function mountFind(
  input: HTMLInputElement,
  list: HTMLElement,
  index: () => FindIndex,
  pick: (hit: FindHit) => void,
): FindBox {
  let hits: FindHit[] = [];
  let active = -1;
  const optionId = (i: number) => `${list.id}-${i}`;

  const close = (): void => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };

  const activate = (i: number): void => {
    active = i;
    for (const option of list.children) {
      option.setAttribute("aria-selected", String(option.id === optionId(i)));
    }
    input.setAttribute("aria-activedescendant", optionId(i));
    document.getElementById(optionId(i))?.scrollIntoView({ block: "nearest" });
  };

  // Searches for what the box holds, and lists the matches, or says that nothing matches.
  const show = (): void => {
    const query = input.value;
    hits = [];
    active = -1;
    if (query.trim() === "") {
      list.replaceChildren();
      close();
      return;
    }
    const found = index(); // built before the search is timed
    const start = performance.now();
    hits = found.search(query);
    performance.measure("hakutaku:find", { start, end: performance.now() });
    list.replaceChildren(
      ...(hits.length === 0
        ? [
            h("div", {
              text: NOTHING,
              attrs: {
                id: `${list.id}-none`,
                role: "option",
                "aria-disabled": "true",
                "aria-selected": "false",
              },
            }),
          ]
        : hits.map((hit, i) =>
            h(
              "div",
              {
                attrs: {
                  id: optionId(i),
                  role: "option",
                  "aria-selected": "false",
                },
              },
              h("span", { text: hit.label, attrs: { title: hit.label } }),
              document.createTextNode(" "),
              h("small", { text: KIND_NAMES[hit.kind] }),
            ),
          )),
    );
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (hits.length > 0) activate(0);
    else input.removeAttribute("aria-activedescendant");
  };

  const choose = (i: number): void => {
    const hit = hits[i];
    if (hit === undefined) return;
    close();
    pick(hit);
  };

  input.addEventListener("input", show);
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (list.hidden) show();
      else if (hits.length > 0) {
        const step = e.key === "ArrowDown" ? 1 : hits.length - 1;
        activate((active + step) % hits.length);
      }
    } else if (e.key === "Enter") {
      if (list.hidden || active < 0) return;
      e.preventDefault();
      choose(active);
    } else if (e.key === "Escape") {
      // the box's own: it neither climbs a level nor, in a search box, empties the box
      e.preventDefault();
      close();
      input.blur();
    }
  });
  // A press on a match keeps the focus in the box, and the click that follows picks it.
  list.addEventListener("mousedown", (e) => e.preventDefault());
  list.addEventListener("click", (e) => {
    const option =
      e.target instanceof Element ? e.target.closest('[role="option"]') : null;
    if (option !== null) choose([...list.children].indexOf(option));
  });
  // Focus leaving the box, or a click outside the box and its list, closes the list.
  input.addEventListener("blur", close);
  document.addEventListener("click", (e) => {
    const inside =
      e.target instanceof Node &&
      (input.contains(e.target) || list.contains(e.target));
    if (!inside) close();
  });

  return {
    focus() {
      input.focus();
      input.select();
    },
  };
}
