// test/helpers/hostile.ts: the hostile fixtures, made afresh by fixtures/hostile/make.mjs on
// every call, with git alone and no engine, and the checks the hostile suite ends with.
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import type { FileRow } from "../../../src/store/index.js";
import {
  filesHolding,
  type HostileCaseId,
  hostileFixtures,
  MARKER,
  storedTextsHolding,
  takeCanary,
} from "../../helpers/hostile.js";
import { emptyContent, miniStore } from "../../helpers/mini-store.js";

const CASES_FILE = fileURLToPath(
  new URL("../../../fixtures/hostile/cases.json", import.meta.url),
);

// Every case id, in cases.json's order.
const IDS: HostileCaseId[] = [
  "pyright-interpreter",
  "sgconfig",
  "git-config",
  "smudge-filter",
  "show-signature",
  "fsmonitor-hooks",
  "depcruise-config",
  "python-shadow",
  "symlink-host",
  "dotdot-path",
  "injected-comment",
  "markup-names",
  "minified-50mb",
  "engine-failure-text",
  "separator-names",
];

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-hostile-unit-"));
  made.push(dir);
  return dir;
};

it("makes the fixtures afresh on each call, with an empty canary and the host's marker", async () => {
  const first = await hostileFixtures();
  const second = await hostileFixtures();
  expect(second.dir).not.toBe(first.dir);
  for (const made of [first, second]) {
    expect(readdirSync(made.canaryDir)).toEqual([]);
    expect(readFileSync(made.markerFile, "utf8").split("\n")).toContain(MARKER);
    for (const id of IDS) {
      expect(statSync(join(made.dir, id)).isDirectory()).toBe(true);
    }
  }
});

it("reads the cases of cases.json, whose ids are the hostile case ids in order", async () => {
  const { cases } = await hostileFixtures();
  expect(cases).toEqual(JSON.parse(readFileSync(CASES_FILE, "utf8")));
  expect(cases.map((c) => c.id)).toEqual(IDS);
});

it("takes what the canary holds, by file and line, and leaves it empty", async () => {
  const fx = await hostileFixtures();
  writeFileSync(
    join(fx.canaryDir, "sgconfig"),
    "sgconfig: one\nsgconfig: two\n",
  );
  writeFileSync(join(fx.canaryDir, "git-config"), "git-config: three\n");
  expect(takeCanary(fx)).toEqual({
    "git-config": ["git-config: three"],
    sgconfig: ["sgconfig: one", "sgconfig: two"],
  });
  expect(readdirSync(fx.canaryDir)).toEqual([]);
  expect(takeCanary(fx)).toEqual({});
});

it("finds a text in the files under a directory, and refuses to follow a link", () => {
  const dir = tmp();
  mkdirSync(join(dir, "a", "b"), { recursive: true });
  writeFileSync(join(dir, "a", "b", "leak.txt"), `before ${MARKER} after\n`);
  writeFileSync(join(dir, "a", "clean.txt"), "nothing here\n");
  expect(filesHolding(dir, MARKER)).toEqual(["a/b/leak.txt"]);
  expect(filesHolding(join(dir, "a", "b"), "nothing")).toEqual([]);
  symlinkSync(join(dir, "a", "clean.txt"), join(dir, "a", "link.txt"));
  expect(() => filesHolding(dir, MARKER)).toThrow(
    "not a regular file or a directory: a/link.txt",
  );
});

it("finds a text in any column of a store, a deflated source and the text index included", () => {
  const file: FileRow = {
    id: 1,
    path: "notes.txt",
    lang: null,
    kind: "other",
    component_id: null,
    lines: 1,
    bytes: MARKER.length + 1,
    blob_sha: "0".repeat(40),
    mode: "100644",
    link_target: null,
    entry: 0,
    has_source: 1,
  };
  expect(storedTextsHolding(miniStore(emptyContent()), MARKER)).toEqual([]);
  // the writer deflates a source, so its bytes never hold the text as it was
  expect(
    storedTextsHolding(
      miniStore({
        ...emptyContent(),
        files: [file],
        sources: [{ file_id: 1, text: `${MARKER}\n` }],
      }),
      MARKER,
    ),
  ).toEqual(["sources.body"]);
  const indexed = storedTextsHolding(
    miniStore({
      ...emptyContent(),
      files: [file],
      sources: [{ file_id: 1, text: "notes\n" }],
      text_index: [{ text: MARKER, file_id: 1, line: 1 }],
    }),
    MARKER,
  );
  expect(indexed).toContain("text_index.text");
  expect(indexed).toContain("text_index_content.c0");
  expect(
    storedTextsHolding(
      miniStore({
        ...emptyContent(),
        files: [
          {
            ...file,
            mode: "120000",
            link_target: `../keys/${MARKER}`,
            has_source: 0,
          },
        ],
      }),
      MARKER,
    ),
  ).toEqual(["files.link_target"]);
});
