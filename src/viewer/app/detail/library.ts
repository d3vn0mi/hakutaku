// A library's Overview: the files that import it, by rank, "test" beside a test, each a row that
// selects its file.
import { importerRow, type PaneContext, rowList } from "./overview.js";

export function libraryOverview(ctx: PaneContext, external: number): Node[] {
  const { model } = ctx;
  return [
    rowList(
      ctx,
      "Imported by",
      model.importersOfLib[external].map((file) => importerRow(model, file)),
      "Nothing imports it.",
    ),
  ];
}
