// The checks a release runs before it publishes, and the notes it is published with: the tag
// must be v<major>.<minor>.<patch> and match package.json's version, CHANGELOG.md must hold notes
// under the heading "## <version>", and README.md must pin no other version of hakutaku. It uses
// Node's own modules only, so that it runs before npm ci.
//
//   node scripts/release/check-release.mjs <tag> [--notes <file>] [--publishing]
//
// It reads package.json, CHANGELOG.md and README.md from the working directory. Each problem is
// printed on its own line, then it exits 1. --publishing also requires the Node and npm that
// npm's trusted publishing needs. When nothing is wrong, it writes the version's notes to <file>
// if --notes is given, prints "release-check: ok (<tag>)" and exits 0. A usage error prints the
// usage on stderr and exits 2.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const TAG = /^v(\d+\.\d+\.\d+)$/;

// A version that hakutaku@ pins: major.minor.patch, then any prerelease or build, so that the
// punctuation after it is not taken; a dist-tag such as latest is no pin. A name that only ends
// in hakutaku, such as another package's, is not hakutaku.
const PIN =
  /(?<![\w.-])hakutaku@(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)/g;

// A version as Node and npm print theirs: major.minor.patch, after an optional v, with anything
// after a - or a + read as a prerelease or build and left out of the comparison.
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.+-]*)?$/;

// What npm's trusted publishing needs.
const NODE_MIN = "22.14.0";
const NPM_MIN = "11.5.1";

const USAGE =
  "usage: node scripts/release/check-release.mjs <tag> [--notes <file>] [--publishing]";

export function checkRelease({ tag, version, changelog, readme }) {
  const m = TAG.exec(tag);
  if (m === null) return [`tag ${tag} is not v<major>.<minor>.<patch>`];
  const problems = [];
  if (m[1] !== version) {
    problems.push(`tag ${tag} does not match package.json version ${version}`);
  }
  if (notesFor(changelog, version) === null) {
    problems.push(`CHANGELOG.md has no notes under ## ${version}`);
  }
  const wrong = new Set();
  for (const pin of readme.matchAll(PIN)) {
    if (pin[1] !== version) wrong.add(pin[1]);
  }
  for (const v of wrong) {
    problems.push(`README.md pins hakutaku@${v}, not ${version}`);
  }
  return problems;
}

// The lines after the heading "## <version>", up to the next line that starts "## " or the end,
// with the blank lines at either end trimmed and one final newline; null when there is no such
// heading or its section is blank. A heading must name the version alone.
export function notesFor(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trimEnd() === `## ${version}`);
  if (start === -1) return null;
  const next = lines.findIndex(
    (line, i) => i > start && line.startsWith("## "),
  );
  const section = lines.slice(start + 1, next === -1 ? lines.length : next);
  while (section.length > 0 && section[0].trim() === "") section.shift();
  while (section.length > 0 && section[section.length - 1].trim() === "") {
    section.pop();
  }
  return section.length === 0 ? null : `${section.join("\n")}\n`;
}

// Whether version is min or later, comparing major, minor and patch as numbers; false when
// either is not a version.
export function versionAtLeast(version, min) {
  const a = VERSION.exec(version);
  const b = VERSION.exec(min);
  if (a === null || b === null) return false;
  for (let i = 1; i <= 3; i++) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    if (x !== y) return x > y;
  }
  return true;
}

// The version npm --version prints, or null when npm does not run or prints nothing.
function npmVersion() {
  try {
    const out = execFileSync("npm", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 60_000,
    }).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

// Why this runner cannot publish through trusted publishing, or null when it can.
function publishingProblem() {
  const node = process.versions.node;
  const npm = npmVersion();
  if (
    versionAtLeast(node, NODE_MIN) &&
    npm !== null &&
    versionAtLeast(npm, NPM_MIN)
  ) {
    return null;
  }
  return `trusted publishing needs Node >= ${NODE_MIN} and npm >= ${NPM_MIN}; this runner has ${node} and ${npm ?? "no working npm"}`;
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        notes: { type: "string" },
        publishing: { type: "boolean" },
      },
    });
  } catch {
    parsed = undefined;
  }
  if (
    parsed === undefined ||
    parsed.positionals.length !== 1 ||
    parsed.values.notes === ""
  ) {
    console.error(USAGE);
    return 2;
  }
  const [tag] = parsed.positionals;
  const { notes, publishing } = parsed.values;

  const text = {};
  for (const file of ["package.json", "CHANGELOG.md", "README.md"]) {
    try {
      text[file] = readFileSync(file, "utf8");
    } catch (error) {
      console.log(
        `release-check: cannot read ${file}: ${error.code ?? error.message}`,
      );
      return 1;
    }
  }
  let version;
  try {
    version = String(JSON.parse(text["package.json"]).version);
  } catch (error) {
    console.log(`release-check: cannot read package.json: ${error.message}`);
    return 1;
  }
  const changelog = text["CHANGELOG.md"];
  const problems = checkRelease({
    tag,
    version,
    changelog,
    readme: text["README.md"],
  });
  if (publishing === true) {
    const problem = publishingProblem();
    if (problem !== null) problems.push(problem);
  }
  if (problems.length > 0) {
    for (const problem of problems) console.log(problem);
    return 1;
  }
  if (notes !== undefined) writeFileSync(notes, notesFor(changelog, version));
  console.log(`release-check: ok (${tag})`);
  return 0;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main(process.argv.slice(2));
}
