// The public docs: the screenshots of the sample in docs/img/ and the docs that show them, the
// sections of the design and of the security model, and the ID and link-token pairs that the
// design's tables quote, each checked against the codec.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { SCREENSHOTS } from "../../../scripts/screenshots.mjs";
import { fromToken, parseId, toToken } from "../../../src/model/index.js";

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

// The repository paths of the images a Markdown file shows, ![...](target), each target resolved
// from the file's folder.
function shownImages(p: string): string[] {
  return [...read(p).matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) =>
    normalize(join(dirname(p), m[1] ?? "")),
  );
}

// The ID and token pairs of a file's tables: each row whose first two cells are code spans, the
// first of which parses as an ID.
function tokenPairs(p: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const line of read(p).split("\n")) {
    const m = /^\|\s*`([^`]+)`\s*\|\s*`([^`]*)`\s*\|/.exec(line);
    const id = m?.[1];
    const token = m?.[2];
    if (id !== undefined && token !== undefined && parseId(id) !== null) {
      pairs.push([id, token]);
    }
  }
  return pairs;
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
  for (const [id, token] of pairs) {
    const ref = parseId(id);
    if (ref === null) throw new Error(`not an ID: ${id}`);
    expect(toToken(ref), id).toBe(token);
    expect(fromToken(ref.repo, token), token).toEqual(ref);
  }
});
