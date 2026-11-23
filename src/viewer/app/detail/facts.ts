// What the details say about a node: a file's facts and the sub-line under a node's name, how each
// of a file's definitions is drawn and named, the tabs each kind of node has, and the counts the
// lists beside a file give. No DOM here: Node tests import it.
import { comparePaths } from "../../../model/order.js";
import type { DefKind } from "../../../model/types.js";
import {
  DEF_KINDS,
  ENTRY_KINDS,
  F,
  FILE_KINDS,
  FLAG_ENTRY,
} from "../../../query/view/constants.js";
import { HOTSPOT_MARK } from "../constants.js";
import { fileColor, INK } from "../map/colors.js";
import type { Model } from "../model.js";
import type { Outline } from "../outline-cache.js";
import type { Sel, Tab } from "../state.js";
import { count } from "../words.js";

const SEP = " \u00b7 ";
const DEV_SCRIPT = ENTRY_KINDS.indexOf("dev-script");

export interface FileFacts {
  lines: number;
  importedBy: number[]; // the files that import it, by rank
  imports: number[]; // the files it imports, by rank
  libraries: number[]; // the libraries it imports, in the map's order
  // the files that change together with it and the commits they share, most first, then by
  // path; null until the outline is loaded
  cochange: Array<[file: number, commits: number]> | null;
  definitions: number;
  // each entry point that names the file: the manifest file that does, its line, its kind and
  // its name, in the map's order
  launchedBy: Array<{
    manifest: number;
    line: number;
    kind: string;
    name: string;
  }>;
}

// Every list is a copy: the model is read, never written.
export function fileFacts(
  model: Model,
  file: number,
  outline: Outline | null,
): FileFacts {
  const { files, entries } = model.map;
  const [start, end] = model.defsOf[file];
  return {
    lines: files[file][F.lines],
    importedBy: [...model.importers[file]],
    imports: [...model.imports[file]],
    libraries: [...model.libsOf[file]],
    cochange:
      outline === null
        ? null
        : outline.cochange
            .map(([partner, commits]): [number, number] => [partner, commits])
            .sort(
              (a, b) =>
                b[1] - a[1] ||
                comparePaths(files[a[0]][F.path], files[b[0]][F.path]),
            ),
    definitions: end - start,
    launchedBy: entries
      .filter(([of]) => of === file)
      .map(([, kind, manifest, line, name]) => ({
        manifest,
        line,
        kind: ENTRY_KINDS[kind],
        name,
      })),
  };
}

// Under a file's name: a production file's rank among the code files, then whether it is an
// entry point, in an import cycle, or a hotspot above the mark; any other file's kind.
export function subLine(model: Model, file: number): string {
  const f = model.map.files[file];
  const kind = FILE_KINDS[f[F.kind]];
  if (kind !== "code") return kind === "test-support" ? "test support" : kind;
  const marks = [`#${f[F.rank]} of ${model.production.length} by dependents`];
  if ((f[F.flags] & FLAG_ENTRY) !== 0) marks.push("entry point");
  if (f[F.cycle] !== 0) marks.push("in an import cycle");
  if (f[F.hotspot] > HOTSPOT_MARK) marks.push("hotspot");
  return marks.join(SEP);
}

// Under any node's name: a file's sub-line, and a definition's file's; a component's code files,
// tests and lines; a library's importers. A group has none.
export function subLineOf(model: Model, sel: Exclude<Sel, null>): string {
  switch (sel.kind) {
    case "file":
    case "definition":
      return subLine(model, sel.file);
    case "component": {
      const [, code, tests, lines] = model.map.components[sel.component];
      return [
        count(code, "code file"),
        count(tests, "test"),
        count(lines, "line"),
      ].join(SEP);
    }
    case "library":
      return `imported by ${count(model.map.externals[sel.external][2], "file")}`;
    case "group":
      return "";
  }
}

// The mark each kind of definition carries in the definitions list.
export const GLYPH: Readonly<Record<DefKind, string>> = Object.freeze({
  function: "\u0192",
  class: "C",
  method: "m",
  constant: "K",
  type: "T",
});

// A definition's dot: "used" when another file uses it, else "exp" when it is exported, else
// nothing (internal); then "method" for a method, and "untested" when no test mentions it.
export function dotClass(model: Model, def: number, tested: boolean): string {
  const { usedBy, exported, kind } = model.map.defs;
  const marks = [usedBy[def] > 0 ? "used" : exported[def] === 1 ? "exp" : ""];
  if (DEF_KINDS[kind[def]] === "method") marks.push("method");
  if (!tested) marks.push("untested");
  return marks.join(" ").trim();
}

// What a dot says, in its title and to a screen reader: what its class shows, in words.
export function dotTitle(model: Model, def: number, tested: boolean): string {
  const { name, kind, line, usedBy } = model.map.defs;
  let title = `${name[def]}${SEP}${DEF_KINDS[kind[def]]}${SEP}line ${line[def]}`;
  if (usedBy[def] > 0) title += `${SEP}used by ${count(usedBy[def], "file")}`;
  if (!tested) title += `${SEP}no test mentions it`;
  return title;
}

// A definition's row in the definitions list: its glyph, its name, its users and its line, and
// the untested mark in words.
export function defRowText(model: Model, def: number, tested: boolean): string {
  const { name, kind, line, usedBy } = model.map.defs;
  const row = `${GLYPH[DEF_KINDS[kind[def]]]}  ${name[def]}${SEP}${count(usedBy[def], "user")}${SEP}line ${line[def]}`;
  return tested ? row : `${row}${SEP}no test mentions it`;
}

// The details' tabs for a node: a file and a definition have all four, a component and a library
// an Overview and their agent's answer, and a group, or nothing selected, none.
export function tabsFor(sel: Sel): readonly Tab[] {
  if (sel === null || sel.kind === "group") return [];
  if (sel.kind === "file" || sel.kind === "definition") {
    return ["overview", "inside", "source", "agent"];
  }
  return ["overview", "agent"];
}

// The file whose outline the details show for a selection: a file's own, or a definition's
// file's; -1 for anything else. The outline cache keeps this one.
export function outlineFileOf(sel: Sel): number {
  return sel !== null && (sel.kind === "file" || sel.kind === "definition")
    ? sel.file
    : -1;
}

// What the lists beside a file say: the files that import it, and its changes in the last 90
// days.
export function importersText(model: Model, file: number): string {
  return count(model.importers[file].length, "importer");
}

export function changesText(model: Model, file: number): string {
  return count(model.map.files[file][F.churn], "change");
}

// A component's code files, by rank.
export function componentFiles(model: Model, component: number): number[] {
  const files = model.map.files;
  return model.production.filter((f) => files[f][F.component] === component);
}

// How bright a code file's dot is drawn, as the Structure lens draws it: "hi" for the files the
// code depends on most, "mid" for the next, nothing for the rest.
export function brightness(model: Model, file: number): "hi" | "mid" | "" {
  const ink = fileColor(model, file, "structure", false);
  return ink === INK.hi ? "hi" : ink === INK.mid ? "mid" : "";
}

// The kinds of entry point that launch a file, each once, in the map's order, leaving out what
// only a developer runs.
export function entryKinds(model: Model, file: number): string[] {
  const kinds: string[] = [];
  for (const [of, kind] of model.map.entries) {
    if (of !== file || kind === DEV_SCRIPT) continue;
    const name = ENTRY_KINDS[kind];
    if (!kinds.includes(name)) kinds.push(name);
  }
  return kinds;
}
