// The licence report, and the attribution checked against the tree. The shipped tree is the
// package's production dependencies, read from the lockfile, and every package the viewer
// bundles, read from esbuild's record of the last build; each one must be under a licence on the
// allowlist. The report lists every shipped package. NOTICE must credit every project hakutaku
// uses, each copyright line copied from that project's licence text, and THIRD_PARTY_LICENSES/
// must hold the full licence text of everything the package bundles.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import YAML from "yaml";
import {
  ALLOWED_LICENCES,
  bundledLocations,
  COPYRIGHT_LINE,
  generateTexts,
  licenceAllowed,
  licenceFiles,
  licenceProblems,
  NOT_STATED,
  NOTICE_PARTS,
  type NoticeEntry,
  normaliseLicence,
  type PackageLock,
  parseNotice,
  shippedPackages,
  textFileFor,
} from "../../scripts/release/licences.mjs";
import { defaultEnginesDir, readLock } from "../../src/engines/index.js";
import { requireInCI } from "../helpers/live.js";
import { scipPythonProbe } from "../helpers/sample.js";

// Only an engine install with --deep holds scip-python, whose licence text the deep engines'
// test reads.
const SCIP_PYTHON = scipPythonProbe();

// What the viewer's build bundled, as esbuild's metafile names its inputs; npm run build writes it.
const META = ".cache/viewer-meta.json";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readMeta(): { inputs: Record<string, unknown> } {
  if (!existsSync(META)) throw new Error(`no ${META}: run npm run build first`);
  return readJson(META);
}

it("licenceAllowed follows the licence allowlist", () => {
  expect([...ALLOWED_LICENCES].sort()).toEqual([
    "0BSD",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "BlueOak-1.0.0",
    "CC0-1.0",
    "ISC",
    "MIT",
    "OFL-1.1",
    "Python-2.0",
    "Unlicense",
  ]);
  for (const id of [
    "MIT",
    "ISC",
    "0BSD",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "Apache-2.0",
    "OFL-1.1",
    "Unlicense",
    "CC0-1.0",
    "Python-2.0",
    "BlueOak-1.0.0",
    "(MIT OR CC0-1.0)",
    "MIT AND ISC",
    "MIT OR GPL-3.0-only",
  ]) {
    expect(licenceAllowed(id), id).toBe(true);
  }
  for (const id of [
    "MIT AND GPL-3.0-only",
    "MPL-2.0",
    "PSF-2.0",
    "CC-BY-4.0",
    "Apache-2.0+",
    "GPL-2.0-only WITH Classpath-exception-2.0",
    "UNLICENSED",
    "SEE LICENSE IN LICENSE",
    "",
  ]) {
    expect(licenceAllowed(id), id).toBe(false);
  }
});

it("licenceAllowed binds AND tighter than OR, and refuses an exception and anything malformed", () => {
  // these read MIT OR (GPL-3.0-only AND GPL-3.0-only) and (GPL-3.0-only AND MPL-2.0) OR ISC
  expect(licenceAllowed("MIT OR GPL-3.0-only AND GPL-3.0-only")).toBe(true);
  expect(licenceAllowed("GPL-3.0-only AND MPL-2.0 OR ISC")).toBe(true);
  expect(licenceAllowed("((MIT))")).toBe(true);
  for (const id of [
    "(MIT OR ISC) AND GPL-3.0-only",
    // an exception on an allowed id is still an exception
    "Apache-2.0 WITH LLVM-exception",
    "MIT OR",
    "AND MIT",
    "MIT ISC",
    "(MIT",
    "MIT)",
    "()",
    "MIT WITH",
    // the operators are upper case
    "MIT or ISC",
  ]) {
    expect(licenceAllowed(id), id).toBe(false);
  }
});

it("normaliseLicence reads the legacy forms", () => {
  expect(normaliseLicence({ license: "MIT" })).toBe("MIT");
  expect(normaliseLicence({ license: { type: "ISC" } })).toBe("ISC");
  expect(
    normaliseLicence({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] }),
  ).toBe("(MIT OR Apache-2.0)");
  expect(normaliseLicence({})).toBeNull();
  expect(normaliseLicence({ licenses: [{ type: "BSD-2-Clause" }] })).toBe(
    "BSD-2-Clause",
  );
  expect(normaliseLicence(null)).toBeNull();
  expect(normaliseLicence({ license: "" })).toBeNull();
  expect(normaliseLicence({ license: 1 })).toBeNull();
  expect(normaliseLicence({ licenses: [] })).toBeNull();
  expect(
    normaliseLicence({ licenses: [{ type: "MIT" }, { url: "LICENSE" }] }),
  ).toBeNull();
});

