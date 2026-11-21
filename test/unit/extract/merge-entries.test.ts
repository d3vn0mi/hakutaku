// The entry_points table: the launch manifests' facts as rows, each naming its file, its
// manifest and line, and a console script's definition; files.entry for every kind but
// dev-script; names redacted, then cut to 240 characters.
import { expect, it } from "vitest";
import { mergeDefinitions } from "../../../src/extract/merge/definitions.js";
import { mergeEntries } from "../../../src/extract/merge/entries.js";
import { fileRows } from "../../../src/extract/merge/files.js";
import { astGrep, mergeInput, outlineDef, P, SIM } from "./merge-input.js";

const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const high = (n: number) =>
  Array.from({ length: n }, (_, i) => ALPHA[(i * 37 + 11) % ALPHA.length]).join(
    "",
  );
const join = (...parts: string[]) => parts.join("");

it("sets files.entry for every entry kind except dev-script", () => {
  const CLI = "sim/src/observatory/cli.py";
  const input = mergeInput(
    {
      "scripts/sync.sh": "#!/bin/sh\necho sync\n",
      "sim/pyproject.toml":
        '[project.scripts]\nephemeris = "observatory.cli:main"\n',
      "sim/src/observatory/__init__.py": "",
      [CLI]: "def main():\n    pass\n",
      "web/package.json":
        '{\n  "name": "web",\n  "bin": { "sky": "./dist/cli/export-sky.js" },\n  "scripts": {\n    "start": "node scripts/serve.mjs",\n    "lint": "node scripts/lint.mjs"\n  }\n}\n',
      "web/scripts/lint.mjs": "console.log('lint');\n",
      "web/scripts/serve.mjs": "console.log('serve');\n",
      "web/src/cli/export-sky.ts": "export function main() {}\n",
    },
    {
      modes: { "scripts/sync.sh": "100755" },
      profile: SIM,
      facts: {
        astGrep: astGrep({
          defs: [
            outlineDef(
              CLI,
              "main",
              "function",
              P(1, 1),
              P(2, 9),
              [P(1, 5)],
              "def main():",
            ),
          ],
        }),
      },
    },
  );
  const files = fileRows(input);
  const defs = mergeDefinitions(input, files);
  // the definitions: one module row per code file, and main (id 4) after cli.py's
  const { entryPoints, redactions } = mergeEntries(input, files, defs);
  expect(entryPoints).toEqual([
    {
      file_id: 1,
      def_id: null,
      kind: "executable",
      manifest_file_id: 1,
      manifest_line: 1,
      name: "scripts/sync.sh",
    },
    {
      file_id: 4,
      def_id: 4,
      kind: "console-script",
      manifest_file_id: 2,
      manifest_line: 2,
      name: "ephemeris",
    },
    {
      file_id: 6,
      def_id: null,
      kind: "dev-script",
      manifest_file_id: 5,
      manifest_line: 6,
      name: "lint",
    },
    {
      file_id: 7,
      def_id: null,
      kind: "script",
      manifest_file_id: 5,
      manifest_line: 5,
      name: "start",
    },
    {
      // ./dist/cli/export-sky.js maps back to its source
      file_id: 8,
      def_id: null,
      kind: "bin",
      manifest_file_id: 5,
      manifest_line: 3,
      name: "sky",
    },
  ]);
  expect(redactions).toBe(0);
  // lint.mjs is launched by a dev script only
  expect(files.map((f) => [f.path, f.entry])).toEqual([
    ["scripts/sync.sh", 1],
    ["sim/pyproject.toml", 0],
    ["sim/src/observatory/__init__.py", 0],
    [CLI, 1],
    ["web/package.json", 0],
    ["web/scripts/lint.mjs", 0],
    ["web/scripts/serve.mjs", 1],
    ["web/src/cli/export-sky.ts", 1],
  ]);
});

it("names a console script's definition by its qualname, and redacts entry names before cutting them to 240 characters", () => {
  const APP = "sim/src/observatory/app.py";
  const github = join("gh", "p_", high(36));
  const input = mergeInput(
    {
      ".github/workflows/sky.yml": `jobs:\n  check:\n    steps:\n      - run: node scripts/check.mjs --token ${github} ${"x".repeat(250)}\n`,
      "scripts/check.mjs": "console.log('check');\n",
      "sim/pyproject.toml":
        '[project.scripts]\nsky = "observatory.app:App.run"\nlost = "observatory.app:missing"\n',
      "sim/src/observatory/__init__.py": "",
      [APP]: "class App:\n    def run(self):\n        pass\n",
    },
    {
      profile: SIM,
      facts: {
        astGrep: astGrep({
          defs: [
            outlineDef(
              APP,
              "App",
              "class",
              P(1, 1),
              P(3, 13),
              [P(1, 7)],
              "class App:",
            ),
            outlineDef(
              APP,
              "App.run",
              "method",
              P(2, 5),
              P(3, 13),
              [P(2, 9)],
              "def run(self):",
            ),
          ],
        }),
      },
    },
  );
  const files = fileRows(input);
  const defs = mergeDefinitions(input, files);
  // the definitions: check.mjs's module row (1), __init__.py's (2), app.py's (3), App (4),
  // App.run (5)
  const { entryPoints, redactions } = mergeEntries(input, files, defs);
  expect(entryPoints).toEqual([
    {
      file_id: 2,
      def_id: null,
      kind: "ci",
      manifest_file_id: 1,
      manifest_line: 4,
      name: `node scripts/check.mjs --token «redacted:github-token» ${"x".repeat(185)}`,
    },
    {
      file_id: 5,
      def_id: 5,
      kind: "console-script",
      manifest_file_id: 3,
      manifest_line: 2,
      name: "sky",
    },
    {
      // no definition of that name: no def_id
      file_id: 5,
      def_id: null,
      kind: "console-script",
      manifest_file_id: 3,
      manifest_line: 3,
      name: "lost",
    },
  ]);
  expect(redactions).toBe(1);
});
