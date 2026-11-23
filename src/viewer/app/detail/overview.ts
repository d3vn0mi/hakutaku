// The Overview tab of a file or a definition, and the parts every pane is built from: a list of
// nodes under its heading, the facts in a <dl>, a note, and a part that waits for an outline.
// - A file's Overview: its facts, then the files that import it (by rank, "test" beside a test),
//   the files it imports, the files that change together with it, its libraries, and the entry
//   points that launch it. Each list shows ROWS_SHOWN rows, then says how many more there are,
//   and each row is a button that selects its node; an entry point's opens its manifest's source
//   at its line.
// - It reads the files that change together from an outline the page holds, and fetches none:
//   above the inline limit a button asks for the outline, and the list follows when it arrives.
// - A definition's Overview: its kind, lines, whether it is exported, the files that use it and
//   whether a test mentions it, then its file's facts. Above the inline limit its lines and tests
//   wait for the outline, and say so.
// An outline that arrives after its pane has gone draws nothing, and one that cannot be had, of
// another build or not at all, draws only a note saying so.
import {
  DEF_KINDS,
  ECOSYSTEMS,
  F,
  FILE_KINDS,
} from "../../../query/view/constants.js";
import { ROWS_SHOWN } from "../constants.js";
import { h } from "../dom.js";
import type { Model } from "../model.js";
import type { Outline, OutlineCache } from "../outline-cache.js";
import type { Sel, Tab } from "../state.js";
import { count, whole } from "../words.js";
import { type FileFacts, fileFacts } from "./facts.js";

const SEP = " \u00b7 ";
const TEST = FILE_KINDS.indexOf("test");
const TEST_SUPPORT = FILE_KINDS.indexOf("test-support");
const LOADING = "Loading the outline\u2026";
const FAILED = "The outline could not be loaded.";

// What a pane needs: the model, the page's one outline cache, and a way to select a node, with
// the tab to show and, for the Source tab, the line to show.
export interface PaneContext {
  model: Model;
  outlines: OutlineCache;
  pick(sel: Exclude<Sel, null>, opts?: { tab?: Tab; line?: number }): void;
}

// One row of a list: its label, the value beside it, and the node it selects.
export interface Row {
  label: string;
  value: string;
  title?: string;
  sel: Exclude<Sel, null>;
  tab?: Tab;
  line?: number;
}

export function note(text: string): HTMLParagraphElement {
  return h("p", { class: "note", text });
}

// The facts, one <dt> and its <dd> after another.
export function factList(facts: Array<[term: string, value: string]>) {
  const dl = h("dl", { class: "facts" });
  for (const [term, value] of facts) {
    dl.append(h("dt", { text: term }), h("dd", { text: value }));
  }
  return dl;
}

// A list's rows: the first ROWS_SHOWN of them, then "and <n> more"; or, when there is none, a
// note saying so.
export function listBody(
  ctx: PaneContext,
  rows: Row[],
  empty: string,
): HTMLElement[] {
  if (rows.length === 0) return [note(empty)];
  const list = h(
    "ol",
    { class: "rows" },
    ...rows.slice(0, ROWS_SHOWN).map((row) =>
      h(
        "li",
        {},
        h("button", {
          class: "name",
          text: row.label,
          attrs: { type: "button", title: row.title ?? row.label },
          on: {
            click: () =>
              ctx.pick(row.sel, { tab: row.tab ?? "overview", line: row.line }),
          },
        }),
        h("span", { class: "v", text: row.value }),
      ),
    ),
  );
  if (rows.length <= ROWS_SHOWN) return [list];
  return [
    list,
    h("p", {
      class: "more",
      text: `and ${whole(rows.length - ROWS_SHOWN)} more`,
    }),
  ];
}

// A list under its heading.
export function rowList(
  ctx: PaneContext,
  heading: string | Node[],
  rows: Row[],
  empty: string,
): HTMLElement {
  const title =
    typeof heading === "string"
      ? h("h3", { text: heading })
      : h("h3", {}, ...heading);
  return h("section", { class: "list" }, title, ...listBody(ctx, rows, empty));
}

// What draw() makes of a file's outline: at once when the page holds the outline, else a note
// that the outline is loading, which the drawing replaces when it arrives, or a note that it
// could not be loaded.
export function withOutline(
  ctx: PaneContext,
  file: number,
  draw: (outline: Outline) => Node[],
): Node[] {
  const known = ctx.outlines.peek(file);
  if (known !== null) return draw(known);
  const wait = note(LOADING);
  ctx.outlines.get(file).then(
    (outline) => {
      if (wait.isConnected) wait.replaceWith(...draw(outline));
    },
    (e) => {
      console.error("hakutaku: the outline could not be loaded", e);
      if (wait.isConnected) wait.replaceWith(note(FAILED));
    },
  );
  return [wait];
}

const isTest = (model: Model, file: number): boolean => {
  const kind = model.map.files[file][F.kind];
  return kind === TEST || kind === TEST_SUPPORT;
};

// A row that selects a file.
export function fileRow(model: Model, file: number, value: string): Row {
  return {
    label: model.map.files[file][F.path],
    value,
    sel: { kind: "file", file },
  };
}

// A row of the files that import a file or a library: "test" beside a test.
export function importerRow(model: Model, file: number): Row {
  return fileRow(model, file, isTest(model, file) ? "test" : "");
}

