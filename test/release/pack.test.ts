// What npm pack ships, read from npm's own list after npm run build: every packed path on an
// allowlist, the files the package cannot work without, the whole viewer bundle, the bin's
// shebang and the fixed fields of package.json; and every packed text file scanned for
// home-directory paths and secrets.
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import YAML from "yaml";
import { scanText } from "../../scripts/release/scan.mjs";
import { defaultEnginesDir } from "../../src/engines/index.js";
import { comparePaths } from "../../src/model/index.js";

const REQUIRED = [
  "package.json",
  "README.md",
  "LICENSE",
  "NOTICE",
  "engines.lock.json",
  "python/hakutaku_grimp_driver.py",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/build.js",
  "dist/build.d.ts",
  "dist/cli/main.js",
  "dist/viewer/manifest.json",
];
const ALLOWED = [
  /^dist\/.+\.js$/,
  /^dist\/.+\.d\.ts$/,
  /^dist\/viewer\/.+$/,
  /^ast-grep\/.+\.ya?ml$/,
  // by its exact path: every export copies the package's ast-grep/ whole, the rules' README too
  /^ast-grep\/README\.md$/,
  /^python\/[^/]+\.py$/,
  /^THIRD_PARTY_LICENSES\/[^/]+\.txt$/,
  /^CHANGELOG\.md$/,
];
const FORBIDDEN = [
  /\.map$/,
  /\.sqlite/,
  /\.scip$/,
  /\.tsbuildinfo$/,
  /(^|\/)\./,
  /^(src|test|fixtures|docs|scripts|\.github)\//,
];

// The folder of the licence texts, which must hold at least one.
const TEXTS = "THIRD_PARTY_LICENSES/";
const NO_TEXTS = `missing from the package: ${TEXTS}*.txt`;

// What is wrong with a list of packed paths, in path order: each path that is forbidden, or that
// is neither required nor allowed; each required path that is absent; and no licence text.
function checkPackList(paths: readonly string[]): string[] {
  const problems: Array<[path: string, problem: string]> = [];
  for (const path of paths) {
    const allowed =
      REQUIRED.includes(path) || ALLOWED.some((rule) => rule.test(path));
    if (!allowed || FORBIDDEN.some((rule) => rule.test(path))) {
      problems.push([path, `not allowed in the package: ${path}`]);
    }
  }
  for (const path of REQUIRED) {
    if (!paths.includes(path)) {
      problems.push([path, `missing from the package: ${path}`]);
    }
  }
  if (!paths.some((path) => path.startsWith(TEXTS))) {
    problems.push([`${TEXTS}*.txt`, NO_TEXTS]);
  }
  return problems
    .sort((a, b) => comparePaths(a[0], b[0]) || comparePaths(a[1], b[1]))
    .map(([, problem]) => problem);
}

// The paths npm pack would put in the package, from its dry run; read once, since each run walks
// the whole of dist/.
let packed: readonly string[] | undefined;
function packedPaths(): readonly string[] {
  if (packed === undefined) {
    const stdout = execFileSync(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const [pack] = JSON.parse(stdout) as Array<{
      files: Array<{ path: string }>;
    }>;
    packed = (pack?.files ?? []).map((f) => f.path);
  }
  return packed;
}

// Every file under a directory, as paths from the repository's root, in path order.
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `${entry.parentPath}/${entry.name}`)
    .sort(comparePaths);
}

// Whether git lists a licence text: tracked, or untracked and not ignored, as the tree checks list
// the repository's files.
function licenceTextsListed(): boolean {
  const out = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      TEXTS,
    ],
    { encoding: "utf8" },
  );
  return out.split("\0").some((path) => path.endsWith(".txt"));
}

const OK = [
  ...REQUIRED,
  "THIRD_PARTY_LICENSES/sigma.txt",
  "ast-grep/rules/outline.yml",
];

it("checkPackList accepts the required files", () => {
  expect(checkPackList(OK)).toEqual([]);
});

it("checkPackList refuses stores, maps, dotfiles, sources and tests", () => {
  expect(
    checkPackList([
      ...OK,
      "dist/store.sqlite",
      "dist/index.js.map",
      "dist/.DS_Store",
      "src/index.ts",
      "test/unit/x.test.ts",
    ]),
  ).toEqual([
    "not allowed in the package: dist/.DS_Store",
    "not allowed in the package: dist/index.js.map",
    "not allowed in the package: dist/store.sqlite",
    "not allowed in the package: src/index.ts",
    "not allowed in the package: test/unit/x.test.ts",
  ]);
});

it("checkPackList names a missing file and an empty licence folder", () => {
  expect(checkPackList(REQUIRED.filter((p) => p !== "NOTICE"))).toEqual([
    "missing from the package: NOTICE",
    NO_TEXTS,
  ]);
});

it("scanText finds a home path and a planted private key", () => {
  // built at run time: a literal home path in hakutaku's tree would trip check:tree
  const home = `/${"home"}/alice`;
  expect(scanText("a.js", `const p = '${home}/x';`)).toEqual([
    { file: "a.js", line: 1, kind: "home-path", detail: home },
  ]);
  // a macOS home, as a build on a Mac would embed it
  const mac = `/${"Users"}/alice`;
  expect(scanText("m.js", `x\n//# file://${mac}/src/a.ts`)).toEqual([
    { file: "m.js", line: 2, kind: "home-path", detail: mac },
  ]);
  // assembled from parts, so that no literal key sits in hakutaku's tree
  const key = [
    "-----BEGIN ",
    "RSA PRIVATE KEY-----\n",
    "MIIB".padEnd(64, "A"),
    "\n-----END ",
    "RSA PRIVATE KEY-----",
  ].join("");
  const found = scanText("b.js", `x\n${key}\n`);
  expect(found[0]).toMatchObject({ file: "b.js", line: 2, kind: "secret" });
  expect(found.every((f) => f.kind === "secret")).toBe(true);
});

