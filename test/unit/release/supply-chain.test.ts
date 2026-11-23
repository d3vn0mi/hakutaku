// The supply chain, read from the repository's own files: every GitHub Action pinned by a full
// commit SHA, with its tag in a comment; no workflow that runs on pull_request_target, reads a
// secret or names a stored npm token; installs through npm ci; every dependency pinned to one exact
// version, with the lockfile committed; Renovate's update proposals, which wait 14 days and never
// push or merge on their own; and ci.yml's triggers and its read-only token.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import YAML from "yaml";

interface Step {
  name?: string;
  run?: string;
  uses?: string;
}

interface Workflow {
  on?: unknown;
  permissions?: unknown;
  jobs?: Record<string, { steps?: Step[] }>;
}

const WORKFLOWS = ".github/workflows";

// Each workflow: its path, its text and the document it parses to.
function workflows(): Array<{ file: string; text: string; doc: Workflow }> {
  return readdirSync(WORKFLOWS)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => {
      const file = `${WORKFLOWS}/${name}`;
      const text = readFileSync(file, "utf8");
      return { file, text, doc: YAML.parse(text) as Workflow };
    });
}

function ciWorkflow(): { file: string; text: string; doc: Workflow } {
  const ci = workflows().find((w) => w.file.endsWith("/ci.yml"));
  if (ci === undefined) throw new Error(`${WORKFLOWS}/ci.yml is missing`);
  return ci;
}

// Every step of every job, with the name of its job.
function steps(doc: Workflow): Array<{ job: string; step: Step }> {
  return Object.entries(doc.jobs ?? {}).flatMap(([job, j]) =>
    (j.steps ?? []).map((step) => ({ job, step })),
  );
}

// The events a workflow runs on, in any of the three forms its "on" may take: one event, a list
// of events, or a map from each event to its filters.
function events(doc: Workflow): string[] {
  const on = doc.on;
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  return Object.keys(on ?? {});
}

// The paths git tracks under a path.
function tracked(path: string): string[] {
  return execFileSync("git", ["ls-files", "--", path], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "");
}

// A line that names an action, and the form it must take: the value, then a comment.
const USES_KEY = /^\s*(?:-\s+)?uses:/;
const USES = /^\s*(?:-\s+)?uses:\s+(\S+)(?:\s+#\s+(\S+))?\s*$/;
const BY_SHA = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;
const TAG = /^v?\d+(\.\d+){0,2}\S*$/;

it("every action is pinned by a full commit SHA with its tag in a comment", () => {
  const badUses: string[] = [];
  let checked = 0;
  for (const w of workflows()) {
    for (const [i, line] of w.text.split("\n").entries()) {
      if (!USES_KEY.test(line)) continue;
      checked += 1;
      const m = USES.exec(line);
      const value = m?.[1] ?? line.trim();
      const local = value.startsWith("./");
      const pinned = BY_SHA.test(value) && TAG.test(m?.[2] ?? "");
      if (m === null || !(local || pinned)) {
        badUses.push(`${w.file}:${i + 1}: ${value}`);
      }
    }
  }
  expect(checked).toBeGreaterThan(0);
  expect(badUses).toEqual([]);
});

it("no workflow uses pull_request_target, a secret or a stored npm token", () => {
  const all = workflows();
  expect(all.length).toBeGreaterThan(0);
  for (const w of all) {
    expect(events(w.doc)).not.toContain("pull_request_target");
    expect(w.text).not.toMatch(/\$\{\{[^}]*\bsecrets\b/);
    expect(w.text).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
  }
});

it("installs use npm ci", () => {
  const offenders: string[] = [];
  for (const w of workflows()) {
    for (const { job, step } of steps(w.doc)) {
      if (/\bnpm\s+(install|i|add)\b/.test(step.run ?? "")) {
        offenders.push(`${w.file}: ${job}: ${step.run}`);
      }
    }
  }
  const ci = ciWorkflow();
  for (const job of ["linux", "macos-smoke"]) {
    const runs = steps(ci.doc)
      .filter((s) => s.job === job)
      .map((s) => s.step.run ?? "");
    if (!runs.some((run) => /\bnpm ci\b/.test(run))) {
      offenders.push(`${ci.file}: ${job}: no step runs npm ci`);
    }
  }
  expect(offenders).toEqual([]);
});

it("every dependency is pinned exactly", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const loose = Object.entries({
    ...pkg.dependencies,
    ...pkg.devDependencies,
  }).filter(
    ([, v]) => !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v as string),
  );
  expect(loose).toEqual([]);
});

it("the lockfile is committed at version 3", () => {
  expect(tracked("package-lock.json")).toEqual(["package-lock.json"]);
  expect(
    JSON.parse(readFileSync("package-lock.json", "utf8")).lockfileVersion,
  ).toBe(3);
});

it("renovate proposes updates after 14 days, and never pushes or merges on its own", () => {
  const r = JSON.parse(readFileSync("renovate.json", "utf8"));
  expect(r.minimumReleaseAge).toBe("14 days");
  expect(r.internalChecksFilter).toBe("strict");
  expect(r.dependencyDashboardApproval).toBe(true);
  expect(r.automerge).toBe(false);
  expect(r.extends).toContain("helpers:pinGitHubActionDigestsToSemver");
});

it("ci.yml runs on branch pushes, pull requests and calls, with read-only contents", () => {
  const ci = ciWorkflow().doc;
  expect(ci.on).toEqual({
    push: { branches: ["**"] },
    pull_request: null,
    workflow_call: null,
  });
  expect(ci.permissions).toEqual({ contents: "read" });
});
