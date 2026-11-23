// The Source tab's highlighting worker, built as assets/hl-worker.js. It highlights a large file's
// whole text away from the page, so a comment or a string that spans lines is read whole, then
// posts the file's lines back in chunks of SOURCE_CHUNK_LINES, each a message of its own, which
// the page appends one per task. The line feed that may end the text starts no line of its own.
import { SOURCE_CHUNK_LINES } from "../constants.js";
import { type HlChunk, type HlRequest, highlightLines } from "./hl.js";
import { lineCount } from "./split-lines.js";

// The worker's own global, declared here: the app's tsconfig holds the DOM library only, whose
// self is a window.
interface WorkerScope {
  onmessage: ((event: { data: HlRequest }) => void) | null;
  postMessage(chunk: HlChunk): void;
}
declare const self: WorkerScope;

self.onmessage = ({ data: { id, text, lang } }) => {
  const lines = highlightLines(text, lang);
  const total = lineCount(text);
  let from = 0;
  do {
    const to = Math.min(from + SOURCE_CHUNK_LINES, total);
    self.postMessage({
      id,
      from,
      lines: lines.slice(from, to),
      done: to >= total,
    });
    from = to;
  } while (from < total);
};