it("bundledLocations reads esbuild's inputs and adds the font packages", () => {
  expect(
    bundledLocations(
      {
        inputs: {
          "node_modules/sigma/dist/sigma.js": {},
          "node_modules/@scope/lib/index.js": {},
          "node_modules/a/node_modules/b/x.js": {},
          "src/viewer/app/main.ts": {},
        },
      },
      { "@ibm/plex-mono": "1.1.0", vitest: "3.2.4" },
    ),
  ).toEqual([
    "node_modules/@ibm/plex-mono",
    "node_modules/@scope/lib",
    "node_modules/a/node_modules/b",
    "node_modules/sigma",
  ]);
});

it("bundledLocations takes node_modules only as a whole segment, and each package once", () => {
  expect(
    bundledLocations(
      {
        inputs: {
          "node_modules/sigma/dist/sigma.js": {},
          "node_modules/sigma/package.json": {},
          "src/not_node_modules/x/y.js": {},
        },
      },
      {},
    ),
  ).toEqual(["node_modules/sigma"]);
});

it("shippedPackages takes production entries and bundled locations, never dev-only ones", () => {
  const lock = {
    lockfileVersion: 3,
    packages: {
      "": { name: "hakutaku", version: "0.0.0" },
      "node_modules/x": { version: "1.0.0", license: "GPL-3.0-only" },
      "node_modules/d": { version: "2.0.0", license: "MPL-2.0", dev: true },
      "node_modules/v": { version: "3.0.0", license: "MPL-2.0", dev: true },
      "node_modules/u": { version: "4.0.0" },
    },
  };
  expect(
    licenceProblems(shippedPackages(lock, ["node_modules/v"], () => null)),
  ).toEqual([
    "u@4.0.0 (node_modules/u, dependency): UNKNOWN",
    "v@3.0.0 (node_modules/v, bundled): MPL-2.0",
    "x@1.0.0 (node_modules/x, dependency): GPL-3.0-only",
  ]);
});

it("shippedPackages names each package, reads a licence the lock lacks from its manifest, and lists a bundled dependency once", () => {
  const lock: PackageLock = {
    lockfileVersion: 3,
    packages: {
      "": { name: "hakutaku", version: "0.0.0" },
      "node_modules/alias": { name: "real", version: "1.0.0", license: "MIT" },
      "node_modules/b/node_modules/@s/c": { version: "2.0.0" },
      "node_modules/both": { version: "3.0.0", license: "ISC" },
    },
  };
  const read: string[] = [];
  const shipped = shippedPackages(lock, ["node_modules/both"], (location) => {
    read.push(location);
    return { license: { type: "BSD-2-Clause" } };
  });
  expect(shipped).toEqual([
    {
      name: "real",
      version: "1.0.0",
      licence: "MIT",
      location: "node_modules/alias",
      via: "dependency",
    },
    {
      name: "@s/c",
      version: "2.0.0",
      licence: "BSD-2-Clause",
      location: "node_modules/b/node_modules/@s/c",
      via: "dependency",
    },
    {
      name: "both",
      version: "3.0.0",
      licence: "ISC",
      location: "node_modules/both",
      via: "bundled",
    },
  ]);
  // a manifest is read only where the lock names no licence
  expect(read).toEqual(["node_modules/b/node_modules/@s/c"]);
  expect(() => shippedPackages(lock, ["node_modules/gone"])).toThrow(
    "node_modules/gone is bundled, but package-lock.json has no entry for it",
  );
});

it("the shipped tree uses only allowlisted licences", () => {
  const lock = readJson<PackageLock>("package-lock.json");
  const { devDependencies } = readJson<{
    devDependencies: Record<string, string>;
  }>("package.json");
  // a licence the lock does not name is read from <location>/package.json
  const shipped = shippedPackages(
    lock,
    bundledLocations(readMeta(), devDependencies),
  );
  const report = [
    `licence report: ${shipped.length} packages`,
    ...shipped.map(
      (p) => `${p.name}@${p.version}  ${p.licence ?? "UNKNOWN"}  ${p.via}`,
    ),
  ].join("\n");
  console.log(report);
  expect(
    shipped.some(
      (p) => p.name === "@modelcontextprotocol/sdk" && p.via === "dependency",
    ),
  ).toBe(true);
  expect(shipped.some((p) => p.via === "bundled")).toBe(true);
  // the bundled packages are those the viewer's manifest lists, from the same build: so the
  // metafile holds the bundle's inputs, not only the fonts
  const { bundled } = readJson<{
    bundled: Array<{ name: string; version: string }>;
  }>("dist/viewer/manifest.json");
  expect(
    shipped
      .filter((p) => p.via === "bundled")
      .map((p) => `${p.name}@${p.version}`)
      .sort(),
  ).toEqual(bundled.map((b) => `${b.name}@${b.version}`).sort());
  expect(licenceProblems(shipped)).toEqual([]);
});

