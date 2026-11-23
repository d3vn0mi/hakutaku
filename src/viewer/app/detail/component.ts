// A component's Overview: its code files as dots, by rank, each as bright as the Structure lens
// draws it, so the brightest are the files the code depends on most, each dot named by its path
// and sub-line; then its core files, the top ROWS_SHOWN by rank, each with its importers; then
// its entry points, each with what launches it. A dot or a row selects its file.
import { F, FLAG_ENTRY } from "../../../query/view/constants.js";
import { ROWS_SHOWN } from "../constants.js";
import { h } from "../dom.js";
import {
  brightness,
  componentFiles,
  entryKinds,
  importersText,
  subLine,
} from "./facts.js";
import { fileRow, note, type PaneContext, rowList } from "./overview.js";

const SEP = " \u00b7 ";
const NO_CODE = "No code files.";

export function componentOverview(ctx: PaneContext, component: number): Node[] {
  const { model } = ctx;
  const { files } = model.map;
  const code = componentFiles(model, component);
  const dots = code.map((file) => {
    const name = `${files[file][F.path]}${SEP}${subLine(model, file)}`;
    return h("button", {
      class: brightness(model, file),
      attrs: { type: "button", title: name, "aria-label": name },
      on: {
        click: () => ctx.pick({ kind: "file", file }, { tab: "overview" }),
      },
    });
  });
  return [
    h(
      "section",
      { class: "list" },
      h("h4", {
        text: "Its files, one dot each, brightest for the most depended-on",
      }),
      code.length === 0 ? note(NO_CODE) : h("div", { class: "dots" }, ...dots),
    ),
    rowList(
      ctx,
      "Core files",
      code
        .slice(0, ROWS_SHOWN)
        .map((file) => fileRow(model, file, importersText(model, file))),
      NO_CODE,
    ),
    rowList(
      ctx,
      "Entry points",
      code
        .filter((file) => (files[file][F.flags] & FLAG_ENTRY) !== 0)
        .map((file) =>
          fileRow(model, file, entryKinds(model, file).join(", ")),
        ),
      "None.",
    ),
  ];
}
