// Live tests: tests that need a tool of this host that works, such as bubblewrap or a systemd
// user manager. A test names what it needs as probes, commands its file runs once when it loads,
// and calls requireInCI first. Where a probe failed, the test is skipped on a developer's machine;
// in CI it fails instead, naming each failed probe and what it said, so that a security test that
// never ran cannot pass there.
import { spawnSync } from "node:child_process";

export interface LiveProbe {
  name: string; // what a test needs, such as "bubblewrap"
  ok: boolean;
  evidence: string; // how the probe failed: its command, how it ended and its last line; "" when ok
}

const EXCERPT_CHARS = 300;

// Runs argv once; the probe passes when it exits 0 within the timeout.
export function commandProbe(
  name: string,
  argv: readonly string[],
  timeoutMs = 30_000,
): LiveProbe {
  const r = spawnSync(argv[0] ?? "", argv.slice(1), {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
    timeout: timeoutMs,
  });
  if (r.error === undefined && r.status === 0) {
    return { name, ok: true, evidence: "" };
  }
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  const outcome =
    code === "ETIMEDOUT"
      ? `timed out after ${timeoutMs / 1000} s`
      : r.error !== undefined
        ? `could not start: ${code ?? r.error.message}`
        : r.signal !== null
          ? `stopped by ${r.signal}`
          : `exit code ${r.status}`;
  const said = (r.stderr ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1);
  const excerpt = said === undefined ? "" : `: ${said.slice(0, EXCERPT_CHARS)}`;
  return {
    name,
    ok: false,
    evidence: `${argv.join(" ")}: ${outcome}${excerpt}`,
  };
}

// Whether this run is CI's: CI=true, which GitHub Actions sets for every step.
export const inCI = (): boolean => process.env.CI === "true";

// "a", "a and b", "a, b and c".
const listed = (items: string[]): string =>
  items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

// Called first in a live test, with the test's context. Where every probe passed, the test goes
// on. Where one failed, the test is skipped, with a note naming each failed probe; in CI it throws
// instead, and so fails, with the same names and what each probe said.
export function requireInCI(
  ctx: { skip: (note?: string) => never },
  ...probes: LiveProbe[]
): void {
  const failed = probes.filter((p) => !p.ok);
  if (failed.length === 0) return;
  if (inCI()) {
    throw new Error(
      [
        `needs ${listed(failed.map((p) => p.name))}: in CI a live test fails where its tools do not work, rather than skip`,
        ...failed.map((p) => `${p.name}: ${p.evidence}`),
      ].join("\n"),
    );
  }
  ctx.skip(`needs ${listed(failed.map((p) => `${p.name} (${p.evidence})`))}`);
}
