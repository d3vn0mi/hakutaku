// The breadcrumb in the top bar: Map, then each level the selection climbs through as Esc climbs,
// down to the selection itself, marked as where you are. Each level above it is a button that
// selects it, and Map clears the selection. The separators are text, so each crumb is one
// element.
import { F } from "../../../query/view/constants.js";
import { h } from "../dom.js";
import { defName, type Model } from "../model.js";
import { parentOf } from "../routing.js";
import type { Grouping, Sel } from "../state.js";

// What a crumb says: a file's name (its path in its title), a definition's name as defName gives
// it, a hub's path or key, or a library's name.
function label(
  model: Model,
  sel: Exclude<Sel, null>,
): [text: string, title: string] {
  const { files, components, externals } = model.map;
  switch (sel.kind) {
    case "file": {
      const path = files[sel.file][F.path];
      return [path.slice(path.lastIndexOf("/") + 1), path];
    }
    case "definition": {
      const name = defName(model, sel.def);
      return [name, name];
    }
    case "component":
      return [components[sel.component][0], components[sel.component][0]];
    case "group":
      return [sel.key, sel.key];
    case "library":
      return [externals[sel.external][1], externals[sel.external][1]];
  }
}

export function renderCrumbs(
  root: HTMLElement,
  model: Model,
  sel: Sel,
  g: Grouping,
  go: (sel: Sel) => void,
): void {
  const trail: Array<Exclude<Sel, null>> = [];
  for (let at = sel; at !== null; at = parentOf(model, at, g))
    trail.unshift(at);
  const here = { "aria-current": "location" };
  const map = h("button", {
    text: "Map",
    attrs: sel === null ? { type: "button", ...here } : { type: "button" },
    on: { click: () => go(null) },
  });
  const crumbs: Node[] = [map];
  trail.forEach((level, i) => {
    const [text, title] = label(model, level);
    crumbs.push(
      document.createTextNode(" / "),
      i === trail.length - 1
        ? h("span", { class: "here", text, attrs: { title, ...here } })
        : h("button", {
            text,
            attrs: { type: "button", title },
            on: { click: () => go(level) },
          }),
    );
  });
  root.replaceChildren(...crumbs);
}
