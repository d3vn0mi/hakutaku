// The Source tab's code: a note above it, the line numbers in a gutter, and the file's lines, each
// a .line element. The one module that writes HTML from a string, and only what hl.ts makes:
// highlight.js's output, or escaped text. Everything else, the gutter included, is built from
// elements.
// - A file of up to WORKER_HIGHLIGHT_ABOVE lines is highlighted here, at once.
// - A larger file goes to the worker, which posts its lines in chunks of SOURCE_CHUNK_LINES, and
//   each chunk is appended in the task its message arrives in. Without a worker, or when the
//   worker fails, the file is escaped plain text in the same chunks, one per task, and the note
//   says so.
// - The gutter carries a definition's glyph beside its first line, and a mark beside each call
//   site given: b for a bound call, s for a scoped one.
// - The flash lies over the line to show once that line is in, and is scrolled into view,
//   smoothly unless the viewer asks for reduced motion.
// - Once every line is in, .code gets data-complete="true".
// The lines rendered are the ones the store counts: the line feed that may end the text starts
// no line of its own.
import { parseId } from "../../../model/ids.js";
import type { DefKind } from "../../../model/types.js";
import type { SourceData } from "../../../query/view/types.js";
import { SOURCE_CHUNK_LINES, WORKER_HIGHLIGHT_ABOVE } from "../constants.js";
import { GLYPH } from "../detail/facts.js";
import { h, prefersReducedMotion } from "../dom.js";
import { count } from "../words.js";
import { type HlChunk, type HlRequest, highlightLines } from "./hl.js";
import type { HlLanguage } from "./languages.js";
import { lineCount } from "./split-lines.js";

export interface SiteMark {
  line: number;
  label: "bound" | "scoped";
  target: string;
}

const SEP = " \u00b7 ";
// app.css's line height in the code, and the space above its first line, in pixels
const LINE_PX = 18;
const TOP_PX = 8;

let lastRequest = 0;

// A definition's qualified name, from its ID; the ID itself when it names no definition.
function qualnameOf(id: string): string {
  const ref = parseId(id);
  return ref?.kind === "definition" ? ref.qualname : id;
}

// The gutter's glyph for each line where a definition starts: the first one's kind, and in its
// title every definition that starts there.
function glyphsOf(
  defs: SourceData["defs"],
): Map<number, { kind: DefKind; title: string }> {
  const glyphs = new Map<number, { kind: DefKind; title: string }>();
  for (const def of defs) {
    const named = `${def.kind} ${qualnameOf(def.id)}`;
    const at = glyphs.get(def.line);
    if (at === undefined)
      glyphs.set(def.line, { kind: def.kind, title: named });
    else at.title += `, ${named}`;
  }
  return glyphs;
}

