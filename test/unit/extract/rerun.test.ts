import { expect, it } from "vitest";
import { innerFailure } from "../../../src/extract/rerun.js";

it("takes the sandboxed run's own message, to the end of the stderr seen", () => {
  expect(
    innerFailure({
      code: 1,
      signal: null,
      stderrTail:
        "grimp: left out the package sky\nhakutaku: ast-grep failed: ERROR: web/a.ts\ndenied\n",
    }),
  ).toEqual({
    message: "ast-grep failed: ERROR: web/a.ts\ndenied",
    printed: true,
  });
  expect(
    innerFailure({
      code: 1,
      signal: null,
      stderrTail: "hakutaku: the engines are not ready (not installed)\n",
    }),
  ).toEqual({
    message: "the engines are not ready (not installed)",
    printed: true,
  });
});

it("says how the sandboxed run ended when it printed no message of its own", () => {
  expect(
    innerFailure({ code: null, signal: "SIGKILL", stderrTail: "" }),
  ).toEqual({
    message: "the sandboxed extract was stopped by SIGKILL",
    printed: false,
  });
  // "hakutaku: " inside a line is not the CLI's message
  expect(
    innerFailure({
      code: 137,
      signal: null,
      stderrTail: "a note from hakutaku: none\nKilled\n",
    }),
  ).toEqual({
    message: "the sandboxed extract ended with exit code 137",
    printed: false,
  });
});
