// The checks a release runs before it publishes: the tag against package.json's version,
// CHANGELOG.md's notes for that version and every version README.md pins, then the Node and npm
// that trusted publishing needs. Then check-release.mjs itself, run in a scratch directory that
// holds the three files it reads.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import {
  checkRelease,
  notesFor,
  versionAtLeast,
} from "../../../scripts/release/check-release.mjs";

const changelog =
  "# Changelog\n\n## 0.1.0\n\nFirst public release.\n\n- One.\n";
const readme = "```\nnpx hakutaku@0.1.0 map ~/code/observatory\n```\n";
const ok = { tag: "v0.1.0", version: "0.1.0", changelog, readme };

it("a matching tag passes", () => expect(checkRelease(ok)).toEqual([]));

it("a tag that does not match package.json is refused", () =>
  expect(checkRelease({ ...ok, tag: "v0.1.1" })).toEqual([
    "tag v0.1.1 does not match package.json version 0.1.0",
  ]));

it("a tag that is not v<major>.<minor>.<patch> is refused", () =>
  expect(checkRelease({ ...ok, tag: "release-1" })).toEqual([
    "tag release-1 is not v<major>.<minor>.<patch>",
  ]));

it("a release without notes is refused", () =>
  expect(
    checkRelease({
      ...ok,
      changelog: "# Changelog\n\n## 0.1.0\n\n## 0.0.9\n\n- Old.\n",
    }),
  ).toEqual(["CHANGELOG.md has no notes under ## 0.1.0"]));

it("a README pinned to another version is refused", () =>
  expect(
    checkRelease({
      ...ok,
      readme: `${readme}npx hakutaku@0.0.9 view observatory\n`,
    }),
  ).toEqual(["README.md pins hakutaku@0.0.9, not 0.1.0"]));

it("notesFor returns the section without its heading", () =>
  expect(notesFor(changelog, "0.1.0")).toBe(
    "First public release.\n\n- One.\n",
  ));

it("versionAtLeast compares numbers, not strings", () => {
  expect(versionAtLeast("22.14.0", "22.14.0")).toBe(true);
  expect(versionAtLeast("24.1.0", "22.14.0")).toBe(true);
  expect(versionAtLeast("22.13.1", "22.14.0")).toBe(false);
  expect(versionAtLeast("11.10.0", "11.5.1")).toBe(true);
  expect(versionAtLeast("10.9.2", "11.5.1")).toBe(false);
});

it("checkRelease lists every problem in order: the tag, the notes, then each wrong pin once, as first seen", () => {
  const pins =
    "hakutaku@0.0.9 and hakutaku@0.1.0\n`npm i -g hakutaku@0.0.8`, then hakutaku@0.0.9 again\n";
  expect(
    checkRelease({
      tag: "v0.2.0",
      version: "0.1.0",
      changelog: "# Changelog\n",
      readme: pins,
    }),
  ).toEqual([
    "tag v0.2.0 does not match package.json version 0.1.0",
    "CHANGELOG.md has no notes under ## 0.1.0",
    "README.md pins hakutaku@0.0.9, not 0.1.0",
    "README.md pins hakutaku@0.0.8, not 0.1.0",
  ]);
});

it("a tag with a prerelease, a part missing, no v or anything around it gives that one problem alone", () => {
  const tags = [
    "v0.1.0-rc.1",
    "v0.1",
    "0.1.0",
    "V0.1.0",
    " v0.1.0",
    "v0.1.0\n",
    "refs/tags/v0.1.0",
    "",
  ];
  for (const tag of tags) {
    expect(
      checkRelease({ ...ok, tag, changelog: "", readme: "hakutaku@0.0.9" }),
      JSON.stringify(tag),
    ).toEqual([`tag ${tag} is not v<major>.<minor>.<patch>`]);
  }
});

it("a prerelease is another version, while a dist-tag, another package and the punctuation after a version are no pin", () => {
  const text = [
    "npx hakutaku@0.1.0-rc.1 map ~/code/observatory",
    "npx hakutaku@latest --version",
    "my-hakutaku@0.0.9 and hakutaku-extra@0.0.9 are other packages",
    "Install hakutaku@0.1.0.",
    '"args": ["-y", "hakutaku@0.1.0", "mcp", "observatory"]',
    "(hakutaku@0.1.0), then `hakutaku@0.1.0`; done",
  ].join("\n");
  expect(checkRelease({ ...ok, readme: text })).toEqual([
    "README.md pins hakutaku@0.1.0-rc.1, not 0.1.0",
  ]);
});

it("notesFor keeps a section's subsections, stops at the next level-two heading or the end, and trims blank lines", () => {
  const text = [
    "# Changelog",
    "",
    "## 0.2.0",
    "",
    "- Two.",
    "",
    "## 0.1.0",
    "",
    "",
    "First.",
    "",
    "### Added",
    "",
    "- One.",
    "  ",
    "",
    "## 0.0.9",
    "- Old.",
  ].join("\n");
  expect(notesFor(text, "0.2.0")).toBe("- Two.\n");
  expect(notesFor(text, "0.1.0")).toBe("First.\n\n### Added\n\n- One.\n");
  expect(notesFor(text, "0.0.9")).toBe("- Old.\n");
});