it("scanText counts only the placeholders redaction adds, each on its own line", () => {
  // a redacted text, such as an exported page's sources, holds placeholders already
  const held = "«redacted:assigned-secret»";
  const value = ["Zx8Qw2Lp", "9Vr4Tn7Ks3Hm"].join("");
  const text = [`a = '${held}'`, "", `token = '${value}'; b = '${held}'`];
  expect(scanText("c.js", text.join("\n"))).toEqual([
    { file: "c.js", line: 3, kind: "secret", detail: "assigned-secret" },
  ]);
});

it("scan.mjs prints each finding, then a clean line and exit 0 or a count and exit 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-scan-"));
  try {
    const planted = join(dir, "a.js");
    writeFileSync(planted, `x\nconst p = '/${"home"}/alice/x';\n`);
    const scan = (...files: string[]) =>
      spawnSync(process.execPath, ["scripts/release/scan.mjs", ...files], {
        encoding: "utf8",
      });
    const clean = scan("package.json", "LICENSE");
    expect([clean.status, clean.stdout]).toEqual([
      0,
      "scan: clean (2 files)\n",
    ]);
    const found = scan("package.json", planted);
    expect([found.status, found.stdout]).toEqual([
      1,
      `${planted}:2: home-path: /${"home"}/alice\nscan: 1 findings\n`,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("the packed file list matches the allowlist", () => {
  // Until git lists a licence text, the package cannot carry one: that one problem waits for the
  // texts, and every other rule holds already.
  const waiting = licenceTextsListed() ? [] : [NO_TEXTS];
  expect(
    checkPackList(packedPaths()).filter((p) => !waiting.includes(p)),
  ).toEqual([]);
});

it("the viewer bundle ships whole", () => {
  const packedSet = new Set(packedPaths());
  const bundle = walk("dist/viewer");
  expect(bundle).toContain("dist/viewer/manifest.json");
  expect(bundle.filter((p) => !packedSet.has(p))).toEqual([]);
});

it("the bin starts with a node shebang", () => {
  expect(readFileSync("dist/cli/main.js", "utf8").split("\n")[0]).toBe(
    "#!/usr/bin/env node",
  );
});

it("no packed file carries a home path or a secret", () => {
  // text files only: a file holding a NUL byte is skipped; "secret" findings in EXEMPT_FILES are dropped
  const texts = packedPaths().filter((p) => !readFileSync(p).includes(0));
  expect(texts).toEqual(
    expect.arrayContaining([
      "dist/cli/main.js",
      "dist/index.d.ts",
      "dist/viewer/page.html",
    ]),
  );
  expect(texts.flatMap((p) => scanText(p, readFileSync(p, "utf8")))).toEqual(
    [],
  );
});

it("package.json keeps its fixed fields: name, licence, author, type, bin, files, engines and os", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  expect(pkg.name).toBe("hakutaku");
  expect([pkg.license, pkg.author, pkg.type]).toEqual([
    "MIT",
    "d3vn0mi",
    "module",
  ]);
  expect(pkg.bin).toEqual({ hakutaku: "dist/cli/main.js" });
  expect(pkg.files).toEqual([
    "dist",
    "python",
    "ast-grep",
    "engines.lock.json",
    "NOTICE",
    "THIRD_PARTY_LICENSES",
  ]);
  expect(pkg.engines).toEqual({ node: ">=22.16" });
  expect(pkg.os).toEqual(["linux", "darwin"]);
  expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
});

// The package as a user installs it: packed, installed into an empty project under the system
// temporary directory, and run from there with no src/, no fixtures/ and no devDependencies, on
// the engines installed already. It maps the sample at quick detail and answers one question.
it("the packed package maps the sample and answers from outside the repo", () => {
  const r = spawnSync(
    process.execPath,
    [
      "scripts/release/smoke.mjs",
      "--from-pack",
      "--engines-dir",
      defaultEnginesDir(),
    ],
    { encoding: "utf8", timeout: 900_000 },
  );
  expect(r.status, r.stdout + r.stderr).toBe(0);
  // the command that mapped and answered is the bin npm installed into the empty project
  expect(r.stdout).toMatch(
    /^smoke: hakutaku is \/.+\/hakutaku-smoke-[^/]+\/app\/node_modules\/\.bin\/hakutaku$/m,
  );
  expect(r.stdout.trimEnd().split("\n").at(-1)).toMatch(
    /^smoke: ok \(from-pack, quick, \d+ ms\)$/,
  );
}, 900_000);

// macOS runs the same smoke from the package, after the job's build and its --version check.
it("the macOS job runs the smoke from the packed package after its build", () => {
  const ci = YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
    jobs: Record<string, { steps: Array<{ run?: string }> }>;
  };
  const runs = (ci.jobs["macos-smoke"]?.steps ?? []).map((s) => s.run);
  expect(runs).toContain("node scripts/release/smoke.mjs --from-pack");
  const at = runs.indexOf("node scripts/release/smoke.mjs --from-pack");
  expect(runs.indexOf("npm run build")).toBeGreaterThanOrEqual(0);
  expect(runs.indexOf("npm run build")).toBeLessThan(at);
  expect(
    runs.indexOf("node dist/cli/main.js --version"),
  ).toBeGreaterThanOrEqual(0);
  expect(runs.indexOf("node dist/cli/main.js --version")).toBeLessThan(at);
});