// A file's facts in a <dl>.
export function fileFactList(
  model: Model,
  file: number,
  facts: FileFacts,
): HTMLDListElement {
  return factList([
    ["Lines", whole(facts.lines)],
    ["Imported by", count(facts.importedBy.length, "file")],
    [
      "Imports",
      `${count(facts.imports.length, "file")}, ${count(facts.libraries.length, "library", "libraries")}`,
    ],
    [
      "Changed",
      `${count(model.map.files[file][F.churn], "commit")} in 90 days`,
    ],
    ["Definitions", whole(facts.definitions)],
  ]);
}

// The files that change together with a file, each with the commits they share.
function partnerRows(model: Model, facts: FileFacts): Row[] {
  return (facts.cochange ?? []).map(([partner, commits]) =>
    fileRow(model, partner, count(commits, "commit")),
  );
}

// The files that change together with a file: listed when the page holds its outline, else
// behind a button that fetches the outline and lists them when it arrives. When the button had
// the focus, and nothing else has taken it since, the focus moves to the first file listed, or
// to the note in its place.
function partnersSection(
  ctx: PaneContext,
  file: number,
  facts: FileFacts,
): HTMLElement {
  const NONE = "Nothing changes with it often.";
  const heading = () => [
    document.createTextNode("Changes together with "),
    h("small", { text: "(same commits, 180 days)" }),
  ];
  if (facts.cochange !== null) {
    return rowList(ctx, heading(), partnerRows(ctx.model, facts), NONE);
  }
  const wait = note(LOADING);
  const settle = (parts: HTMLElement[], focused: boolean) => {
    wait.replaceWith(...parts);
    const now = document.activeElement;
    if (!focused || (now !== null && now !== document.body)) return;
    const first = parts[0];
    const target = first.querySelector("button") ?? first;
    if (target === first) first.tabIndex = -1;
    target.focus();
  };
  const show = h("button", {
    class: "load",
    text: "Show the files that change with it",
    attrs: { type: "button" },
    on: {
      click: () => {
        const focused = document.activeElement === show;
        show.replaceWith(wait);
        ctx.outlines.get(file).then(
          (outline) => {
            if (!wait.isConnected) return;
            const loaded = fileFacts(ctx.model, file, outline);
            settle(
              listBody(ctx, partnerRows(ctx.model, loaded), NONE),
              focused,
            );
          },
          (e) => {
            console.error("hakutaku: the outline could not be loaded", e);
            if (wait.isConnected) settle([note(FAILED)], focused);
          },
        );
      },
    },
  });
  return h("section", { class: "list" }, h("h3", {}, ...heading()), show);
}

export function fileOverview(ctx: PaneContext, file: number): Node[] {
  const { model } = ctx;
  const { files, externals } = model.map;
  const facts = fileFacts(model, file, ctx.outlines.peek(file));
  const parts: Node[] = [
    fileFactList(model, file, facts),
    rowList(
      ctx,
      "Imported by",
      facts.importedBy.map((f) => importerRow(model, f)),
      "Nothing imports it.",
    ),
    rowList(
      ctx,
      "Imports",
      facts.imports.map((f) => fileRow(model, f, "")),
      "It imports no file.",
    ),
    partnersSection(ctx, file, facts),
  ];
  if (facts.libraries.length > 0) {
    parts.push(
      rowList(
        ctx,
        "Libraries",
        facts.libraries.map((e) => libraryRow(externals[e], e)),
        "",
      ),
    );
  }
  if (facts.launchedBy.length > 0) {
    parts.push(
      rowList(
        ctx,
        "Launched by",
        facts.launchedBy.map(({ manifest, line, kind, name }) => {
          // an entry point the file names itself, with no manifest, opens the file
          const at = manifest >= 0 ? manifest : file;
          const label = `${files[at][F.path]}:${line}${SEP}${kind}`;
          return {
            label,
            value: "",
            title: `${label}${SEP}${name}`,
            sel: { kind: "file", file: at },
            tab: "source",
            line,
          };
        }),
        "",
      ),
    );
  }
  return parts;
}

// A row that selects a library: its name, and its ecosystem beside it.
function libraryRow(
  [ecosystem, name]: [number, string, number],
  external: number,
): Row {
  return {
    label: name,
    value: ECOSYSTEMS[ecosystem],
    title: `${ECOSYSTEMS[ecosystem]}:${name}`,
    sel: { kind: "library", external },
  };
}

export function definitionOverview(
  ctx: PaneContext,
  file: number,
  def: number,
): Node[] {
  const { model } = ctx;
  const { defs } = model.map;
  const [start] = model.defsOf[file];
  const own = withOutline(ctx, file, (outline) => [
    factList([
      ["Kind", DEF_KINDS[defs.kind[def]]],
      ["Lines", `${defs.line[def]}\u2013${outline.endLine[def - start]}`],
      ["Exported", defs.exported[def] === 1 ? "yes" : "no"],
      ["Used by", count(defs.usedBy[def], "file")],
      ["Mentioned by tests", outline.tested[def - start] === 1 ? "yes" : "no"],
    ]),
  ]);
  return [
    ...own,
    h(
      "section",
      { class: "list" },
      h("h3", { text: "Its file" }),
      fileFactList(model, file, fileFacts(model, file, null)),
    ),
  ];
}
