// The details header: the kind of node selected and where it belongs, its name, and its stable
// ID in <code> with buttons that copy the ID or its #link. A group of another grouping has no
// ID, so no ID line. The heading takes focus when a node is selected.
import {
  DEF_KINDS,
  ECOSYSTEMS,
  F,
  FILE_KINDS,
} from "../../../query/view/constants.js";
import { h } from "../dom.js";
import { groupKey, type Model } from "../model.js";
import { idOf, tokenOf } from "../routing.js";
import type { Grouping, Sel } from "../state.js";

const SEP = " \u00b7 ";
const TEST = FILE_KINDS.indexOf("test");
const TEST_SUPPORT = FILE_KINDS.indexOf("test-support");

// What a hub is under each grouping.
const HUB_KIND: Readonly<Record<Grouping, string>> = {
  component: "COMPONENT",
  folder: "FOLDER",
  language: "LANGUAGE",
};

// The kind line and the title: a file and its group, a definition's kind and its file, a hub,
// or a library and its ecosystem; then the path, the qualified name, or the name.
function describe(
  model: Model,
  sel: Exclude<Sel, null>,
  g: Grouping,
): [kind: string, title: string] {
  const { files, defs, components, externals } = model.map;
  switch (sel.kind) {
    case "file": {
      const file = files[sel.file];
      const test = file[F.kind] === TEST || file[F.kind] === TEST_SUPPORT;
      const group = groupKey(model, sel.file, g);
      return [`${test ? "TEST FILE" : "FILE"}${SEP}${group}`, file[F.path]];
    }
    case "definition": {
      const kind = DEF_KINDS[defs.kind[sel.def]].toUpperCase();
      return [`${kind}${SEP}${files[sel.file][F.path]}`, defs.name[sel.def]];
    }
    case "component":
      return ["COMPONENT", components[sel.component][0]];
    case "group":
      return [HUB_KIND[g], sel.key];
    case "library": {
      const [ecosystem, name] = externals[sel.external];
      return [`LIBRARY${SEP}${ECOSYSTEMS[ecosystem]}`, name];
    }
  }
}

export function renderHeader(
  model: Model,
  sel: Exclude<Sel, null>,
  g: Grouping,
  copy: (text: string) => void,
): HTMLElement[] {
  const [kind, title] = describe(model, sel, g);
  const header: HTMLElement[] = [
    h("p", { class: "kind", text: kind }),
    h("h2", { text: title, attrs: { tabindex: "-1" } }),
  ];
  const id = idOf(model, sel);
  const token = tokenOf(model, sel);
  if (id !== null && token !== null) {
    header.push(
      h(
        "div",
        { class: "idline" },
        h("code", { text: id, attrs: { title: "Stable ID" } }),
        h("button", {
          text: "Copy ID",
          attrs: { type: "button" },
          on: { click: () => copy(id) },
        }),
        h("button", {
          text: "Copy #link",
          attrs: { type: "button" },
          on: { click: () => copy(`#${token}`) },
        }),
      ),
    );
  }
  return header;
}
