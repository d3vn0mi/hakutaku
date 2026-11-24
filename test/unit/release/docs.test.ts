// The public docs: the screenshots of the sample in docs/img/ and the docs that show them, the
// sections of the design and of the security model, and the ID and link-token pairs that the
// design's tables quote, each checked against the codec. Then the project files: the README's
// order, examples and set-up, the links and the scan of every public doc, SECURITY.md,
// CONTRIBUTING.md, and the issue and pull request templates.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import YAML from "yaml";
import { scanText } from "../../../scripts/release/scan.mjs";
import { SCREENSHOTS } from "../../../scripts/screenshots.mjs";
import { fromToken, parseId, toToken } from "../../../src/model/index.js";
import { LABEL_WORDING, TOOL_NAMES } from "../../../src/tools/index.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// The files git lists under p, sorted: tracked ones, and untracked ones that .gitignore does not
// exclude, so that a new file counts before it is committed, and build output such as dist/ and
// .cache/ never does.
function listed(p: string): string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", p],
    { cwd: ROOT, encoding: "utf8" },
  );
  return [...new Set(out.split("\0").filter((f) => f !== ""))].sort();
}

const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

// The text of each "## " heading of a file, in order.
const headings = (p: string): string[] =>
  read(p)
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3));

// The text under a "## " heading of a Markdown text, up to the next "## " heading.
function section(md: string, heading: string): string {
  const lines = md.split("\n");
  const at = lines.indexOf(`## ${heading}`);
  if (at < 0) throw new Error(`no "## ${heading}" heading`);
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

// A Markdown text without its fenced code blocks, indented ones in a list included.
const withoutFences = (md: string): string =>
  md.replace(/^ *```[^\n]*\n[\s\S]*?^ *```[ \t]*$/gm, "");

// A Markdown text without its fenced code blocks and its code spans, which hold no link.
const withoutCode = (md: string): string =>
  withoutFences(md).replace(/`[^`\n]*`/g, "");

// The targets of a Markdown text's inline links and images, [...](target) and ![...](target).
const linkTargets = (md: string): string[] =>
  [...withoutCode(md).matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? "");

// The repository paths of the images a Markdown file shows, ![...](target), each target resolved
// from the file's folder.
function shownImages(p: string): string[] {
  return [...read(p).matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) =>
    normalize(join(dirname(p), m[1] ?? "")),
  );
}

// The ID and token pairs of a text's tables: each row whose first cell is a code span that parses
// as an ID, and whose second is a code span or "(empty)", the repository's empty token.
function pairsIn(text: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const line of text.split("\n")) {
    const m = /^\|\s*`([^`]+)`\s*\|\s*(?:`([^`]*)`|(\(empty\)))\s*\|/.exec(
      line,
    );
    const id = m?.[1];
    const token = m?.[3] === undefined ? m?.[2] : "";
    if (id !== undefined && token !== undefined && parseId(id) !== null) {
      pairs.push([id, token]);
    }
  }
  return pairs;
}

const tokenPairs = (p: string): Array<[string, string]> => pairsIn(read(p));

// Each pair's ID gives its token, and its token gives the ID back.
function expectRoundTrips(pairs: Array<[string, string]>): void {
  for (const [id, token] of pairs) {
    const ref = parseId(id);
    if (ref === null) throw new Error(`not an ID: ${id}`);
    expect(toToken(ref), id).toBe(token);
    expect(fromToken(ref.repo, token), token).toEqual(ref);
  }
}

// A PNG's width and height, from its IHDR chunk, which must come first.
function pngSize(p: string): { width: number; height: number } {
  const bytes = readFileSync(join(ROOT, p));
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (!bytes.subarray(0, 8).equals(signature)) {
    throw new Error(`${p} is not a PNG`);
  }
  if (bytes.toString("latin1", 12, 16) !== "IHDR") {
    throw new Error(`${p} has no IHDR chunk first`);
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

it("docs/img holds exactly the screenshots the script writes, and the docs show each one", () => {
  expect(listed("docs/img")).toEqual([...SCREENSHOTS].sort());
  const docs = [
    "README.md",
    ...listed("docs").filter((p) => p.endsWith(".md")),
  ];
  const shown = docs.flatMap(shownImages);
  for (const img of SCREENSHOTS) expect(shown, img).toContain(img);
});

it("each screenshot is a PNG of 1440 by 900 pixels, the script's viewport", () => {
  for (const img of SCREENSHOTS) {
    expect(pngSize(img), img).toEqual({ width: 1440, height: 900 });
  }
});

it("the design and security docs keep the published sections", () => {
  expect(headings("docs/design.md")).toEqual([
    "Intent",
    "Goals, non-goals and anti-goals",
    "Users and the first run",
    "Architecture",
    "Data model",
    "The agent interface",
    "The viewer",
    "Languages and engines",
    "Security",
    "Acceptance",
    "Versions",
    "References",
  ]);
  expect(headings("docs/security.md")).toEqual([
    "Threat model",
    "Nothing from the analysed repository runs",
    "The extraction sandbox",
    "Secrets are never stored",
    "Injected instructions and the viewer",
    "What hakutaku never does",
    "Reporting a vulnerability",
  ]);
});

it("every ID and token pair in the design round-trips", () => {
  // the file, definition, directory and external rows, then five harder cases
  const pairs = tokenPairs("docs/design.md");
  expect(pairs.length).toBeGreaterThanOrEqual(9);
  expectRoundTrips(pairs);
});

const readme = read("README.md");

const HEADINGS = [
  "Quick start",
  "Set up in an MCP client",
  "Tools",
  "Labels",
  "Stable IDs and link tokens",
  "Viewer",
  "Languages and engines",
  "Security model",
  "Limits and blind spots",
  "Credits",
  "Licence",
  "Author: d3vn0mi",
];
const ONE_LINE =
  "hakutaku maps a code repository for AI agents first and people second: who calls what, what a change " +
  "reaches, what matters most. It works from one local store, and never runs the repository's code.";

it("README follows the published order", () => {
  const lines = readme.split("\n");
  expect(lines[0]).toBe("# hakutaku");
  expect(lines.find((l, i) => i > 0 && l.trim() !== "")).toBe(ONE_LINE);
  expect(
    lines.filter((l) => l.startsWith("## ")).map((l) => l.slice(3)),
  ).toEqual(HEADINGS);
  expect(readme.trimEnd().endsWith("## Author: d3vn0mi")).toBe(true);
});

it("README lists every tool and quotes every label's wording", () => {
  for (const name of TOOL_NAMES) {
    expect(section(readme, "Tools")).toContain(`\`${name}\``);
  }
  for (const w of Object.values(LABEL_WORDING)) {
    expect(section(readme, "Labels")).toContain(w);
  }
});

