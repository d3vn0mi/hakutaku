// The files table and the components: one row per tree entry, test support marked once the
// imports and entry points are known, and the components counted over the final kinds.
import { expect, it } from "vitest";
import { fileRows, mergeFiles } from "../../../src/extract/merge/files.js";
import type { FileRow } from "../../../src/store/index.js";
import {
  astGrep,
  blobOf,
  importFact,
  mergeInOrder,
  mergeInput,
  spot,
} from "./merge-input.js";

const encoder = new TextEncoder();
const BOM = String.fromCodePoint(0xfeff);

// A regular file's row as the tests expect it: 100644, no link, not an entry, its source kept.
function row(
  files: Record<string, string | Uint8Array>,
  id: number,
  path: string,
  fields: Partial<FileRow>,
): FileRow {
  const content = files[path] ?? "";
  return {
    id,
    path,
    lang: null,
    kind: "code",
    component_id: null,
    lines: 1,
    bytes:
      typeof content === "string"
        ? encoder.encode(content).length
        : content.length,
    blob_sha: blobOf(path),
    mode: "100644",
    link_target: null,
    entry: 0,
    has_source: 1,
    ...fields,
  };
}

it("marks test support after imports are known", () => {
  // Only tests reach fake.ts, and only fake.ts reaches helper.ts: both become test support.
  // cli.ts is the bin of b/package.json and stays production though only its test imports
  // it. With seven production files a/ would hold three and split; with the five left, no
  // component holds more than 40%.
  const FILES: Record<string, string> = {
    "a/src/fake.test.ts": "import { fake } from './fake';\n",
    "a/src/fake.ts": "import { h } from './helper';\nexport const fake = h;\n",
    "a/src/helper.ts": "export const h = 1;\n",
    "a/src/real.ts": "export const real = 2;\n",
    "b/cli.test.ts": "import { main } from './cli';\n",
    "b/cli.ts": "export function main() {}\n",
    "b/package.json": '{ "name": "b", "bin": { "b": "cli.ts" } }\n',
    "b/x.ts": "export const x = 3;\n",
    "c/y.ts": "export const y = 4;\n",
    "c/z.ts": "export const z = 5;\n",
  };
  const imp = (file: string, specifier: string) =>
    importFact(file, spot(FILES[file] ?? "", 1, `'${specifier}'`), specifier);
  const merged = mergeInOrder(
    mergeInput(FILES, {
      facts: {
        astGrep: astGrep({
          imports: [
            imp("a/src/fake.test.ts", "./fake"),
            imp("a/src/fake.ts", "./helper"),
            imp("b/cli.test.ts", "./cli"),
          ],
        }),
      },
    }),
  );
  const ts = { lang: "typescript" } as const;
  expect(merged.files).toEqual([
    row(FILES, 1, "a/src/fake.test.ts", {
      ...ts,
      kind: "test",
      component_id: 1,
    }),
    row(FILES, 2, "a/src/fake.ts", {
      ...ts,
      kind: "test-support",
      component_id: 1,
      lines: 2,
    }),
    row(FILES, 3, "a/src/helper.ts", {
      ...ts,
      kind: "test-support",
      component_id: 1,
    }),
    row(FILES, 4, "a/src/real.ts", { ...ts, component_id: 1 }),
    row(FILES, 5, "b/cli.test.ts", { ...ts, kind: "test", component_id: 2 }),
    row(FILES, 6, "b/cli.ts", { ...ts, component_id: 2, entry: 1 }),
    row(FILES, 7, "b/package.json", { kind: "config" }),
    row(FILES, 8, "b/x.ts", { ...ts, component_id: 2 }),
    row(FILES, 9, "c/y.ts", { ...ts, component_id: 3 }),
    row(FILES, 10, "c/z.ts", { ...ts, component_id: 3 }),
  ]);
  expect(merged.components).toEqual([
    {
      id: 1,
      path: "a/",
      kind: "folder",
      parent_id: null,
      files: 1,
      tests: 3,
      lines: 5,
    },
    {
      id: 2,
      path: "b/",
      kind: "package",
      parent_id: null,
      files: 2,
      tests: 1,
      lines: 3,
    },
    {
      id: 3,
      path: "c/",
      kind: "folder",
      parent_id: null,
      files: 2,
      tests: 0,
      lines: 2,
    },
  ]);
  expect(merged.kinds).toEqual(
    new Map([
      ["a/src/fake.test.ts", "test"],
      ["a/src/fake.ts", "test-support"],
      ["a/src/helper.ts", "test-support"],
      ["a/src/real.ts", "code"],
      ["b/cli.test.ts", "test"],
      ["b/cli.ts", "code"],
      ["b/package.json", "config"],
      ["b/x.ts", "code"],
      ["c/y.ts", "code"],
      ["c/z.ts", "code"],
    ]),
  );
});

