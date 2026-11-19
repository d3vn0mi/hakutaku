import { expect, it } from "vitest";
import { readEntryPoints } from "../../../src/manifests/index.js";
import type { EntryKind } from "../../../src/model/index.js";
import { input, SIM } from "./input.js";

it("maps a bin in dist back to its source", () =>
  expect(
    readEntryPoints(
      input({
        "web/package.json":
          '{\n "name": "@obs/web",\n "bin": { "export-sky": "./dist/cli/export-sky.js" }\n}',
        "web/src/cli/export-sky.ts": "",
      }),
    ),
  ).toEqual([
    {
      file: "web/src/cli/export-sky.ts",
      qualname: null,
      kind: "bin",
      manifest: "web/package.json",
      line: 3,
      name: "export-sky",
    },
  ]));

it("reads scripts, and lists test and build scripts as dev-script", () => {
  const manifest = [
    "{", // 1
    '  "name": "observatory",', // 2
    '  "scripts": {', // 3
    '    "stars": "node x.mjs",', // 4
    '    "dev": "tsx src/cli.ts",', // 5
    '    "rebuild": "python -m observatory.tools.rebuild",', // 6
    '    "sync": "bash scripts/sync-sky.sh",', // 7
    '    "test:unit": "node --test scripts/run-tests.mjs",', // 8
    '    "build": "node scripts/build-sky.mjs",', // 9
    '    "lint": "biome check ."', // 10: names no repo file
    "  }",
    "}",
  ].join("\n");
  const fact = (file: string, kind: EntryKind, line: number, name: string) => ({
    file,
    qualname: null,
    kind,
    manifest: "package.json",
    line,
    name,
  });
  expect(
    readEntryPoints(
      input(
        {
          "package.json": manifest,
          "x.mjs": "",
          "src/cli.ts": "",
          "sim/src/observatory/tools/rebuild.py": "",
          "scripts/sync-sky.sh": "",
          "scripts/run-tests.mjs": "",
          "scripts/build-sky.mjs": "",
        },
        { profile: SIM },
      ),
    ),
  ).toEqual([
    fact("scripts/build-sky.mjs", "dev-script", 9, "build"),
    fact("scripts/run-tests.mjs", "dev-script", 8, "test:unit"),
    fact("scripts/sync-sky.sh", "script", 7, "sync"),
    fact("sim/src/observatory/tools/rebuild.py", "script", 6, "rebuild"),
    fact("src/cli.ts", "script", 5, "dev"),
    fact("x.mjs", "script", 4, "stars"),
  ]);
});

it.each<[string, EntryKind]>([
  ["test", "dev-script"],
  ["lint", "dev-script"],
  ["build", "dev-script"],
  ["format", "dev-script"],
  ["fmt", "dev-script"],
  ["typecheck", "dev-script"],
  ["check", "dev-script"],
  ["coverage", "dev-script"],
  ["prepare", "dev-script"],
  ["pretest", "dev-script"],
  ["postbuild", "dev-script"],
  ["preprepare", "dev-script"],
  ["test:unit", "dev-script"],
  ["prelint:fix", "dev-script"],
  ["build:web:prod", "dev-script"],
  ["start", "script"],
  ["dev", "script"],
  ["testing", "script"],
  ["checkout", "script"],
  ["prestart", "script"],
  ["pre", "script"],
  ["web:test", "script"],
  ["postinstall", "script"],
])("lists the script %j as %s", (name, kind) =>
  expect(
    readEntryPoints(
      input({
        "package.json": JSON.stringify({ scripts: { [name]: "node x.mjs" } }),
        "x.mjs": "",
      }),
    ).map((f) => f.kind),
  ).toEqual([kind]),
);

it("names a string bin after its package without the scope, and reads paths from the package's directory", () =>
  expect(
    readEntryPoints(
      input({
        "tools/sky/package.json":
          '{ "name": "@obs/sky",\n  "bin": "./dist/sky.js",\n  "scripts": { "sync": "bash ../../scripts/sync-sky.sh" } }',
        "tools/sky/src/sky.ts": "",
        "package.json": '{ "name": "skyctl", "bin": "bin/skyctl.js" }',
        "bin/skyctl.js": "",
        "scripts/sync-sky.sh": "",
        "tools/nameless/package.json": '{ "bin": "./sky.js" }',
        "tools/nameless/sky.js": "",
      }),
    ),
  ).toEqual([
    {
      file: "bin/skyctl.js",
      qualname: null,
      kind: "bin",
      manifest: "package.json",
      line: 1,
      name: "skyctl",
    },
    {
      file: "scripts/sync-sky.sh",
      qualname: null,
      kind: "script",
      manifest: "tools/sky/package.json",
      line: 3,
      name: "sync",
    },
    {
      file: "tools/sky/src/sky.ts",
      qualname: null,
      kind: "bin",
      manifest: "tools/sky/package.json",
      line: 2,
      name: "sky",
    },
  ]));

it("takes the line of the key whose value counts: the last of a repeated key, past comments and escapes", () =>
  expect(
    readEntryPoints(
      input({
        "package.json": [
          "{", // 1
          '  "scripts": { "sky": "node old.mjs" },', // 2
          '  // a comment holding "scripts": { "sky": ... }', // 3
          '  "bin": { "note": "{ \\"sky\\": 1 }" },', // 4
          '  "scripts": {', // 5
          '    "sk\\u0079": "node x.mjs"', // 6
          "  }",
          "}",
        ].join("\n"),
        "x.mjs": "",
        "old.mjs": "",
      }),
    ),
  ).toEqual([
    {
      file: "x.mjs",
      qualname: null,
      kind: "script",
      manifest: "package.json",
      line: 6,
      name: "sky",
    },
  ]));