it("every ID and token pair in the README round-trips", () => {
  // the file, definition, directory, external and repository rows, then five harder cases
  const pairs = pairsIn(section(readme, "Stable IDs and link tokens"));
  expect(pairs.length).toBeGreaterThanOrEqual(10);
  expect(pairs).toContainEqual(["observatory:", ""]);
  expectRoundTrips(pairs);
});

it("README's quick start installs a pinned hakutaku globally, and never runs it through npx", () => {
  const quick = section(readme, "Quick start").split("\n");
  expect(quick.filter((l) => /^npm install -g hakutaku@/.test(l))).toEqual([
    expect.stringMatching(/^npm install -g hakutaku@\d+\.\d+\.\d+$/),
  ]);
  for (const command of [
    "hakutaku map ~/code/observatory",
    "hakutaku view observatory --open",
    "hakutaku mcp observatory",
  ]) {
    expect(quick).toContain(command);
  }
  expect(quick.join("\n")).toContain(
    "Do not run hakutaku through `npx` inside a repository.",
  );
  expect(readme).not.toMatch(/\bnpx\s+(?:-y\s+)?hakutaku/);
});

it("README's MCP client example starts the installed hakutaku over stdio", () => {
  const block = /```json\n([\s\S]*?)```/.exec(
    section(readme, "Set up in an MCP client"),
  )?.[1];
  if (block === undefined) {
    throw new Error("the MCP set-up holds no json block");
  }
  const cfg = JSON.parse(block) as {
    mcpServers: Record<string, unknown>;
  };
  expect(cfg.mcpServers).toEqual({
    hakutaku: { command: "hakutaku", args: ["mcp", "observatory"] },
  });
});

it("README's viewer section shows the sample's map and its source view", () => {
  const shown = [
    ...section(readme, "Viewer").matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g),
  ].map((m) => m[1]);
  expect(shown).toEqual(["docs/img/map.png", "docs/img/source.png"]);
});

// The public docs, each read whole.
const PUBLIC_DOCS = [
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  ...listed("docs").filter((p) => p.endsWith(".md")),
];