it("CI's linux job runs the licence report after the pack allowlist, as ci:local does", () => {
  const ci = YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
    jobs: Record<string, { steps: Array<{ name?: string }> }>;
  };
  const steps = (ci.jobs.linux?.steps ?? []).filter(
    (s) => s.name !== undefined,
  );
  const at = steps.findIndex((s) => s.name === "licence report");
  expect(steps[at]).toEqual({
    name: "licence report",
    run: "npm run check:licences",
  });
  expect(steps.slice(at - 1, at + 2).map((s) => s.name)).toEqual([
    "pack allowlist",
    "licence report",
    "secret scan",
  ]);
  const { scripts } = readJson<{ scripts: Record<string, string> }>(
    "package.json",
  );
  expect(scripts["check:licences"]).toBe(
    "vitest run test/release/licences.test.ts",
  );
  expect(scripts["ci:local"]).toContain(
    "npm run check:pack && npm run check:licences && npm run check:secrets",
  );
});

// NOTICE's attribution, checked against the lockfile, the engine lock and the licence texts.

const [BUNDLED, INSTALLED, ENGINES, RUNTIME, DEVELOPMENT] = NOTICE_PARTS;

// NOTICE's first lines, exactly.
const HEADER = [
  "hakutaku",
  "Copyright (c) 2026 d3vn0mi",
  "Licensed under the MIT License. See LICENSE.",
  "",
  "hakutaku uses the projects below. Each entry gives the version hakutaku pins, its licence, and",
  "the copyright line copied from that version's licence file.",
  "",
].join("\n");

// The keys each part requires of its entries.
const REQUIRED_KEYS: Record<string, readonly string[]> = {
  [BUNDLED]: ["Version", "Licence", "Copyright", "Use", "Text"],
  [INSTALLED]: ["Version", "Licence", "Copyright", "Use"],
  [ENGINES]: ["Package", "Version", "Licence", "Copyright", "Use"],
  [RUNTIME]: ["Licence", "Use"],
  [DEVELOPMENT]: ["Version", "Licence", "Copyright", "Use"],
};

// A vendored project's Version: where it was copied from, at which tag or commit.
const VENDORED = /^vendored from https:\/\/\S+ at \S+$/;

const ENGINES_MISSING =
  "engines are not installed: run node dist/cli/main.js engines install --yes";

const readNotice = () => parseNotice(readFileSync("NOTICE", "utf8"));

const names = (notice: { entries: NoticeEntry[] }, part: string): string[] =>
  notice.entries.filter((e) => e.part === part).map((e) => e.name);

// An entry's one value for a key, or undefined where it has none.
const field = (entry: NoticeEntry, key: string): string | undefined =>
  entry.fields[key]?.[0];

const where = (entry: NoticeEntry): string => `${entry.part} / ${entry.name}`;

// "<part> / <name>: no <Key>" for each key that the entry's part requires and the entry lacks.
function missingKeys(entry: NoticeEntry): string[] {
  return (REQUIRED_KEYS[entry.part] ?? [])
    .filter((key) => entry.fields[key] === undefined)
    .map((key) => `${where(entry)}: no ${key}`);
}

// The packages the viewer bundles, as locations, from the last build.
function bundled(): string[] {
  const { devDependencies } = readJson<{
    devDependencies: Record<string, string>;
  }>("package.json");
  return bundledLocations(readMeta(), devDependencies);
}

// The name a lockfile location installs: its entry's name, or the path after its last
// node_modules/.
function lockName(lock: PackageLock, location: string): string {
  const after = location.lastIndexOf("node_modules/") + "node_modules/".length;
  return lock.packages[location]?.name ?? location.slice(after);
}

// Where a lockfile installs a package at a version: the shallowest location that holds it, so
// node_modules/<name> when that one does. Undefined where none does.
function lockLocation(
  lock: PackageLock,
  name: string,
  version: string | undefined,
): string | undefined {
  return Object.keys(lock.packages)
    .filter(
      (location) =>
        location !== "" &&
        lockName(lock, location) === name &&
        lock.packages[location]?.version === version,
    )
    .sort(
      (a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1),
    )[0];
}

