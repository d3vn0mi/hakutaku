// The Inside tab of a file or a definition: one dot per definition of the file, in file order,
// its class saying whether other files use it, whether it is exported, whether it is a method and
// whether a test mentions it, with the same said in words in its title and to a screen reader;
// a key to the dots; and the definitions list, every definition in one full-size row each. A dot
// or a row opens its definition's source. Above the inline limit the file's outline is fetched
// when the tab opens, and a note says it is loading until it arrives.
import { h } from "../dom.js";
import type { Outline } from "../outline-cache.js";
import { defRowText, dotClass, dotTitle } from "./facts.js";
import { note, type PaneContext, withOutline } from "./overview.js";

// The key to the dots: each mark's class and what it means.
const KEY: ReadonlyArray<readonly [string, string]> = [
  ["used", "used by other files"],
  ["exp", "exported, unused"],
  ["", "internal"],
  ["untested", "no test mentions it"],
  ["method", "method"],
];

export function insidePane(ctx: PaneContext, file: number): Node[] {
  const [start, end] = ctx.model.defsOf[file];
  if (start === end) return [note("No definitions found in this file.")];
  return withOutline(ctx, file, (outline) => draw(ctx, file, outline));
}

function draw(ctx: PaneContext, file: number, outline: Outline): Node[] {
  const { model } = ctx;
  const { line } = model.map.defs;
  const [start, end] = model.defsOf[file];
  // in file order: by first line, then as the map holds them
  const order = Array.from({ length: end - start }, (_, i) => start + i).sort(
    (a, b) => line[a] - line[b] || a - b,
  );
  const tested = (def: number) => outline.tested[def - start] === 1;
  const open = (def: number) =>
    ctx.pick({ kind: "definition", file, def }, { tab: "source" });
  const dots = order.map((def) => {
    const title = dotTitle(model, def, tested(def));
    return h("button", {
      class: dotClass(model, def, tested(def)),
      attrs: { type: "button", title, "aria-label": title },
      on: { click: () => open(def) },
    });
  });
  const rows = order.map((def) =>
    h(
      "li",
      {},
      h("button", {
        class: "name",
        text: defRowText(model, def, tested(def)),
        attrs: { type: "button" },
        on: { click: () => open(def) },
      }),
    ),
  );
  return [
    note("One dot per definition, in file order; each opens its source."),
    h("div", { class: "dots" }, ...dots),
    h(
      "p",
      { class: "dotkey" },
      ...KEY.map(([mark, meaning]) =>
        h(
          "span",
          {},
          h("i", { class: mark, attrs: { "aria-hidden": "true" } }),
          document.createTextNode(meaning),
        ),
      ),
    ),
    h(
      "section",
      { class: "list" },
      h("h3", { text: "Definitions" }),
      h("ol", { class: "rows defs" }, ...rows),
    ),
  ];
}
