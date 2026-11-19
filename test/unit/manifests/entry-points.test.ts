import { expect, it } from "vitest";
import { readEntryPoints } from "../../../src/manifests/index.js";
import { input, SIM } from "./input.js";

it("never makes a test file an entry", () =>
  expect(
    readEntryPoints(
      input(
        {
          "package.json":
            '{ "name": "sky", "bin": { "sky": "src/cli.ts", "sky-check": "test/check.ts" },\n "scripts": { "test": "node --test src/cli.test.ts" } }',
          "src/cli.ts": "",
          "test/check.ts": "",
          "src/cli.test.ts": "",
          "tests/run.sh": "#!/bin/sh\n",
          "sim/tests/test_orbit.py": 'if __name__ == "__main__":\n    pass\n',
          "web/package.json": '{ "dependencies": { "next": "15.0.0" } }',
          "web/pages/stars.test.tsx": "",
        },
        { modes: { "tests/run.sh": "100755" } },
      ),
    ),
  ).toEqual([
    {
      file: "src/cli.ts",
      qualname: null,
      kind: "bin",
      manifest: "package.json",
      line: 1,
      name: "sky",
    },
  ]));

it("sorts by file, kind, manifest, line and name, and keeps one fact per store key", () =>
  expect(
    readEntryPoints(
      input(
        {
          "package.json":
            '{\n "name": "sky",\n "scripts": { "twice": "node x.mjs && node ./x.mjs" },\n "bin": "x.mjs" }',
          // one line, one name, one file: two facts that differ only in qualname
          "sim/pyproject.toml":
            '[project]\nentry-points = { g1 = { sky = "observatory.cli:run" }, g2 = { sky = "observatory.cli:main" } }\n',
          "sim/src/observatory/cli.py": "",
          "x.mjs": "",
        },
        { profile: SIM },
      ),
    ),
  ).toEqual([
    {
      file: "sim/src/observatory/cli.py",
      qualname: "main",
      kind: "console-script",
      manifest: "sim/pyproject.toml",
      line: 2,
      name: "sky",
    },
    {
      file: "x.mjs",
      qualname: null,
      kind: "bin",
      manifest: "package.json",
      line: 4,
      name: "sky",
    },
    {
      file: "x.mjs",
      qualname: null,
      kind: "script",
      manifest: "package.json",
      line: 3,
      name: "twice",
    },
  ]));

it("reads nothing from a manifest it cannot read as its format, and never throws", () =>
  expect(
    readEntryPoints(
      input(
        {
          "package.json": '{ "name": "sky", "bin": ',
          "web/package.json":
            '{ "name": "@obs/web", "bin": 7, "scripts": ["node x.mjs"] }',
          "api/package.json": null,
          "tools/package.json": '"node x.mjs"',
          "lib/package.json": '{ "bin": { "sky": 1 }, "scripts": { "a": 2 } }',
          "web/tsconfig.json": "{ outDir: dist",
          "sim/pyproject.toml":
            '[project.scripts\nephemeris = "observatory.ephemeris.cli:main"\n',
          "tools/pyproject.toml": "[project.scripts]\nephemeris = 7\n",
          "sim/setup.cfg":
            "[options.entry_points]\nconsole_scripts = ephemeris\n",
          "plugins/aurora/plugin.json": "{ entry: './index.ts' }",
          "plugins/comet/plugin.json": '{ "entry": ["./index.ts"] }',
          "deploy/sky.service": "[Service]\nExecStart=\nExecStart=-\n",
          "deploy/sky.timer": "[Timer]\nUnit=../sky.service\n",
          Dockerfile: 'CMD ["python", "-m"\nENTRYPOINT []\n',
          Procfile: "web node x.mjs\n",
          ".github/workflows/sky.yml": "jobs:\n  run:\n  - run: |\n",
          "x.mjs": "",
          "plugins/aurora/index.ts": "",
          "plugins/comet/index.ts": "",
          "sim/src/observatory/ephemeris/cli.py": "",
        },
        {
          profile: {
            ...SIM,
            typescript: { aliases: {}, tsconfigs: ["web/tsconfig.json"] },
            launchManifests: [
              {
                glob: "plugins/*/plugin.json",
                pointer: "/entry",
                kind: "plugin",
              },
            ],
          },
        },
      ),
    ),
  ).toEqual([]));