// The engines that only an install with --deep holds, as NOTICE's Package values: the engine
// lock's devDependencies.
function deepEngines(): Set<string> {
  const { devDependencies } = readLock().lock.npm.packageJson;
  return new Set(Object.keys(devDependencies).map((name) => `npm:${name}`));
}

// The installed engines directory; it fails the test where the engines are not installed.
function enginesDir(): string {
  const dir = defaultEnginesDir();
  if (!existsSync(join(dir, "installed.json")))
    throw new Error(ENGINES_MISSING);
  return dir;
}

// A licence text, as one section per licence file, its lines ended by line feeds alone.
interface Section {
  file: string; // the licence file's name, or the https URL that a text written by hand names
  text: string;
}

const lineFeeds = (text: string): string => text.replaceAll("\r\n", "\n");

// The licence files of a package's folder, as sections. A folder that does not exist throws,
// so that a wrong location never reads as a package without a licence file.
function sectionsIn(dir: string): Section[] {
  return licenceFiles(dir).map((file) => ({
    file,
    text: lineFeeds(readFileSync(join(dir, file), "utf8")),
  }));
}

// The sections of a THIRD_PARTY_LICENSES text: each "---- <file> ----" line opens one.
function sectionsOf(text: string): Section[] {
  const sections: Section[] = [];
  for (const line of lineFeeds(text).split("\n")) {
    const opened = /^---- (.+) ----$/.exec(line)?.[1];
    const last = sections.at(-1);
    if (opened !== undefined) sections.push({ file: opened, text: "" });
    else if (last !== undefined) last.text += `${line}\n`;
  }
  return sections;
}

// A licence file that gathers the notices of the projects a package bundles, such as axe-core's
// LICENSE-3RD-PARTY.txt: the copyright lines in it are those projects', not the package's own.
const OTHERS_NOTICES = /(?:3rd|third)[-_ ]?party/i;
const ownSection = (s: Section): boolean =>
  !OTHERS_NOTICES.test(s.file.split("/").at(-1) ?? "");

// The licence text that an entry's Copyright is copied from: a Bundled entry's own text in
// THIRD_PARTY_LICENSES/; for an Installed entry or a development tool, the licence files where
// the lockfile installs it at its Version; for an engine, those of its npm package in the engines
// directory, or of its wheel's .dist-info folder with that folder's licenses/. It throws where
// that text is not there.
function licenceSections(
  entry: NoticeEntry,
  lock: PackageLock,
  engines: string,
): Section[] {
  const version = field(entry, "Version");
  if (entry.part === BUNDLED) {
    const text = field(entry, "Text") ?? "(no Text)";
    return sectionsOf(readFileSync(text, "utf8"));
  }
  if (entry.part === ENGINES) {
    const pkg = field(entry, "Package") ?? "";
    if (pkg.startsWith("npm:")) {
      return sectionsIn(join(engines, "npm", "node_modules", pkg.slice(4)));
    }
    if (!pkg.startsWith("pypi:")) {
      throw new Error(`Package is neither npm:<name> nor pypi:<name>: ${pkg}`);
    }
    const info = join(
      engines,
      "python",
      `${pkg.slice(5)}-${version}.dist-info`,
    );
    const licenses = join(info, "licenses");
    return [
      ...sectionsIn(info),
      ...(existsSync(licenses) ? sectionsIn(licenses) : []).map((s) => ({
        ...s,
        file: `licenses/${s.file}`,
      })),
    ];
  }
  const location = lockLocation(lock, entry.name, version);
  if (location === undefined) {
    throw new Error(`package-lock.json installs no ${entry.name}@${version}`);
  }
  return sectionsIn(location);
}

// What is wrong with an entry's Copyright values against its licence text. Each value is a
// copyright line of that text, as written but for the blanks around it; or the entry says
// NOT_STATED alone, and no line of the package's own licence files is a copyright line.
function copyrightProblems(entry: NoticeEntry, sections: Section[]): string[] {
  const values = entry.fields.Copyright ?? [];
  if (values.includes(NOT_STATED)) {
    if (values.length > 1) {
      return [`${where(entry)}: "${NOT_STATED}" beside a copyright line`];
    }
    return sections
      .filter(ownSection)
      .flatMap((s) => s.text.split("\n"))
      .filter((line) => COPYRIGHT_LINE.test(line))
      .map(
        (line) =>
          `${where(entry)}: "${NOT_STATED}", but its licence text holds ${line.trim()}`,
      );
  }
  const lines = new Set(
    sections.flatMap((s) => s.text.split("\n").map((line) => line.trim())),
  );
  return values.flatMap((value) => {
    if (!lines.has(value)) {
      return [`${where(entry)}: not a line of its licence text: ${value}`];
    }
    if (!COPYRIGHT_LINE.test(value)) {
      return [`${where(entry)}: not a copyright line: ${value}`];
    }
    return [];
  });
}

