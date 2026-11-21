import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import type { CliIO } from "../../../src/cli/commands/index.js";
import { main } from "../../../src/cli/main.js";
import { HOSTILE, HOSTILE_SHOWN, rawLines } from "../../helpers/terminal.js";

const USAGE = "usage: hakutaku profile <repo> [--ref <ref>] [--out <file>]\n";

it("says an option it does not take on lines safe for a terminal", async () => {
  let out = "";
  let err = "";
  const io: CliIO = {
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    stdin: new PassThrough(),
    env: {},
    isTTY: false,
  };
  expect(await main(["profile", "repo", `--${HOSTILE}`], io)).toBe(2);
  expect(err).toMatch(/^hakutaku profile: .+\n/);
  expect(err).toContain(HOSTILE_SHOWN);
  expect(err.endsWith(USAGE)).toBe(true);
  expect(rawLines(err)).toEqual([]);
  expect(out).toBe("");
});
