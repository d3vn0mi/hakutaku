// The sources table and the text index. Each file whose source the store keeps (has_source)
// has its text, decoded by the stored-text rule and redacted as a whole, so that a secret
// spanning lines is found. Each line of that text holding a character other than white space
// is one text_index row, whole and redacted, in path and line order.
import { redactText } from "../../redact/index.js";
import type { FileRow, TextIndexRow } from "../../store/index.js";
import { decodeText } from "./text.js";
import type { MergedContent, MergeInput } from "./types.js";

export function mergeSources(
  input: MergeInput,
  files: readonly FileRow[],
): {
  sources: MergedContent["sources"];
  text_index: TextIndexRow[];
  // redactText's count over the sources
  redactions: number;
} {
  const sources: MergedContent["sources"] = [];
  const text_index: TextIndexRow[] = [];
  let redactions = 0;
  for (const file of files) {
    if (file.has_source !== 1) continue;
    const redacted = redactText(decodeText(input.readSnapshot(file.path)));
    sources.push({ file_id: file.id, text: redacted.text });
    redactions += redacted.count;
    redacted.text.split("\n").forEach((text, i) => {
      if (/\S/.test(text))
        text_index.push({ text, file_id: file.id, line: i + 1 });
    });
  }
  return { sources, text_index, redactions };
}
