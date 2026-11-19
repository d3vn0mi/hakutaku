import { expect, it } from "vitest";
import { readEntryPoints } from "../../../src/manifests/index.js";
import { input } from "./input.js";

const plugin = (
  file: string,
  manifest: string,
  line: number,
): Record<string, unknown> => ({
  file,
  qualname: null,
  kind: "plugin",
  manifest,
  line,
  name: manifest,
});

it("follows a plugin manifest's pointer", () =>
  expect(
    readEntryPoints(
      input(
        {
          "plugins/aurora/plugin.json":
            '{\n  "id": "aurora",\n  "entry": "./index.ts"\n}',
          "plugins/aurora/index.ts": "",
          "plugins/comet/plugin.json": '{ "entry": "./missing.ts" }',
          "plugins/aurora/extra/plugin.json": '{ "entry": "../index.ts" }',
        },
        {
          profile: {
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
  ).toEqual([
    plugin("plugins/aurora/index.ts", "plugins/aurora/plugin.json", 3),
  ]));

it("unescapes ~1 and ~0, steps into arrays, maps built paths, and takes only a string", () => {
  const manifest = "plugins/comet/manifest.json";
  const at = (pointer: string) => ({
    glob: "plugins/*/manifest.json",
    pointer,
    kind: "plugin" as const,
  });
  expect(
    readEntryPoints(
      input(
        {
          [manifest]: [
            "{", // 1
            '  "sky/entries": [', // 2
            '    "./dist/a.js",', // 3
            '    "./dist/comet.js"', // 4
            "  ],", // 5
            '  "m~n": "./x.ts",', // 6
            '  "list": ["./x.ts"],', // 7
            '  "deep": { "entry": "./x.ts" }', // 8
            "}",
          ].join("\n"),
          "plugins/comet/src/comet.ts": "",
          "plugins/comet/x.ts": "",
        },
        {
          profile: {
            launchManifests: [
              at("/sky~1entries/1"),
              at("/m~0n"),
              at("/list"),
              at("/sky~1entries/01"),
              at("/sky~1entries/2"),
              at("/missing/entry"),
              at("/deep/entry"),
            ],
          },
        },
      ),
    ),
  ).toEqual([
    plugin("plugins/comet/src/comet.ts", manifest, 4),
    plugin("plugins/comet/x.ts", manifest, 6),
    plugin("plugins/comet/x.ts", manifest, 8),
  ]);
});
