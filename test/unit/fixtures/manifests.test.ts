// The fixtures as GitHub reads hakutaku's tree. Its dependency graph takes any file under a
// manifest's name for one of hakutaku's own dependency manifests, wherever it lies, and would
// report the observatory sample's deliberately old pins as hakutaku's. So no file under
// fixtures/ carries such a name: tree/ holds the sample's manifests with the suffix ".fixture",
// and make.mjs writes each back under its real name.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { git } from "../../helpers/git.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MAKE = join(ROOT, "fixtures", "observatory", "make.mjs");
const TREE = "fixtures/observatory/tree/";
const SUFFIX = ".fixture";
const MAKE_TIMEOUT = 120_000;

// The names GitHub's dependency graph reads as a manifest or a lock file, in any directory.
const MANIFEST_NAMES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "Pipfile",
  "Pipfile.lock",
  "poetry.lock",
  "uv.lock",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "Gemfile",
  "Gemfile.lock",
  "composer.json",
  "composer.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "packages.config",
  "pubspec.yaml",
  "mix.exs",
  "Package.swift",
]);
// requirements*.txt and *.csproj
const MANIFEST_PATTERNS = [/^requirements.*\.txt$/, /\.csproj$/];

const isManifest = (name: string): boolean =>
  MANIFEST_NAMES.has(name) || MANIFEST_PATTERNS.some((re) => re.test(name));

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The files git tracks under fixtures/, as paths from hakutaku's root.
function trackedFixtures(): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--", "fixtures"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter((p) => p !== "");
}

// The blob id git gives these bytes.
const blobId = (bytes: Uint8Array): string =>
  createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");

it("holds no file under fixtures/ that GitHub's dependency graph reads as a manifest", () => {
  const found = trackedFixtures().filter((p) => isManifest(posix.basename(p)));
  expect(found).toEqual([]);
});

it(
  "holds a .fixture file under tree/ only where make.mjs writes it back under its real name",
  () => {
    const out = mkdtempSync(join(tmpdir(), "hakutaku-sample-"));
    made.push(out);
    execFileSync(process.execPath, [MAKE, out], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const repo = join(out, "observatory");
    // the blob of each of HEAD's files, by path
    const head = new Map<string, string>();
    for (const entry of git(repo, "ls-tree", "-r", "-z", "main").split("\0")) {
      if (entry === "") continue;
      const [info = "", path = ""] = entry.split("\t");
      head.set(path, info.split(" ")[2] ?? "");
    }
    // each suffixed file's bytes, in HEAD under its name without the suffix
    const notWrittenBack = trackedFixtures()
      .filter((p) => p.startsWith(TREE) && p.endsWith(SUFFIX))
      .filter(
        (p) =>
          head.get(p.slice(TREE.length, -SUFFIX.length)) !==
          blobId(readFileSync(join(ROOT, p))),
      );
    expect(notWrittenBack).toEqual([]);
    expect([...head.keys()].filter((p) => p.endsWith(SUFFIX))).toEqual([]);
  },
  MAKE_TIMEOUT,
);