it("notesFor takes only the version's own heading, reads CRLF, and has none for a missing or blank section", () => {
  const others =
    "## [0.1.0] - 2026-12-01\n- A.\n## 0.1.0-rc.1\n- B.\n### 0.1.0\n- C.\n## 0.1.00\n- D.\n";
  expect(notesFor(others, "0.1.0")).toBeNull();
  expect(notesFor("## 0.1.0  \r\n\r\n- One.\r\n- Two.\r\n", "0.1.0")).toBe(
    "- One.\n- Two.\n",
  );
  expect(notesFor("## 0.1.0\n\n \n\t\n## 0.0.9\n- Old.\n", "0.1.0")).toBeNull();
  expect(notesFor("## 0.1.0", "0.1.0")).toBeNull();
  expect(notesFor("", "0.1.0")).toBeNull();
});

it("versionAtLeast reads a leading v and a prerelease's numbers, and nothing that is not major.minor.patch", () => {
  expect(versionAtLeast("v22.14.0", "22.14.0")).toBe(true);
  expect(versionAtLeast("23.0.0", "22.14.0")).toBe(true);
  expect(versionAtLeast("22.15.0", "22.14.9")).toBe(true);
  expect(versionAtLeast("22.14.0", "22.14.1")).toBe(false);
  expect(versionAtLeast("11.6.0-pre.1", "11.5.1")).toBe(true);
  for (const v of ["", "22", "22.14", "x.y.z", "v", "22.14.0a", "22.14.0 "]) {
    expect(versionAtLeast(v, "22.14.0"), JSON.stringify(v)).toBe(false);
  }
  expect(versionAtLeast("22.14.0", "22.14")).toBe(false);
});

const SCRIPT = resolve("scripts/release/check-release.mjs");

// check-release.mjs run in dir, with PATH replaced when one is given.
function runCli(dir: string, args: string[], path?: string) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: path === undefined ? process.env : { ...process.env, PATH: path },
  });
  return {
    status: r.status,
    out: r.stdout.trimEnd().split("\n"),
    err: r.stderr.trimEnd(),
  };
}

// A scratch directory holding the three files check-release.mjs reads.
function releaseDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "hakutaku", version: "0.1.0" })}\n`,
  );
  writeFileSync(join(root, "CHANGELOG.md"), changelog);
  writeFileSync(join(root, "README.md"), readme);
  return root;
}

it("check-release.mjs reads the three files where it runs, writes the notes only when they pass, and exits 0, 1, or 2 on a usage error", () => {
  const root = releaseDir("hakutaku-check-release-");
  try {
    const notes = join(root, "notes.md");
    expect(runCli(root, ["v0.1.0", "--notes", notes])).toMatchObject({
      status: 0,
      out: ["release-check: ok (v0.1.0)"],
    });
    expect(readFileSync(notes, "utf8")).toBe(
      "First public release.\n\n- One.\n",
    );
    expect(runCli(root, ["v0.1.0"])).toMatchObject({
      status: 0,
      out: ["release-check: ok (v0.1.0)"],
    });

    const refused = join(root, "refused.md");
    expect(runCli(root, ["v0.1.1", "--notes", refused])).toMatchObject({
      status: 1,
      out: ["tag v0.1.1 does not match package.json version 0.1.0"],
    });
    expect(existsSync(refused)).toBe(false);

    const usage =
      "usage: node scripts/release/check-release.mjs <tag> [--notes <file>] [--publishing]";
    const misuses = [
      [],
      ["v0.1.0", "--nope"],
      ["v0.1.0", "--notes"],
      ["v0.1.0", "--notes", ""],
      ["v0.1.0", "--notes", "--publishing"],
      ["v0.1.0", "v0.1.1"],
      ["--publishing"],
    ];
    for (const args of misuses) {
      expect(runCli(root, args), args.join(" ")).toEqual({
        status: 2,
        out: [""],
        err: usage,
      });
    }

    rmSync(join(root, "CHANGELOG.md"));
    expect(runCli(root, ["v0.1.0"])).toMatchObject({
      status: 1,
      out: ["release-check: cannot read CHANGELOG.md: ENOENT"],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("check-release.mjs --publishing refuses an npm older than trusted publishing needs, or none, and passes a new enough one", () => {
  const root = releaseDir("hakutaku-check-release-npm-");
  try {
    const bin = join(root, "bin");
    const empty = join(root, "empty");
    mkdirSync(bin);
    mkdirSync(empty);
    const path = `${bin}:${process.env.PATH ?? ""}`;
    // a stand-in npm, first on PATH, that prints only its version
    const npmPrints = (version: string) => {
      writeFileSync(join(bin, "npm"), `#!/bin/sh\necho ${version}\n`);
      chmodSync(join(bin, "npm"), 0o755);
    };
    const needs = `trusted publishing needs Node >= 22.14.0 and npm >= 11.5.1; this runner has ${process.versions.node} and`;

    npmPrints("10.9.2");
    expect(runCli(root, ["v0.1.0", "--publishing"], path)).toMatchObject({
      status: 1,
      out: [`${needs} 10.9.2`],
    });
    npmPrints("11.5.0");
    expect(runCli(root, ["v0.1.1", "--publishing"], path)).toMatchObject({
      status: 1,
      out: [
        "tag v0.1.1 does not match package.json version 0.1.0",
        `${needs} 11.5.0`,
      ],
    });
    expect(runCli(root, ["v0.1.0", "--publishing"], empty)).toMatchObject({
      status: 1,
      out: [`${needs} no working npm`],
    });
    npmPrints("11.5.1");
    const notes = join(root, "notes.md");
    expect(
      runCli(root, ["v0.1.0", "--publishing", "--notes", notes], path),
    ).toMatchObject({ status: 0, out: ["release-check: ok (v0.1.0)"] });
    expect(readFileSync(notes, "utf8")).toBe(
      "First public release.\n\n- One.\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
