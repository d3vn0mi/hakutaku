// test/helpers/hostile.ts: the hostile fixtures, made afresh by fixtures/hostile/make.mjs on
// every call, with git alone and no engine.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { type HostileCaseId, hostileFixtures } from "../../helpers/hostile.js";

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
];

it("makes the fixtures afresh on each call, with an empty canary and the host's marker", async () => {
  const first = await hostileFixtures();
  const second = await hostileFixtures();
  expect(second.dir).not.toBe(first.dir);
  for (const made of [first, second]) {
    expect(readdirSync(made.canaryDir)).toEqual([]);
    expect(readFileSync(made.markerFile, "utf8").split("\n")).toContain(
      "HOST-SECRET-MARKER-0f1e",
    );
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
