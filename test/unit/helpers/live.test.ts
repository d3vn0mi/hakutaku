import { afterEach, expect, it, vi } from "vitest";
import {
  commandProbe,
  inCI,
  type LiveProbe,
  requireInCI,
} from "../../helpers/live.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const node = process.execPath;

it("passes a probe whose command exits 0, keeping no evidence", () =>
  expect(commandProbe("node", [node, "-e", ""])).toEqual({
    name: "node",
    ok: true,
    evidence: "",
  }));

it("keeps a failed probe's command, its exit code and the last line it said", () => {
  const argv = [
    node,
    "-e",
    'console.error("first line\\nlast line\\n"); process.exit(3)',
  ];
  expect(commandProbe("a tool", argv)).toEqual({
    name: "a tool",
    ok: false,
    evidence: `${argv.join(" ")}: exit code 3: last line`,
  });
});

it("says a command that is not installed could not start", () =>
  expect(
    commandProbe("a tool", ["hakutaku-no-such-tool", "--version"]).evidence,
  ).toBe("hakutaku-no-such-tool --version: could not start: ENOENT"));

it("says a probe was stopped by a signal, or timed out", () => {
  expect(
    commandProbe("a tool", [node, "-e", 'process.kill(process.pid, "SIGKILL")'])
      .evidence,
  ).toMatch(/: stopped by SIGKILL$/);
  const hangs = commandProbe(
    "a tool",
    [node, "-e", "setTimeout(() => {}, 60_000)"],
    200,
  );
  expect(hangs.ok).toBe(false);
  expect(hangs.evidence).toMatch(/: timed out after 0\.2 s$/);
});

it("cuts the line a failed probe said at 300 characters", () => {
  const evidence = commandProbe("a tool", [
    node,
    "-e",
    'console.error("x".repeat(400)); process.exit(1)',
  ]).evidence;
  expect(evidence.endsWith(`: exit code 1: ${"x".repeat(300)}`)).toBe(true);
});

it("reads CI=true as CI, and anything else as a developer's machine", () => {
  vi.stubEnv("CI", "true");
  expect(inCI()).toBe(true);
  for (const value of [undefined, "", "false"]) {
    vi.stubEnv("CI", value);
    expect(inCI()).toBe(false);
  }
});

// A test context whose skip throws, as vitest's does, carrying the note it was given.
class Skipped extends Error {}
const ctx = {
  skip: (note?: string): never => {
    throw new Skipped(note);
  },
};
const works: LiveProbe = { name: "bubblewrap", ok: true, evidence: "" };
const noManager: LiveProbe = {
  name: "a systemd user manager",
  ok: false,
  evidence:
    "systemd-run --user --wait true: exit code 1: Failed to connect to bus: No medium found",
};
const noOomPolicy: LiveProbe = {
  name: "OOMPolicy on a systemd-run scope",
  ok: false,
  evidence:
    "systemd-run --user --scope -p OOMPolicy=continue true: exit code 1: Unknown assignment",
};
const noNetwork: LiveProbe = {
  name: "a network interface besides loopback",
  ok: false,
  evidence: "this host has lo",
};

// What requireInCI threw, or undefined.
const thrownBy = (...probes: LiveProbe[]): unknown => {
  try {
    requireInCI(ctx, ...probes);
  } catch (e) {
    return e;
  }
  return undefined;
};

it("lets a live test go on where every probe passed, in CI or not", () => {
  vi.stubEnv("CI", "true");
  expect(thrownBy(works)).toBeUndefined();
  vi.stubEnv("CI", undefined);
  expect(thrownBy(works)).toBeUndefined();
  expect(thrownBy()).toBeUndefined();
});

it("skips a live test outside CI where a probe failed, naming it and what it said", () => {
  vi.stubEnv("CI", undefined);
  const thrown = thrownBy(works, noManager);
  expect(thrown).toBeInstanceOf(Skipped);
  expect((thrown as Error).message).toBe(
    `needs a systemd user manager (${noManager.evidence})`,
  );
  expect((thrownBy(noManager, noOomPolicy) as Error).message).toBe(
    `needs a systemd user manager (${noManager.evidence}) and OOMPolicy on a systemd-run scope (${noOomPolicy.evidence})`,
  );
});

it("fails a live test in CI where a probe failed, naming each failed probe and what it said", () => {
  vi.stubEnv("CI", "true");
  const thrown = thrownBy(noManager, works, noOomPolicy);
  expect(thrown).toBeInstanceOf(Error);
  expect(thrown).not.toBeInstanceOf(Skipped);
  expect((thrown as Error).message).toBe(
    [
      "needs a systemd user manager and OOMPolicy on a systemd-run scope: in CI a live test fails where its tools do not work, rather than skip",
      `a systemd user manager: ${noManager.evidence}`,
      `OOMPolicy on a systemd-run scope: ${noOomPolicy.evidence}`,
    ].join("\n"),
  );
  expect(
    (thrownBy(noManager, noOomPolicy, noNetwork) as Error).message.split(
      "\n",
    )[0],
  ).toBe(
    "needs a systemd user manager, OOMPolicy on a systemd-run scope and a network interface besides loopback: in CI a live test fails where its tools do not work, rather than skip",
  );
});
