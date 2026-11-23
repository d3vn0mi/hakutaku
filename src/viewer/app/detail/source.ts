// The Source tab of a file or a definition: the file's source, asked of the page's data source
// each time the tab opens, highlighted by the file's language. A definition's line is flashed and
// its call sites in the file are marked by their label; a selection that names a line, as an
// entry point's manifest row does, has that line flashed. A map without sources, a file the store
// holds no source for, and a source that cannot be had or that comes from another build each
// draw only a note saying so.
// - The page has one highlighting worker, made when a file too large to highlight on the page
//   (over WORKER_HIGHLIGHT_ABOVE lines or HIGHLIGHT_ON_PAGE_CHARS characters) first needs it.
//   Once it fails, or when this page cannot make one, every later large file is rendered without
//   it, as plain text a chunk at a time.
// - An exported page has no worker, by design: it holds no worker script and its CSP allows none,
//   so it never tries to make one, and renders every large file without it.
// - Opening the tab again stops whatever the last opening was still drawing.
import { F, FLAG_SOURCE } from "../../../query/view/constants.js";
import { refusalOfOtherBuild, sameBuild } from "../build-guard.js";
import { ApiError, type DataSource } from "../data-types.js";
import { h } from "../dom.js";
import type { Model } from "../model.js";
import { idOf } from "../routing.js";
import { hlLanguage } from "../source/languages.js";
import { renderSource, type SiteMark } from "../source/render.js";
import { highlightedOffPage } from "../source/split-lines.js";

const SOURCES_OFF = "Sources are not part of this map.";
const NO_SOURCE =
  "No source for this file: it is over 1 MB, minified or generated.";
const LOADING = "Loading the source\u2026";
const FAILED = "The source could not be loaded.";
const WORKER_SCRIPT = "assets/hl-worker.js";

export type SourceSel =
  | { kind: "file"; file: number }
  | { kind: "definition"; file: number; def: number };

export interface SourceView {
  // The tab's pane for a file or a definition; line is the line a selection names, or null.
  pane(sel: SourceSel, line: number | null): Node[];
}

const srcnote = (text: string) => h("p", { class: "srcnote", text });

export function createSourceView(model: Model, source: DataSource): SourceView {
  let drawing: { cancel(): void } | null = null;
  // undefined: not made yet; null: this page has none, as an exported page never has
  let worker: Worker | null | undefined =
    source.kind === "embedded" ? null : undefined;

  const highlighter = (): Worker | null => {
    if (worker !== undefined) return worker;
    try {
      const made = new Worker(new URL(WORKER_SCRIPT, document.baseURI));
      made.addEventListener("error", () => {
        made.terminate();
        if (worker === made) worker = null;
      });
      worker = made;
    } catch (e) {
      console.error("hakutaku: the highlighting worker could not start", e);
      worker = null;
    }
    return worker;
  };

  return {
    pane(sel, line) {
      drawing?.cancel();
      drawing = null;
      const { files, defs } = model.map;
      const file = files[sel.file];
      if (!model.map.sources) return [srcnote(SOURCES_OFF)];
      if ((file[F.flags] & FLAG_SOURCE) === 0) return [srcnote(NO_SOURCE)];
      const holder = h("div", { class: "source" }, srcnote(LOADING));
      const id = idOf(model, { kind: "file", file: sel.file });
      if (id === null) return [srcnote(FAILED)];
      const selected = sel.kind === "definition" ? idOf(model, sel) : null;
      source.source(id).then(
        (src) => {
          if (!holder.isConnected) return;
          // nothing from another build, or about another file
          if (!sameBuild(src, model.map) || src.file !== id) {
            holder.replaceChildren(srcnote(FAILED));
            return;
          }
          const marks: SiteMark[] = src.sites
            .filter((site) => site.target === selected)
            .map(({ line: at, label, target }) => ({
              line: at,
              label,
              target,
            }));
          drawing = renderSource(holder, src, {
            lang: hlLanguage(file[F.path]),
            flashLine: sel.kind === "definition" ? defs.line[sel.def] : line,
            marks,
            worker: highlightedOffPage(src.text) ? highlighter() : null,
          });
        },
        (e) => {
          // a refusal of another build says nothing of this map's file
          const absent =
            e instanceof ApiError &&
            e.error.code === "no_source" &&
            !refusalOfOtherBuild(e, model.map);
          if (!absent)
            console.error("hakutaku: the source could not be loaded", e);
          if (holder.isConnected) {
            holder.replaceChildren(srcnote(absent ? NO_SOURCE : FAILED));
          }
        },
      );
      return [holder];
    },
  };
}
