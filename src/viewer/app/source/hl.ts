// A source text as HTML, one fragment per line: highlighted by highlight.js, whose markup is
// spans with classes and whose text is escaped, or, for a text of no language, escaped plain
// text. Also the messages between the page and its highlighting worker. No DOM here: Node tests
// and the worker import it.
import { escapeHtml } from "../escape.js";
import hljs from "./hljs.js";
import type { HlLanguage } from "./languages.js";
import { splitHighlighted } from "./split-lines.js";

export function highlightLines(
  text: string,
  lang: HlLanguage | null,
): string[] {
  const html =
    lang === null
      ? escapeHtml(text)
      : hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  return splitHighlighted(html);
}

// What the page asks of the worker: a text to highlight, under the id of its request.
export interface HlRequest {
  id: number;
  text: string;
  lang: HlLanguage | null;
}

// What the worker answers, a chunk of lines at a time (chunkEnd): the lines from index from (0 for
// the first line), and done on the last chunk.
export interface HlChunk {
  id: number;
  from: number;
  lines: string[];
  done: boolean;
}