it("every relative link in the public docs resolves", () => {
  const files = new Set(listed("."));
  const folders = new Set(
    [...files].flatMap((f) =>
      f
        .split("/")
        .slice(0, -1)
        .map((_, i, parts) => parts.slice(0, i + 1).join("/")),
    ),
  );
  const broken: string[] = [];
  let checked = 0;
  for (const f of PUBLIC_DOCS) {
    for (const target of linkTargets(read(f))) {
      if (/^(?:https?:|mailto:|#)/.test(target)) continue;
      checked += 1;
      const path = normalize(
        join(dirname(f), decodeURIComponent(target.replace(/#.*$/, ""))),
      ).replace(/\/$/, "");
      if (!files.has(path) && !folders.has(path))
        broken.push(`${f}: ${target}`);
    }
  }
  expect(checked).toBeGreaterThan(20);
  expect(broken).toEqual([]);
});

it("the public docs carry no home path or secret", () => {
  for (const f of [...PUBLIC_DOCS, "NOTICE"]) {
    expect(scanText(f, read(f)), f).toEqual([]);
  }
});

it("SECURITY.md routes reports privately, and names no email address", () => {
  const security = read("SECURITY.md");
  expect(headings("SECURITY.md")).toEqual([
    "The no-execution guarantee",
    "Reporting a vulnerability",
    "Supported versions",
  ]);
  expect(security).toContain(
    "https://github.com/d3vn0mi/hakutaku/security/advisories/new",
  );
  expect(security).not.toMatch(
    /\b[\w.+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/,
  );
});

it("CONTRIBUTING.md keeps issues on the synthetic sample", () => {
  const contributing = read("CONTRIBUTING.md");
  expect(headings("CONTRIBUTING.md")).toEqual([
    "Set-up",
    "Reproduce on the sample",
    "Changes",
    "Updating an engine",
    "Releasing",
  ]);
  expect(contributing).toContain(
    "Reproduce every issue on the synthetic sample.",
  );
  const sample = section(contributing, "Reproduce on the sample").split("\n");
  for (const command of [
    "node fixtures/observatory/make.mjs /tmp/hakutaku-sample",
    "node dist/cli/main.js map /tmp/hakutaku-sample/observatory --yes",
    `node dist/cli/main.js query code_explain observatory --args '{"target":"web/src/orbits/kepler.ts"}'`,
  ]) {
    expect(sample).toContain(command);
  }
  expect(contributing).toContain(
    "Never paste code, paths, names or tool output from a private repository into an issue, a pull request or a commit message.",
  );
});

it("CONTRIBUTING.md names what ci:local needs and checks, and how to refresh the licence texts and the screenshots", () => {
  const contributing = read("CONTRIBUTING.md");
  const setUp = section(contributing, "Set-up");
  expect(setUp).toContain("bubblewrap");
  expect(setUp).toContain("strace");
  // the comment beside npm run ci:local, and the comment lines under it, joined
  const lines = setUp.split("\n");
  const at = lines.findIndex((l) => l.startsWith("npm run ci:local "));
  expect(at).toBeGreaterThanOrEqual(0);
  const comment = [(lines[at] ?? "").replace(/^[^#]*#\s*/, "")];
  for (const l of lines.slice(at + 1)) {
    if (!/^\s+#/.test(l)) break;
    comment.push(l.replace(/^\s+#\s*/, ""));
  }
  expect(comment.join(" ")).toContain("the pack check");
  expect(comment.join(" ")).toContain("the licence report");
  expect(contributing).toContain("node scripts/release/licences.mjs --write");
  expect(contributing).toContain("node scripts/screenshots.mjs");
});

interface IssueForm {
  body: Array<{
    id?: string;
    attributes?: { description?: string };
    validations?: { required?: boolean };
  }>;
}
interface IssueConfig {
  blank_issues_enabled?: boolean;
  contact_links?: Array<{ url?: string }>;
}

it("issue and pull request templates ask for a reproduction on the sample", () => {
  const bug = YAML.parse(read(".github/ISSUE_TEMPLATE/bug.yml")) as IssueForm;
  const repro = bug.body.find((b) => b.id === "reproduction");
  if (repro === undefined) {
    throw new Error("bug.yml has no field with the id reproduction");
  }
  expect(repro.validations?.required).toBe(true);
  expect(repro.attributes?.description).toContain("fixtures/observatory");
  const cfg = YAML.parse(
    read(".github/ISSUE_TEMPLATE/config.yml"),
  ) as IssueConfig;
  expect(cfg.blank_issues_enabled).toBe(false);
  expect(cfg.contact_links?.[0]?.url).toBe(
    "https://github.com/d3vn0mi/hakutaku/security/advisories/new",
  );
  expect(read(".github/pull_request_template.md")).toContain(
    "fixtures/observatory",
  );
});

it("the repository holds one bug form and one pull request template", () => {
  expect(listed(".github/ISSUE_TEMPLATE")).toEqual([
    ".github/ISSUE_TEMPLATE/bug.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
  ]);
  // GitHub reads a pull request template from the root, docs/ or .github/, in any case
  expect(
    listed(".").filter((p) =>
      /(?:^|\/)pull_request_template(?:\.md|\/)/i.test(p),
    ),
  ).toEqual([".github/pull_request_template.md"]);
});
