// The details' tabs, under the header: Overview, Inside, Source and Agent for a file or a
// definition, Overview and Agent for a component or a library, and none for a group. Each tab is
// a button with role="tab" and aria-selected that controls the one tabpanel, #pane; every tab
// stays in the tab order. Beside them, Wide or Narrow toggles .app.wide, which widens the
// details.
// - A tab shows the state's tab; choosing one changes only the pane, so the focus stays on the
//   tab, and opening Source also widens the details.
// - A node's rows and dots select through the selection, with the tab they open: a row the
//   Overview, a definition its source, widened, and an entry point its manifest's source at the
//   line, which the Source tab is given.
// - Every pane reads outlines from the page's one outline cache.
import { h } from "../dom.js";
import type { Model } from "../model.js";
import type { OutlineCache } from "../outline-cache.js";
import type { Sel, StateStore, Tab } from "../state.js";
import { componentOverview } from "./component.js";
import { tabsFor } from "./facts.js";
import { insidePane } from "./inside.js";
import { libraryOverview } from "./library.js";
import {
  definitionOverview,
  fileOverview,
  type PaneContext,
} from "./overview.js";

const NAMES: Readonly<Record<Tab, string>> = {
  overview: "Overview",
  inside: "Inside",
  source: "Source",
  agent: "Agent",
};

export interface DetailTabs {
  // The tab bar and the pane for a node, the pane showing the state's tab; nothing for a node
  // without tabs. line is the line the Source tab is to show, or null.
  render(sel: Exclude<Sel, null>, line: number | null): HTMLElement[];
}

interface Shown {
  sel: Exclude<Sel, null>;
  line: number | null;
  tabs: ReadonlyMap<Tab, HTMLButtonElement>;
  pane: HTMLElement;
  wide: HTMLButtonElement;
}

export function createTabs(deps: {
  model: Model;
  state: StateStore;
  outlines: OutlineCache;
  select(sel: Sel, opts: { tab?: Tab; line?: number }): void;
}): DetailTabs {
  const { model, state, outlines } = deps;
  const app = document.getElementById("app");
  let shown: Shown | null = null;

  const ctx: PaneContext = {
    model,
    outlines,
    pick(sel, opts = {}) {
      if (opts.tab === "source") state.set({ wide: true });
      deps.select(sel, opts);
    },
  };

  // What a tab shows for a node. The Source and Agent tabs are drawn by their own modules.
  const paneOf = (sel: Exclude<Sel, null>, tab: Tab): Node[] => {
    if (tab === "overview") {
      switch (sel.kind) {
        case "file":
          return fileOverview(ctx, sel.file);
        case "definition":
          return definitionOverview(ctx, sel.file, sel.def);
        case "component":
          return componentOverview(ctx, sel.component);
        case "library":
          return libraryOverview(ctx, sel.external);
        case "group":
          return [];
      }
    }
    if (
      tab === "inside" &&
      (sel.kind === "file" || sel.kind === "definition")
    ) {
      return insidePane(ctx, sel.file);
    }
    return [];
  };

  // Marks the state's tab, or the node's first when it has not that one, and fills the pane.
  const fill = (now: Shown) => {
    const want = state.get().tab;
    const tab = now.tabs.has(want) ? want : [...now.tabs.keys()][0];
    for (const [t, button] of now.tabs) {
      button.setAttribute("aria-selected", String(t === tab));
    }
    now.pane.setAttribute("aria-labelledby", `tab-${tab}`);
    now.pane.replaceChildren(...paneOf(now.sel, tab));
  };

  const syncWide = () => {
    const wide = state.get().wide;
    app?.classList.toggle("wide", wide);
    if (shown !== null) shown.wide.textContent = wide ? "Narrow" : "Wide";
  };

  state.subscribe((now, before) => {
    if (now.wide !== before.wide) syncWide();
    // a new selection draws its details itself
    if (
      now.tab !== before.tab &&
      now.sel === before.sel &&
      shown?.pane.isConnected === true
    ) {
      fill(shown);
    }
  });
  syncWide();

  return {
    render(sel, line) {
      const own = tabsFor(sel);
      if (own.length === 0) {
        shown = null;
        return [];
      }
      const tabs = new Map(
        own.map((tab) => [
          tab,
          h("button", {
            text: NAMES[tab],
            attrs: {
              type: "button",
              role: "tab",
              id: `tab-${tab}`,
              "aria-controls": "pane",
              "aria-selected": "false",
            },
            on: {
              click: () =>
                state.set(tab === "source" ? { tab, wide: true } : { tab }),
            },
          }),
        ]),
      );
      const wide = h("button", {
        class: "wide",
        attrs: { type: "button" },
        on: { click: () => state.set({ wide: !state.get().wide }) },
      });
      const pane = h("div", { attrs: { id: "pane", role: "tabpanel" } });
      shown = { sel, line, tabs, pane, wide };
      syncWide();
      fill(shown);
      return [
        h(
          "div",
          { class: "tabs" },
          h(
            "div",
            { attrs: { role: "tablist", "aria-label": "Details" } },
            ...tabs.values(),
          ),
          wide,
        ),
        pane,
      ];
    },
  };
}
