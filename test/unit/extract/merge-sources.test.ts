// Sources and the text index: each file with a stored source keeps its decoded text, redacted
// whole, and every line of it holding a character other than white space is a text_index row.
import { expect, it } from "vitest";
import { mergeFacts } from "../../../src/extract/merge/index.js";
import type { MergeInput } from "../../../src/extract/merge/types.js";
import { lines, mark, mergeInput } from "./merge-input.js";

const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const high = (n: number) =>
  Array.from({ length: n }, (_, i) => ALPHA[(i * 37 + 11) % ALPHA.length]).join(
    "",
  );
const join = (...parts: string[]) => parts.join("");

const BEGIN = join("-----BEGIN ", "PRIVATE KEY-----");
const END = join("-----END ", "PRIVATE KEY-----");

// A doc, a config file holding a private key over three lines, a code file assigning a
// high-entropy value to api_key with an empty and a blank line, a binary file and a
// generated one.
function sample(noSource: boolean): MergeInput {
  return mergeInput(
    {
      "README.md": lines("# Sky"),
      "deploy/app.yml": lines(
        "key: |",
        `  ${BEGIN}`,
        `  ${high(40)}`,
        `  ${END}`,
        "port: 8080",
      ),
      "web/src/api/client.ts": lines(
        `const api_key = "${high(32)}";`,
        "",
        "   ",
        'export const url = "https://example.invalid";',
      ),
      "web/src/blob.ts": "x\0y\n",
      "web/src/gen.ts": lines("export const gen = 1;"),
    },
    { noSource, metadataOnly: { "web/src/gen.ts": "generated" } },
  );
}

it("stores redacted sources and indexes their non-empty lines", () => {
  const { content, side } = mergeFacts(sample(false));
  const KEY = mark("private-key");
  const CLIENT_LINE = `const api_key = "${mark("assigned-secret")}";`;
  // Files: 1 README.md, 2 deploy/app.yml, 3 client.ts, 4 blob.ts, 5 gen.ts. The binary and
  // the generated file keep no source. A secret over several lines leaves one mark per line,
  // its indentation inside the match included
  expect(content.sources).toEqual([
    { file_id: 1, text: lines("# Sky") },
    {
      file_id: 2,
      text: lines("key: |", `  ${KEY}`, KEY, KEY, "port: 8080"),
    },
    {
      file_id: 3,
      text: lines(
        CLIENT_LINE,
        "",
        "   ",
        'export const url = "https://example.invalid";',
      ),
    },
  ]);
  // the empty and the blank line of client.ts are not indexed
  expect(content.text_index).toEqual([
    { text: "# Sky", file_id: 1, line: 1 },
    { text: "key: |", file_id: 2, line: 1 },
    { text: `  ${KEY}`, file_id: 2, line: 2 },
    { text: KEY, file_id: 2, line: 3 },
    { text: KEY, file_id: 2, line: 4 },
    { text: "port: 8080", file_id: 2, line: 5 },
    { text: CLIENT_LINE, file_id: 3, line: 1 },
    {
      text: 'export const url = "https://example.invalid";',
      file_id: 3,
      line: 4,
    },
  ]);
  // one private key and one assigned secret
  expect(side.redactions).toBe(2);
});

it("stores no source and no text index with --no-source", () => {
  const { content, side } = mergeFacts(sample(true));
  expect(content.sources).toEqual([]);
  expect(content.text_index).toEqual([]);
  expect(content.files.map((f) => f.has_source)).toEqual([0, 0, 0, 0, 0]);
  expect(side.redactions).toBe(0);
});