// The copyright problems of some entries, and the entries whose package has no licence file.
function checkCopyrights(entries: NoticeEntry[]): {
  problems: string[];
  withoutFile: string[];
} {
  const engines = enginesDir();
  const lock = readJson<PackageLock>("package-lock.json");
  const problems: string[] = [];
  const withoutFile: string[] = [];
  for (const entry of entries) {
    try {
      const sections = licenceSections(entry, lock, engines);
      if (sections.length === 0) withoutFile.push(where(entry));
      problems.push(...copyrightProblems(entry, sections));
    } catch (error) {
      problems.push(`${where(entry)}: ${(error as Error).message}`);
    }
  }
  return { problems, withoutFile };
}

it("parseNotice reads entries and refuses unknown keys", () => {
  expect(
    parseNotice(
      "x\n\n## Development tools\n\n### vitest\nVersion: 3.2.4\nLicence: MIT\n" +
        "Copyright: Copyright (c) 2021-Present Vitest Team\nUse: tests\n",
    ),
  ).toEqual({
    parts: ["Development tools"],
    entries: [
      {
        part: "Development tools",
        name: "vitest",
        fields: {
          Version: ["3.2.4"],
          Licence: ["MIT"],
          Copyright: ["Copyright (c) 2021-Present Vitest Team"],
          Use: ["tests"],
        },
      },
    ],
  });
  expect(() =>
    parseNotice("## Development tools\n\n### x\nHomepage: y\n"),
  ).toThrow("unknown key Homepage");
});

it("parseNotice keeps every Copyright line, splits at the first colon, and refuses a stray line", () => {
  expect(
    parseNotice(
      "## Bundled in the package\n\n### a\nCopyright: one\nCopyright: two\nUse: x: y\r\n",
    ).entries,
  ).toEqual([
    {
      part: "Bundled in the package",
      name: "a",
      fields: { Copyright: ["one", "two"], Use: ["x: y"] },
    },
  ]);
  expect(() => parseNotice("## p\n\n### a\nVersion: 1\nVersion: 2\n")).toThrow(
    "a: Version given twice",
  );
  expect(() => parseNotice("## p\n\n### a\nUse: \n")).toThrow(
    "a: Use is empty",
  );
  for (const text of [
    "## p\n\n### a\nVersion 1\n",
    "## p\n\nVersion: 1\n",
    "## p\n\n### a\n\nVersion: 1\n",
  ]) {
    expect(() => parseNotice(text), text).toThrow("not a line of an entry");
  }
  expect(() => parseNotice("x\n### a\n## p\n")).toThrow(
    "an entry before the first part: a",
  );
});

it("COPYRIGHT_LINE tells a copyright line from licence prose", () => {
  for (const l of [
    "Copyright (c) 2013-present, Guillaume Plique",
    "Copyright 2021 Sourcegraph, Inc.",
    "Copyright Microsoft Corporation. All rights reserved.",
    "Portions Copyright (c) Microsoft Corporation.",
    "(c) 2015 Deque Systems",
    "© 2006 Ivan Sagalaev",
    "(C) Copyright IBM Corp. 2017",
  ]) {
    expect(COPYRIGHT_LINE.test(l), l).toBe(true);
  }
  for (const l of [
    "   copyright notice, this list of conditions and the following disclaimer.",
    "Copyright [yyyy] [name of copyright owner]",
    "COPYRIGHT HOLDERS AND CONTRIBUTORS",
    "The above copyright notice and this permission notice shall be included",
    // clause 4(c) of the Apache License 2.0, which states no copyright
    "      (c) You must retain, in the Source form of any Derivative Works",
  ]) {
    expect(COPYRIGHT_LINE.test(l), l).toBe(false);
  }
});