it("stores each tree entry's kind, lines, link and source by the fixed rules", () => {
  const FILES: Record<string, string | Uint8Array> = {
    LICENSE: "MIT\n",
    "assets/logo.png": Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a]),
    "docs/guide.md": "# Guide\r\nline two",
    "gen/big.ts": "export const big = 1;\n",
    "notes.weird": "plain text\n",
    "src/app.ts": `${BOM}export const a = 1;\r\n`,
    // x = 'e-acute', the e-acute a lone Latin-1 byte
    "src/latin.py": Uint8Array.from([
      0x78, 0x20, 0x3d, 0x20, 0x27, 0xe9, 0x27, 0x0a,
    ]),
  };
  const COMMIT = "0123456789abcdef0123456789abcdef01234567";
  const options = {
    links: { current: "src/app.ts" },
    submodules: { "vendor/lib": COMMIT },
    metadataOnly: { "gen/big.ts": "generated" as const },
  };
  const input = mergeInput(FILES, options);
  const files = fileRows(input);
  const { components } = mergeFiles(input, files, new Map());
  expect(files).toEqual([
    row(FILES, 1, "LICENSE", { kind: "doc" }),
    row(FILES, 2, "assets/logo.png", {
      kind: "other",
      lines: 0,
      has_source: 0,
    }),
    {
      id: 3,
      path: "current",
      lang: null,
      kind: "other",
      component_id: null,
      lines: 0,
      bytes: 10,
      blob_sha: blobOf("current"),
      mode: "120000",
      link_target: "src/app.ts",
      entry: 0,
      has_source: 0,
    },
    row(FILES, 4, "docs/guide.md", { kind: "doc", lines: 2 }),
    row(FILES, 5, "gen/big.ts", {
      lang: "typescript",
      component_id: 1,
      has_source: 0,
    }),
    row(FILES, 6, "notes.weird", { kind: "other", has_source: 0 }),
    row(FILES, 7, "src/app.ts", { lang: "typescript", component_id: 2 }),
    row(FILES, 8, "src/latin.py", { lang: "python", component_id: 2 }),
    {
      id: 9,
      path: "vendor/lib",
      lang: null,
      kind: "other",
      component_id: null,
      lines: 0,
      bytes: 0,
      blob_sha: COMMIT,
      mode: "160000",
      link_target: null,
      entry: 0,
      has_source: 0,
    },
  ]);
  // src/ holds two of the three production files, but no subdirectory to split into
  expect(components).toEqual([
    {
      id: 1,
      path: "gen/",
      kind: "folder",
      parent_id: null,
      files: 1,
      tests: 0,
      lines: 1,
    },
    {
      id: 2,
      path: "src/",
      kind: "folder",
      parent_id: null,
      files: 2,
      tests: 0,
      lines: 2,
    },
  ]);
  expect(
    fileRows(mergeInput(FILES, { ...options, noSource: true })).map(
      (f) => f.has_source,
    ),
  ).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
});
