// The filters, in the left panel: a file's language, each with its code files, and its component;
// entry points only; files in a cycle; changed in the last 7, 30 or 90 days; and a hotspot above a
// threshold, which its box turns on, from 0 to 1 in steps of 0.05, starting at the mark. Each
// control sets its field of the view state's filters, which the map dims by and the list view
// lists by, and follows the state when something else changes it.
import { HOTSPOT_MARK } from "../constants.js";
import { h } from "../dom.js";
import { languageCounts } from "../filters.js";
import { languageName, type Model } from "../model.js";
import type { Filters, StateStore } from "../state.js";

const DAYS = [7, 30, 90] as const;

// An index the state holds, or none, as a select's value: "" for none.
const asValue = (index: number | null): string =>
  index === null ? "" : String(index);
const asIndex = (value: string): number | null =>
  value === "" ? null : Number(value);
const threshold = (value: number): string => value.toFixed(2);

export function mountFilters(
  root: HTMLElement,
  model: Model,
  state: StateStore,
): void {
  const set = (patch: Partial<Filters>) =>
    state.set({ filters: { ...state.get().filters, ...patch } });
  const option = (value: string, text: string) =>
    h("option", { text, attrs: { value } });
  // a select under its label, which names it
  const field = (id: string, label: string, choices: HTMLOptionElement[]) => {
    const select = h("select", { attrs: { id } }, ...choices);
    return {
      select,
      el: h(
        "div",
        { class: "field" },
        h("label", { text: label, attrs: { for: id } }),
        select,
      ),
    };
  };
  // a checkbox before its name, which names it
  const check = (label: string) => {
    const box = h("input", { attrs: { type: "checkbox" } });
    return {
      box,
      el: h("label", { class: "check" }, box, document.createTextNode(label)),
    };
  };

  const counts = languageCounts(model);
  const lang = field("filter-lang", "Language", [
    option("", "All languages"),
    ...model.map.langs.map((name, i) =>
      option(String(i), `${languageName(name)} (${counts[i]})`),
    ),
  ]);
  const component = field("filter-component", "Component", [
    option("", "All components"),
    ...model.map.components.map(([path], c) => option(String(c), path)),
  ]);
  const entries = check("Entry points only");
  const cycle = check("Files in a cycle");
  const changed = field("filter-changed", "Changed in the last", [
    option("", "Any"),
    ...DAYS.map((days) => option(String(days), `${days} days`)),
  ]);
  const hot = check("Hotspot above");
  const range = h("input", {
    attrs: {
      type: "range",
      id: "filter-threshold",
      min: "0",
      max: "1",
      step: "0.05",
      value: String(HOTSPOT_MARK),
      "aria-label": "Hotspot threshold",
    },
  });
  const shown = h("output", { attrs: { for: "filter-threshold" } });
  root.replaceChildren(
    lang.el,
    component.el,
    entries.el,
    cycle.el,
    changed.el,
    h("div", { class: "threshold" }, hot.el, shown, range),
  );

  lang.select.addEventListener("change", () =>
    set({ lang: asIndex(lang.select.value) }),
  );
  component.select.addEventListener("change", () =>
    set({ component: asIndex(component.select.value) }),
  );
  entries.box.addEventListener("change", () =>
    set({ entriesOnly: entries.box.checked }),
  );
  cycle.box.addEventListener("change", () =>
    set({ inCycle: cycle.box.checked }),
  );
  changed.select.addEventListener("change", () => {
    const days = Number(changed.select.value);
    set({
      changedWithin: DAYS.find((d) => d === days) ?? null,
    });
  });
  hot.box.addEventListener("change", () =>
    set({ hotspotAbove: hot.box.checked ? Number(range.value) : null }),
  );
  range.addEventListener("input", () => {
    shown.textContent = threshold(Number(range.value));
    if (hot.box.checked) set({ hotspotAbove: Number(range.value) });
  });

  const follow = (f: Filters) => {
    lang.select.value = asValue(f.lang);
    component.select.value = asValue(f.component);
    entries.box.checked = f.entriesOnly;
    cycle.box.checked = f.inCycle;
    changed.select.value = asValue(f.changedWithin);
    hot.box.checked = f.hotspotAbove !== null;
    range.disabled = f.hotspotAbove === null;
    if (f.hotspotAbove !== null) range.value = String(f.hotspotAbove);
    shown.textContent = threshold(Number(range.value));
  };
  follow(state.get().filters);
  state.subscribe((now, before) => {
    if (now.filters !== before.filters) follow(now.filters);
  });
}