it("generateTexts writes each package's licence files under one header, with line feeds alone, and lists a package with none", () => {
  const root = mkdtempSync(join(tmpdir(), "hakutaku-licences-"));
  try {
    const at = (location: string, manifest: object) => {
      mkdirSync(join(root, location), { recursive: true });
      writeFileSync(
        join(root, location, "package.json"),
        JSON.stringify(manifest),
      );
      return join(root, location);
    };
    const a = at("node_modules/@s/a", {
      name: "@s/a",
      version: "1.0.0",
      license: "MIT",
    });
    writeFileSync(join(a, "LICENSE.md"), "MIT\r\nCopyright (c) 2020 A\r\n");
    writeFileSync(join(a, "COPYING"), "and more, with no last line feed");
    writeFileSync(join(a, "README.md"), "not a licence file");
    // a folder is not a licence file, whatever its name
    mkdirSync(join(a, "LICENSE.d"));
    at("node_modules/b", {
      name: "b",
      version: "2.0.0",
      licenses: [{ type: "ISC" }],
    });
    expect(licenceFiles(a)).toEqual(["COPYING", "LICENSE.md"]);
    expect(textFileFor("@s/a")).toBe("THIRD_PARTY_LICENSES/@s__a.txt");
    const { texts, missing } = generateTexts(root, [
      "node_modules/@s/a",
      "node_modules/b",
    ]);
    expect([...texts]).toEqual([
      [
        "THIRD_PARTY_LICENSES/@s__a.txt",
        [
          "@s/a 1.0.0",
          "Licence: MIT",
          "",
          "---- COPYING ----",
          "and more, with no last line feed",
          "",
          "---- LICENSE.md ----",
          "MIT",
          "Copyright (c) 2020 A",
          "",
        ].join("\n"),
      ],
    ]);
    expect(missing).toEqual(["THIRD_PARTY_LICENSES/b.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("licences.mjs runs only as licences.mjs --write", () => {
  const r = spawnSync(process.execPath, ["scripts/release/licences.mjs"], {
    encoding: "utf8",
  });
  expect([r.status, r.stdout, r.stderr]).toEqual([
    2,
    "",
    "usage: node scripts/release/licences.mjs --write\n",
  ]);
});

it("NOTICE has its five parts in order, every required key, and the runtime it names", () => {
  const text = readFileSync("NOTICE", "utf8");
  expect(text.slice(0, HEADER.length)).toBe(HEADER);
  const notice = parseNotice(text);
  expect(notice.parts).toEqual([...NOTICE_PARTS]);
  expect(names(notice, "Runtime, not redistributed")).toEqual([
    "Node.js",
    "SQLite",
    "Python",
    "git",
  ]);
  expect(notice.entries.flatMap(missingKeys)).toEqual([]); // "<part> / <name>: no <Key>"
  // no part names an entry twice
  const seen = notice.entries.map(where);
  expect(seen.filter((w, i) => seen.indexOf(w) !== i)).toEqual([]);
});

it("every bundled package is credited with its licence text, and every bundled entry is bundled", () => {
  // Each bundled location has a "Bundled in the package" entry named after the package, with
  // Version equal to the locked version, Licence equal to its normalised licence, and Text equal
  // to textFileFor(name), a file that exists. Each "Bundled in the package" entry is a bundled
  // package, or has a Version that reads "vendored from https://<...> at <tag or commit>".
  const lock = readJson<PackageLock>("package-lock.json");
  const shipped = shippedPackages(lock, bundled()).filter(
    (p) => p.via === "bundled",
  );
  const entries = readNotice().entries.filter((e) => e.part === BUNDLED);
  const problems: string[] = [];
  for (const p of shipped) {
    const entry = entries.find((e) => e.name === p.name);
    if (entry === undefined) {
      problems.push(`${p.name}: no "${BUNDLED}" entry`);
      continue;
    }
    for (const [key, value] of [
      ["Version", p.version],
      ["Licence", p.licence ?? "UNKNOWN"],
    ]) {
      if (field(entry, key) !== value) {
        problems.push(`${p.name}: ${key} ${field(entry, key)}, not ${value}`);
      }
    }
  }
  for (const entry of entries) {
    const text = field(entry, "Text");
    if (text !== textFileFor(entry.name)) {
      problems.push(
        `${entry.name}: Text ${text}, not ${textFileFor(entry.name)}`,
      );
    }
    if (!existsSync(textFileFor(entry.name))) {
      problems.push(`${entry.name}: no ${textFileFor(entry.name)}`);
    }
    const isBundled = shipped.some((p) => p.name === entry.name);
    if (!isBundled && !VENDORED.test(field(entry, "Version") ?? "")) {
      problems.push(
        `${entry.name}: neither bundled nor vendored from an https URL`,
      );
    }
  }
  expect(shipped.map((p) => p.name)).toContain("sigma");
  expect(problems).toEqual([]);
});

it("every npm dependency is credited at its locked version", () => {
  // each key of package.json "dependencies": an "Installed with the package" entry, Version = the
  // locked version; and each such entry is a dependency
  const lock = readJson<PackageLock>("package-lock.json");
  const { dependencies } = readJson<{ dependencies: Record<string, string> }>(
    "package.json",
  );
  const entries = readNotice().entries.filter((e) => e.part === INSTALLED);
  const problems: string[] = [];
  for (const name of Object.keys(dependencies)) {
    const locked = lock.packages[`node_modules/${name}`]?.version;
    const entry = entries.find((e) => e.name === name);
    if (entry === undefined) problems.push(`${name}: no "${INSTALLED}" entry`);
    else if (field(entry, "Version") !== locked) {
      problems.push(
        `${name}: Version ${field(entry, "Version")}, locked ${locked}`,
      );
    }
  }
  for (const entry of entries) {
    if (!Object.hasOwn(dependencies, entry.name)) {
      problems.push(`${entry.name}: credited, but not a dependency`);
    }
  }
  expect(Object.keys(dependencies)).toContain("@modelcontextprotocol/sdk");
  expect(problems).toEqual([]);
});

it("every engine in engines.lock.json is credited at its pinned version", () => {
  // each key of lock.npm.packageJson's dependencies and devDependencies (the deep engine): an
  // entry in "Run as separate programs" with Package "npm:<key>" and Version equal to its pin;
  // each line "<name>==<version> ..." of lock.pip.requirements: Package "pypi:<name>"; and each
  // entry there is one of those
  const { lock } = readLock();
  const { dependencies, devDependencies } = lock.npm.packageJson;
  const pins = [
    ...Object.entries({ ...dependencies, ...devDependencies }).map(
      ([name, version]) => [`npm:${name}`, version],
    ),
    ...lock.pip.requirements
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const pin = /^([A-Za-z0-9._-]+)==(\S+)/.exec(line);
        if (pin === null) throw new Error(`not a pinned requirement: ${line}`);
        return [`pypi:${pin[1]}`, pin[2]];
      }),
  ];
  const entries = readNotice().entries.filter((e) => e.part === ENGINES);
  const problems: string[] = [];
  for (const [pkg, version] of pins) {
    const entry = entries.find((e) => field(e, "Package") === pkg);
    if (entry === undefined) problems.push(`${pkg}: no "${ENGINES}" entry`);
    else if (field(entry, "Version") !== version) {
      problems.push(
        `${pkg}: Version ${field(entry, "Version")}, pinned ${version}`,
      );
    }
  }
  for (const entry of entries) {
    if (!pins.some(([pkg]) => pkg === field(entry, "Package"))) {
      problems.push(
        `${where(entry)}: Package ${field(entry, "Package")} is not pinned`,
      );
    }
  }
  expect(pins.map(([pkg]) => pkg)).toEqual(
    expect.arrayContaining(["npm:@sourcegraph/scip-python", "pypi:grimp"]),
  );
  expect(problems).toEqual([]);
});

it("every development tool is credited at its pinned version", () => {
  // each devDependency outside bundledLocations(): a "Development tools" entry, Version = its
  // exact pin
  const { devDependencies } = readJson<{
    devDependencies: Record<string, string>;
  }>("package.json");
  const inBundle = new Set(bundled());
  const tools = Object.entries(devDependencies).filter(
    ([name]) => !inBundle.has(`node_modules/${name}`),
  );
  const entries = readNotice().entries.filter((e) => e.part === DEVELOPMENT);
  const problems: string[] = [];
  for (const [name, pin] of tools) {
    const entry = entries.find((e) => e.name === name);
    if (entry === undefined)
      problems.push(`${name}: no "${DEVELOPMENT}" entry`);
    else if (field(entry, "Version") !== pin) {
      problems.push(
        `${name}: Version ${field(entry, "Version")}, pinned ${pin}`,
      );
    }
  }
  expect(tools.map(([name]) => name)).toEqual(
    expect.arrayContaining(["vitest", "yaml"]),
  );
  expect(problems).toEqual([]);
});

it("NOTICE credits each npm package at a version its lock holds, under the licence that lock names", () => {
  // Installed entries and development tools against package-lock.json, and the npm engines
  // against the engine lock's own lockfile
  const lock = readJson<PackageLock>("package-lock.json");
  const engineLock = readLock().lock.npm.packageLock as PackageLock;
  const credited = readNotice().entries.flatMap((entry) => {
    const pkg = field(entry, "Package") ?? "";
    if (entry.part === INSTALLED || entry.part === DEVELOPMENT) {
      return [{ entry, from: lock, name: entry.name }];
    }
    if (entry.part === ENGINES && pkg.startsWith("npm:")) {
      return [{ entry, from: engineLock, name: pkg.slice(4) }];
    }
    return [];
  });
  const problems: string[] = [];
  for (const { entry, from, name } of credited) {
    const version = field(entry, "Version");
    const location = lockLocation(from, name, version);
    const licence =
      location === undefined ? undefined : from.packages[location]?.license;
    if (location === undefined) {
      problems.push(`${where(entry)}: its lock holds no ${name}@${version}`);
    } else if (field(entry, "Licence") !== licence) {
      problems.push(
        `${where(entry)}: Licence ${field(entry, "Licence")}, but its lock says ${licence}`,
      );
    }
  }
  expect(credited.map(({ name }) => name)).toEqual(
    expect.arrayContaining(["axe-core", "@sourcegraph/scip-typescript"]),
  );
  expect(problems).toEqual([]);
});

it("every copyright line is copied from the licence text", () => {
  // The text is the entry's THIRD_PARTY_LICENSES file for Bundled entries, and the package's
  // licence files for Installed entries and development tools. For engines it is the licence
  // files of <defaultEnginesDir()>/npm/node_modules/<package>/, or of the <name>-<version>.dist-info
  // folder under <defaultEnginesDir()>/python/, including its licenses/ folder. When the engines
  // are absent, the test fails with ENGINES_MISSING. The deep engines have a test of their own.
  // Each Copyright value must be a copyright line of that text, or equal NOT_STATED, with no
  // line of the package's own licence files that matches COPYRIGHT_LINE.
  const deep = deepEngines();
  const { problems, withoutFile } = checkCopyrights(
    readNotice().entries.filter(
      (e) => e.part !== RUNTIME && !deep.has(field(e, "Package") ?? ""),
    ),
  );
  expect(problems).toEqual([]);
  // @ast-grep/cli and its platform package ship no licence file, so ast-grep's entry can only
  // say NOT_STATED; any other entry without a licence file needs a look
  expect(withoutFile).toEqual([`${ENGINES} / ast-grep`]);
});

it("the deep engines' copyright lines are copied from their licence texts", (ctx) => {
  requireInCI(ctx, SCIP_PYTHON);
  const deep = deepEngines();
  const entries = readNotice().entries.filter(
    (e) => e.part === ENGINES && deep.has(field(e, "Package") ?? ""),
  );
  expect(entries.map((e) => field(e, "Package"))).toEqual([...deep]);
  const { problems, withoutFile } = checkCopyrights(entries);
  expect(problems).toEqual([]);
  expect(withoutFile).toEqual([]);
});

it("THIRD_PARTY_LICENSES matches the generator, and holds nothing NOTICE does not name", () => {
  const locations = bundled();
  const { texts, missing } = generateTexts(".", locations);
  expect(texts.size + missing.length).toBe(locations.length);
  for (const [file, text] of texts)
    expect(readFileSync(file, "utf8"), file).toBe(text);
  // A text written by hand, for a bundled package that ships no licence file or for a vendored
  // project, exists; its first line is "<name> <Version>", and it holds a "---- https://" line.
  const notice = readNotice();
  const entries = notice.entries.filter((e) => e.part === BUNDLED);
  const problems = missing
    .filter((file) => !entries.some((e) => field(e, "Text") === file))
    .map((file) => `${file}: no "${BUNDLED}" entry names it`);
  for (const entry of entries) {
    const file = field(entry, "Text") ?? "";
    if (
      !missing.includes(file) &&
      !VENDORED.test(field(entry, "Version") ?? "")
    )
      continue;
    const lines = existsSync(file)
      ? readFileSync(file, "utf8").split("\n")
      : [];
    const first = `${entry.name} ${field(entry, "Version")}`;
    if (lines[0] !== first)
      problems.push(`${file}: its first line is not ${first}`);
    if (!lines.some((line) => /^---- https:\/\/\S+ ----$/.test(line))) {
      problems.push(`${file}: no "---- https://<...> ----" line`);
    }
  }
  expect(problems).toEqual([]);
  // listedTexts: `git ls-files --cached --others --exclude-standard -- THIRD_PARTY_LICENSES`, so
  // that new texts count before they are committed
  const listedTexts = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "THIRD_PARTY_LICENSES",
    ],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter((path) => path !== "");
  const namedByNotice = new Set(
    notice.entries.flatMap((e) => e.fields.Text ?? []),
  );
  expect(listedTexts.filter((f) => !namedByNotice.has(f))).toEqual([]);
  expect([...namedByNotice].filter((f) => !listedTexts.includes(f))).toEqual(
    [],
  );
});
