// What the live region says when something is selected: its kind, its name, and where it
// stands. No DOM here: Node tests import it.
import { ECOSYSTEMS, F, FILE_KINDS } from "../../query/view/constants.js";
import { groupKey, type Model } from "./model.js";
import type { Grouping, Sel } from "./state.js";

const TEST = FILE_KINDS.indexOf("test");
const TEST_SUPPORT = FILE_KINDS.indexOf("test-support");

// What a group is called under each grouping.
const GROUP_WORD: Readonly<Record<Grouping, string>> = {
  component: "component",
  folder: "folder",
  language: "language",
};

// "1 file", "2 files".
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// A production file says its rank among the code files; a test, or a file off the map, has no
// rank to say. Nothing selected says nothing.
export function announcement(model: Model, sel: Sel, g: Grouping): string {
  if (sel === null) return "";
  const { files, defs, components, externals } = model.map;
  switch (sel.kind) {
    case "file": {
      const file = files[sel.file];
      const rank = file[F.rank];
      if (rank > 0) {
        return `Selected file ${file[F.path]}, rank ${rank} of ${model.production.length}.`;
      }
      const kind = file[F.kind];
      const test = kind === TEST || kind === TEST_SUPPORT;
      return `Selected ${test ? "test file" : "file"} ${file[F.path]}.`;
    }
    case "definition":
      return `Selected definition ${defs.name[sel.def]} in ${files[sel.file][F.path]}, line ${defs.line[sel.def]}.`;
    case "component": {
      const [path, code] = components[sel.component];
      return `Selected component ${path}, ${count(code, "code file")}.`;
    }
    case "group": {
      const code = model.production.filter(
        (f) => groupKey(model, f, g) === sel.key,
      ).length;
      return `Selected ${GROUP_WORD[g]} ${sel.key}, ${count(code, "code file")}.`;
    }
    case "library": {
      const [ecosystem, name, importers] = externals[sel.external];
      return `Selected library ${ECOSYSTEMS[ecosystem]}:${name}, imported by ${count(importers, "file")}.`;
    }
  }
}
