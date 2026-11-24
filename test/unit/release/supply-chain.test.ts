// The supply chain, read from the repository's own files: every GitHub Action pinned by a full
// commit SHA, with its tag in a comment; no workflow that runs on pull_request_target, reads a
// secret, passes secrets on to a workflow it calls or names a stored npm token; installs through
// npm ci; every dependency and override pinned to one exact version, with the lockfile committed;
// Renovate's update proposals, which wait 14 days and never push or merge on their own; ci.yml's
// triggers and its read-only token; and release.yml, which runs on a v* tag only: the full CI and
// a map of a pinned public repository inside the sandbox, then the package through npm's trusted
// publishing, the GitHub release and the sample's map on Pages, each job with only the
// permissions it needs.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import YAML from "yaml";

interface Step {
  name?: string;
  id?: string;
  run?: string;
  uses?: string;
  shell?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  "continue-on-error"?: unknown;
}

// The fields of a job the tests read; environment as release.yml's pages job writes it.
interface Job {
  uses?: string;
  needs?: string | string[];
  permissions?: unknown;
  environment: { name: string; url: string };
  "timeout-minutes"?: number;
  "continue-on-error"?: unknown;
  defaults?: unknown;
  steps?: Step[];
  secrets?: unknown;
}

interface Workflow {
  name?: string;
  on?: unknown;
  permissions?: unknown;
  concurrency?: unknown;
  defaults?: unknown;
  jobs?: Record<string, Job>;
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

it("no job passes secrets on to a called workflow, and no workflow takes any when called", () => {
  const offenders: string[] = [];
  const all = workflows();
  expect(all.length).toBeGreaterThan(0);
  for (const w of all) {
    for (const [job, j] of Object.entries(w.doc.jobs ?? {})) {
      if (j !== null && typeof j === "object" && "secrets" in j) {
        offenders.push(`${w.file}: ${job}: secrets`);
      }
    }
    const on = w.doc.on;
    if (on !== null && typeof on === "object" && !Array.isArray(on)) {
      const call = (on as Record<string, unknown>).workflow_call;
      if (call !== null && typeof call === "object" && "secrets" in call) {
        offenders.push(`${w.file}: workflow_call: secrets`);
      }
    }
  }
  expect(offenders).toEqual([]);
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

// Every version an overrides map sets, with the path to it: an override may hold one version, or
// a map for the package's own dependencies, whose "." key is the version of the package itself.
function overrideVersions(
  map: unknown,
  path: string[] = [],
): Array<[string, unknown]> {
  if (map === null || typeof map !== "object") return [[path.join(" > "), map]];
  return Object.entries(map as Record<string, unknown>).flatMap(([name, v]) =>
    overrideVersions(v, name === "." ? path : [...path, name]),
  );
}

it("every dependency is pinned exactly", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const exact = (v: unknown) =>
    typeof v === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v);
  const loose = [
    ...Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }),
    ...overrideVersions(pkg.overrides ?? {}).map(([name, v]) => [
      `overrides: ${name}`,
      v,
    ]),
  ].filter(([, v]) => !exact(v));
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

// release.yml, read in each test that needs it, so that the other tests run without it.
function release(): Workflow & { jobs: Record<string, Job> } {
  return YAML.parse(readFileSync(`${WORKFLOWS}/release.yml`, "utf8"));
}

// A job of release.yml: its steps, their run strings and their uses values.
const stepsOf = (job: string): Step[] => release().jobs[job]?.steps ?? [];
const runsOf = (job: string): string[] =>
  stepsOf(job).flatMap((s) => (s.run === undefined ? [] : [s.run]));
const usesOf = (job: string): string[] =>
  stepsOf(job).flatMap((s) => (s.uses === undefined ? [] : [s.uses]));

// An expression of GitHub's, written here without a template literal's placeholder.
const expr = (inner: string): string => `$\{{ ${inner} }}`;

it("release.yml runs only for v* tags, with no default permissions", () => {
  const rel = release();
  expect(rel.on).toEqual({ push: { tags: ["v*"] } });
  expect(rel.permissions).toEqual({});
  // one release at a time, and none cancelled halfway; the five jobs, and no other
  expect(rel.name).toBe("release");
  expect(rel.concurrency).toEqual({
    group: "release",
    "cancel-in-progress": false,
  });
  expect(Object.keys(rel.jobs)).toEqual([
    "ci",
    "realism",
    "publish",
    "github-release",
    "pages",
  ]);
});

it("release.yml publishes after the full CI, through OIDC, with provenance", () => {
  const rel = release();
  expect(rel.jobs.ci.uses).toBe("./.github/workflows/ci.yml");
  expect(rel.jobs.publish.needs).toEqual(["ci", "realism"]);
  expect(rel.jobs.publish.permissions).toEqual({
    contents: "read",
    "id-token": "write",
  });
  expect(rel.jobs.publish.environment).toBe("npm");
  const runs = runsOf("publish").map((r) => r.trim());
  const check = runs.indexOf(
    'node scripts/release/check-release.mjs "$GITHUB_REF_NAME" --publishing',
  );
  expect(check).toBeGreaterThanOrEqual(0);
  expect(
    runs.indexOf("npm publish --provenance --access public"),
  ).toBeGreaterThan(check);
  // the called CI reads only; the version check comes before npm ci and the build, and nothing
  // else runs; Node and npm come from lts/*, never the 22.16.0 floor, with npm's registry
  expect(rel.jobs.ci.permissions).toEqual({ contents: "read" });
  expect(runs).toEqual([
    'node scripts/release/check-release.mjs "$GITHUB_REF_NAME" --publishing',
    "npm ci",
    "npm run build",
    "npm publish --provenance --access public",
  ]);
  const node = stepsOf("publish").find((s) =>
    s.uses?.startsWith("actions/setup-node@"),
  );
  expect(node?.with).toEqual({
    "node-version": "lts/*",
    "registry-url": "https://registry.npmjs.org",
  });
});

it("release.yml writes the GitHub release from CHANGELOG.md and deploys the sample's map to Pages", () => {
  const rel = release();
  expect(rel.jobs["github-release"].needs).toBe("publish");
  expect(rel.jobs["github-release"].permissions).toEqual({ contents: "write" });
  expect(runsOf("github-release").join("\n")).toContain(
    'gh release create "$GITHUB_REF_NAME" --verify-tag',
  );
  expect(rel.jobs.pages.needs).toBe("publish");
  expect(rel.jobs.pages.permissions).toEqual({
    contents: "read",
    pages: "write",
    "id-token": "write",
  });
  expect(rel.jobs.pages.environment.name).toBe("github-pages");
  expect(runsOf("pages").join("\n")).toContain(
    "view observatory --export site/index.html --with-source",
  );
  expect(runsOf("pages").join("\n")).toContain(
    "node scripts/release/scan.mjs site/index.html",
  );
  expect(usesOf("pages").map((u) => u.split("@")[0])).toEqual(
    expect.arrayContaining([
      "actions/upload-pages-artifact",
      "actions/deploy-pages",
    ]),
  );
  // the notes check-release writes are the notes gh reads, with the job's own token
  expect(runsOf("github-release").map((r) => r.trim())).toEqual([
    'node scripts/release/check-release.mjs "$GITHUB_REF_NAME" --notes "$RUNNER_TEMP/notes.md"',
    'gh release create "$GITHUB_REF_NAME" --verify-tag --title "hakutaku $GITHUB_REF_NAME" --notes-file "$RUNNER_TEMP/notes.md"',
  ]);
  const gh = stepsOf("github-release").find((s) =>
    s.run?.includes("gh release create"),
  );
  expect(gh?.env).toEqual({ GH_TOKEN: expr("github.token") });
  // the sample, made and mapped with no sandbox, is exported, then scanned by the bare command,
  // whose every failure fails the job, and only then uploaded and deployed
  const pages = stepsOf("pages");
  const exported = pages.findIndex(
    (s) => s.run?.includes("--export site/index.html") === true,
  );
  const scanned = pages.findIndex(
    (s) => s.run?.trim() === "node scripts/release/scan.mjs site/index.html",
  );
  const uploaded = pages.findIndex(
    (s) => s.uses?.startsWith("actions/upload-pages-artifact@") === true,
  );
  const deployed = pages.findIndex(
    (s) => s.uses?.startsWith("actions/deploy-pages@") === true,
  );
  expect(exported).toBeGreaterThanOrEqual(0);
  expect(scanned).toBeGreaterThan(exported);
  expect(uploaded).toBeGreaterThan(scanned);
  expect(deployed).toBeGreaterThan(uploaded);
  const build = pages[exported]?.run ?? "";
  expect(build).toContain(
    'node fixtures/observatory/make.mjs "$RUNNER_TEMP/sample"',
  );
  expect(build).toContain(
    'map "$RUNNER_TEMP/sample/observatory" --sandbox none --yes',
  );
  expect(pages[uploaded]?.with).toEqual({ path: "site" });
  expect(pages[deployed]?.id).toBe("deploy");
  expect(rel.jobs.pages.environment.url).toBe(
    expr("steps.deploy.outputs.page_url"),
  );
});

it("release.yml maps the pinned public repository inside the sandbox before publishing", () => {
  const rel = release();
  const pin = JSON.parse(readFileSync("fixtures/realism.json", "utf8"));
  expect(Object.keys(pin)).toEqual(["url", "commit"]);
  expect(pin.url).toMatch(/^https:\/\/\S+$/);
  expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(rel.jobs.realism.needs).toBe("ci");
  const run = runsOf("realism").join("\n");
  expect(run).toContain('require("./fixtures/realism.json")');
  expect(run).toContain('--ref "$COMMIT" --sandbox require --yes');
  // a read-only token and a time limit; bubblewrap installed, user namespaces allowed and the
  // package built before the map; and a full clone, since export has no network to fetch with
  expect(rel.jobs.realism.permissions).toEqual({ contents: "read" });
  expect(rel.jobs.realism["timeout-minutes"]).toBe(30);
  const runs = runsOf("realism");
  const mapped = runs.findIndex((r) => r.includes("--sandbox require --yes"));
  for (const before of [
    /\bapt-get install -y bubblewrap\b/,
    /\bsysctl -w kernel\.apparmor_restrict_unprivileged_userns=0$/m,
    /^npm ci$/,
    /^npm run build$/,
  ]) {
    const at = runs.findIndex((r) => before.test(r.trim()));
    expect(at, String(before)).toBeGreaterThanOrEqual(0);
    expect(at, String(before)).toBeLessThan(mapped);
  }
  expect(run).toContain('git clone --quiet "$URL" "$RUNNER_TEMP/realism"');
  expect(run).not.toMatch(/--depth|--shallow|--filter/);
});

it("every checkout keeps no credentials, each action has one pin, and no release step may fail without failing the release", () => {
  const offenders: string[] = [];
  const pins = new Map<string, Set<string>>();
  let checkouts = 0;
  for (const w of workflows()) {
    for (const { job, step } of steps(w.doc)) {
      if (step.uses === undefined || step.uses.startsWith("./")) continue;
      const [action = "", sha = ""] = step.uses.split("@");
      pins.set(action, new Set([...(pins.get(action) ?? []), sha]));
      if (action !== "actions/checkout") continue;
      checkouts += 1;
      if (step.with?.["persist-credentials"] !== false) {
        offenders.push(`${w.file}: ${job}: checkout keeps its credentials`);
      }
    }
  }
  expect(checkouts).toBeGreaterThan(0);
  for (const [action, shas] of pins) {
    if (shas.size !== 1) offenders.push(`${action}: ${[...shas].join(", ")}`);
  }
  // a step that may fail quietly, or a shell that need not stop at a failed command
  const rel = release();
  if ("defaults" in rel) offenders.push("release.yml: defaults");
  for (const [name, job] of Object.entries(rel.jobs)) {
    for (const key of ["continue-on-error", "defaults"] as const) {
      if (key in job) offenders.push(`release.yml: ${name}: ${key}`);
    }
    for (const step of job.steps ?? []) {
      for (const key of ["continue-on-error", "shell"] as const) {
        if (key in step) {
          offenders.push(
            `release.yml: ${name}: ${step.run ?? step.uses}: ${key}`,
          );
        }
      }
    }
  }
  expect(offenders).toEqual([]);
});
