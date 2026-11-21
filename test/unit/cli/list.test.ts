import { rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import type { CliIO } from "../../../src/cli/commands/index.js";
import { main } from "../../../src/cli/main.js";
import { hakutakuDirs, storePathFor } from "../../../src/registry/index.js";
import { writeAttempt } from "../../../src/store/index.js";
import { useRegisteredTiny } from "../../helpers/registry.js";
import { TINY_COMMIT } from "../../helpers/tiny.js";

useRegisteredTiny();

const capture = () => {
  const c = { out: "", err: "" };
  const io: CliIO = {
    stdout: (s) => {
      c.out += s;
    },
    stderr: (s) => {
      c.err += s;
    },
    stdin: new PassThrough(),
    env: {},
    isTTY: false,
  };
  return { c, io };
};

const COMMIT12 = TINY_COMMIT.slice(0, 12);
const BUILT_AT = "2026-01-01T00:00:00Z"; // the tiny store's run row

it("lists each registered repo as one row of a table", async () => {
  const { c, io } = capture();
  expect(await main(["list"], io)).toBe(0);
  expect(c.out).toBe(
    [
      "id    ref   built         head          stale  detail    built at",
      `tiny  main  ${COMMIT12}  ${COMMIT12}  no     standard  ${BUILT_AT}`,
      "",
    ].join("\n"),
  );
  expect(c.err).toBe("");
});

it("lists the repos as JSON, with 12-hex commits, or null where there is none", async () => {
  const { c, io } = capture();
  expect(await main(["list", "--json"], io)).toBe(0);
  expect(JSON.parse(c.out)).toEqual([
    {
      id: "tiny",
      ref: "main",
      builtCommit: COMMIT12,
      headCommit: COMMIT12,
      stale: false,
      detail: "standard",
      builtAt: BUILT_AT,
    },
  ]);
  // with no store, nothing is built, and stale says why
  rmSync(storePathFor("tiny"));
  const after = capture();
  expect(await main(["list", "--json"], after.io)).toBe(0);
  expect(JSON.parse(after.c.out)).toEqual([
    {
      id: "tiny",
      ref: "main",
      builtCommit: null,
      headCommit: COMMIT12,
      stale: true,
      staleReason: "not built: not built yet",
      detail: "standard",
      builtAt: null,
    },
  ]);
  const table = capture();
  expect(await main(["list"], table.io)).toBe(0);
  expect(table.c.out.split("\n")[1]).toBe(
    `tiny  main  -      ${COMMIT12}  yes: not built: not built yet  standard  -`,
  );
});

it("prints a failed build's reason on one line in the table, with no control character, and whole in JSON", async () => {
  const reason = "ast-grep failed: exit code 2\nerror: \u001b[2Jcannot parse";
  writeAttempt(storePathFor("tiny"), {
    at: "2026-01-02T00:00:00Z",
    commit: TINY_COMMIT,
    result: "failed",
    reason,
  });
  const { c, io } = capture();
  expect(await main(["list"], io)).toBe(0);
  const row = c.out.split("\n")[1] ?? "";
  expect(row).toContain(
    "yes: the last build failed: ast-grep failed: exit code 2; error: ?[2Jcannot parse",
  );
  expect(row).not.toMatch(/\p{Cc}/u);
  const json = capture();
  expect(await main(["list", "--json"], json.io)).toBe(0);
  expect(JSON.parse(json.c.out)[0].staleReason).toBe(
    `the last build failed: ${reason}`,
  );
});

it("says so when no repo is registered", async () => {
  rmSync(hakutakuDirs().data, { recursive: true, force: true });
  const { c, io } = capture();
  expect(await main(["list"], io)).toBe(0);
  expect(c.out).toBe("");
  expect(c.err).toBe("no repo is registered; run hakutaku map <repo> first\n");
  const json = capture();
  expect(await main(["list", "--json"], json.io)).toBe(0);
  expect(json.c.out).toBe("[]\n");
});

it("exits 2 on an argument it does not take", async () => {
  for (const argv of [
    ["list", "tiny"],
    ["list", "--all"],
  ]) {
    const { c, io } = capture();
    expect(await main(argv, io)).toBe(2);
    expect(c.err).toMatch(/usage: hakutaku list \[--json\]\n$/);
    expect(c.out).toBe("");
  }
});
