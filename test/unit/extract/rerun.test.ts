import { expect, it } from "vitest";
import {
  innerArgv,
  innerFailure,
  type Rerun,
} from "../../../src/extract/rerun.js";

const rerun: Rerun = {
  sandbox: "bubblewrap",
  dir: "/srv/observatory/export",
  out: "/srv/observatory/store/store.sqlite",
  enginesDir: "/srv/observatory/engines",
  detail: "standard",
  noSource: false,
  memoryMax: "3G",
  pythonPath: null,
  home: "/srv/astronomer",
};

it("tells the sandboxed run whether its sandbox caps memory, and the home directory to name ~", () => {
  const capped = innerArgv(rerun, true);
  expect(capped.slice(2)).toEqual([
    "extract",
    "/srv/observatory/export",
    "--out",
    "/srv/observatory/store/store.sqlite",
    "--engines-dir",
    "/srv/observatory/engines",
    "--detail",
    "standard",
    "--sandbox",
    "none",
    "--sandboxed-by",
    "bubblewrap",
    "--memory-max",
    "3G",
    "--memory-capped",
    "--home",
    "/srv/astronomer",
  ]);
  const uncapped = innerArgv({ ...rerun, home: null, noSource: true }, false);
  expect(uncapped).not.toContain("--memory-capped");
  expect(uncapped).not.toContain("--home");
  expect(uncapped).toContain("--no-source");
});

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