export function renderSource(
  pane: HTMLElement,
  src: SourceData,
  opts: {
    lang: HlLanguage | null;
    flashLine: number | null;
    marks: SiteMark[];
    worker: Worker | null;
  },
): { cancel(): void } {
  const total = lineCount(src.text);
  const note = h("p", { class: "srcnote" });
  if (total === 0) {
    note.textContent = "This file is empty.";
    pane.replaceChildren(note);
    return { cancel() {} };
  }
  const large = total > WORKER_HIGHLIGHT_ABOVE;
  const say = (plain: boolean) => {
    const parts = [
      `${count(total, "line")}${plain && large ? ", without colours (large file)" : ""}`,
    ];
    if (src.redactions > 0) {
      parts.push(`${count(src.redactions, "span")} redacted`);
    }
    note.textContent = parts.join(SEP);
  };

  const glyphs = glyphsOf(src.defs);
  const sites = new Map<number, SiteMark[]>();
  for (const mark of opts.marks) {
    sites.set(mark.line, [...(sites.get(mark.line) ?? []), mark]);
  }
  const gutter = h("div", {
    class: "gutter",
    attrs: { "aria-hidden": "true" },
  });
  const code = h("code");
  const box = h(
    "div",
    {
      class: "code",
      attrs: { role: "region", "aria-label": "Source code", tabindex: "0" },
    },
    gutter,
    h("pre", {}, code),
  );
  pane.replaceChildren(note, box);

  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopWorker = () => {};
  const stopped = () => cancelled || !box.isConnected;

  const flash = (line: number) => {
    const band = h("div", {
      class: "flash",
      attrs: { "data-line": String(line) },
    });
    band.style.top = `${TOP_PX + (line - 1) * LINE_PX}px`;
    box.append(band);
    band.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: prefersReducedMotion() ? "instant" : "smooth",
    });
  };

  // A chunk of lines from index from on: in the gutter, a chunk of their numbers with the glyphs
  // and marks beside them; in the code, a chunk of their HTML. Each chunk is as tall as its lines
  // before the page lays it out, so a chunk out of view never needs laying out.
  const append = (from: number, lines: string[]) => {
    const shown = lines.slice(0, Math.max(0, total - from));
    const tall = `auto ${shown.length * LINE_PX}px`;
    const rows = h("span", { class: "chunk" });
    rows.style.containIntrinsicBlockSize = tall;
    shown.forEach((_, i) => {
      const n = from + i + 1;
      const row = h("span", { class: "n", text: String(n) });
      const glyph = glyphs.get(n);
      if (glyph !== undefined) {
        row.prepend(
          h("i", {
            class: "g",
            text: GLYPH[glyph.kind],
            attrs: { "data-line": String(n), title: glyph.title },
          }),
        );
      }
      const here = sites.get(n);
      if (here !== undefined) {
        row.append(
          h(
            "span",
            { class: "sites" },
            ...here.map((mark) =>
              h("b", {
                class: `mark-${mark.label}`,
                text: mark.label.slice(0, 1),
                attrs: {
                  "data-line": String(n),
                  title: `${mark.label} call to ${qualnameOf(mark.target)}`,
                },
              }),
            ),
          ),
        );
      }
      rows.append(row);
    });
    gutter.append(rows);
    const parsed = document.createElement("template");
    parsed.innerHTML = `<span class="chunk">${shown
      .map((line) => `<span class="line">${line}</span>`)
      .join("")}</span>`;
    const chunk = parsed.content.firstElementChild;
    if (chunk instanceof HTMLElement)
      chunk.style.containIntrinsicBlockSize = tall;
    code.append(parsed.content);
    const at = opts.flashLine;
    if (at !== null && at > from && at <= from + shown.length) flash(at);
  };

  const finish = () => {
    box.dataset.complete = "true";
  };

  // Escaped plain text, appended a chunk per task.
  const plain = () => {
    gutter.replaceChildren();
    code.replaceChildren();
    box.querySelector(".flash")?.remove();
    say(true);
    const lines = highlightLines(src.text, null);
    let from = 0;
    const step = () => {
      timer = undefined;
      if (stopped()) return;
      const to = Math.min(from + SOURCE_CHUNK_LINES, total);
      append(from, lines.slice(from, to));
      from = to;
      if (from < total) timer = setTimeout(step, 0);
      else finish();
    };
    timer = setTimeout(step, 0);
  };

  const cancel = () => {
    cancelled = true;
    clearTimeout(timer);
    stopWorker();
  };

  if (!large) {
    say(false);
    append(0, highlightLines(src.text, opts.lang));
    finish();
    return { cancel };
  }

  const worker = opts.worker;
  if (worker === null) {
    plain();
    return { cancel };
  }
  say(false);
  const id = ++lastRequest;
  const onChunk = (e: MessageEvent<HlChunk>) => {
    if (e.data.id !== id) return;
    if (stopped()) {
      stopWorker();
      return;
    }
    append(e.data.from, e.data.lines);
    if (e.data.done) {
      stopWorker();
      finish();
    }
  };
  const onFailure = (e: Event) => {
    console.error("hakutaku: the highlighting worker failed", e);
    stopWorker();
    if (!stopped()) plain();
  };
  stopWorker = () => {
    worker.removeEventListener("message", onChunk);
    worker.removeEventListener("error", onFailure);
    worker.removeEventListener("messageerror", onFailure);
  };
  worker.addEventListener("message", onChunk);
  worker.addEventListener("error", onFailure);
  worker.addEventListener("messageerror", onFailure);
  const request: HlRequest = { id, text: src.text, lang: opts.lang };
  worker.postMessage(request);
  return { cancel };
}
