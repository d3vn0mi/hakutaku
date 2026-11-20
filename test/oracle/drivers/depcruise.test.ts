// The dependency-cruiser driver against the installed engine: run `node dist/cli/main.js
// engines install --yes` once before this file. A repo made with makeRepo, exported with
// exportRepo and a rules file, then depcruiseDriver.run over the export.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { defaultEnginesDir } from "../../../src/engines/index.js";
import {
  type ExportManifest,
  exportRepo,
  removeTree,
} from "../../../src/export/index.js";
import type { ExtractContext } from "../../../src/extract/context.js";
import { depcruiseDriver } from "../../../src/extract/drivers/depcruise.js";
import { loadProfile, loadRules } from "../../../src/profile/index.js";
import { makeRepo } from "../../helpers/git.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) removeTree(dir);
});

const lines = (...text: string[]): string => `${text.join("\n")}\n`;

const RENDER = lines(
  'import { body } from "./body";',
  'import type { Orbit } from "../orbits/types";',
  'import { kepler } from "@obs/web/orbits/kepler";',
  'import { fetchSky } from "../api/client";',
  'import { readFileSync } from "node:fs";',
  'import * as React from "react";',
  'import { gone } from "./missing";',
  'const legacy = require("./legacy.cjs");',
  "export async function render(o: Orbit) {",
  '  const lazy = await import("./lazy");',
  "  return [body, kepler, fetchSky, readFileSync, React, gone, legacy, lazy, o];",
  "}",
);

const RULES = {
  schema: 1,
  forbidden: [
    {
      name: "sky-not-from-api",
      severity: "error",
      from: { path: "^web/src/sky/" },
      to: { path: "^web/src/api/" },
    },
  ],
};

// The context a build gives the driver, over a fresh export of repo with the rules above.
async function exportOf(repo: string): Promise<ExtractContext> {
  const root = mkdtempSync(join(tmpdir(), "hakutaku-oracle-depcruise-"));
  made.push(root);
  const rules = join(root, "rules.json");
  writeFileSync(rules, JSON.stringify(RULES));
  const exportDir = join(root, "export");
  await exportRepo({ repo, ref: "HEAD", out: exportDir, rules });
  const manifest = JSON.parse(
    readFileSync(join(exportDir, "export.json"), "utf8"),
  ) as ExportManifest;
  const workDir = join(root, "work");
  mkdirSync(workDir);
  return {
    exportDir,
    snapshotDir: join(exportDir, "snapshot"),
    workDir,
    enginesDir: defaultEnginesDir(),
    detail: "quick",
    noSource: false,
    profile: loadProfile(join(exportDir, "profile.json")),
    rules: loadRules(join(exportDir, "rules.json")),
    manifest,
    pythonPath: null,
    log: () => {},
  };
}

it("lists every TS file, resolves its imports and reports the broken rule", async () => {
  const repo = await makeRepo({
    commits: [
      {
        date: "2026-03-02T10:00:00Z",
        files: {
          // the generated profile takes the alias from the repo's tsconfig
          "tsconfig.json": JSON.stringify({
            compilerOptions: {
              baseUrl: ".",
              paths: { "@obs/web/*": ["web/src/*"] },
            },
          }),
          "web/src/sky/render.ts": RENDER,
          "web/src/sky/body.ts": "export const body = 1;\n",
          "web/src/sky/lazy.ts": "export const lazy = 2;\n",
          "web/src/sky/legacy.cjs": "module.exports = { legacy: true };\n",
          "web/src/sky/catalog.ts": lines(
            'import { stars } from "../gen/stars";',
            "export const catalog = stars;",
          ),
          "web/src/orbits/types.ts":
            "export interface Orbit { period: number }\n",
          "web/src/orbits/kepler.ts": lines(
            'import { units } from "./units.js";',
            "export const kepler = units;",
          ),
          "web/src/orbits/units.ts": 'export const units = "AU";\n',
          "web/src/orbits/moon.ts": lines(
            'import { earth } from "./earth";',
            "export const moon = () => earth;",
          ),
          "web/src/orbits/earth.ts": lines(
            'import { moon } from "./moon";',
            "export const earth = () => moon;",
          ),
          "web/src/api/client.ts": "export const fetchSky = () => 1;\n",
          // metadata-only: out of the engine's input, so the import of it has no edge
          "web/src/gen/stars.ts": lines(
            "// @generated",
            "export const stars = 1;",
          ),
          // a dot directory the walk enters, and an ignore file it must not honour
          ".hidden/tool.ts": lines(
            'import { body } from "../web/src/sky/body";',
            "export const tool = body;",
          ),
          ".gitignore": "*.ts\n*.cjs\n",
          "sim/orbit.py": "def period():\n    return 1\n",
        },
      },
    ],
  });
  const ctx = await exportOf(repo);
  expect(ctx.profile.typescript.aliases).toEqual({
    "@obs/web/*": ["web/src/*"],
  });
  expect(ctx.manifest.metadataOnly).toEqual([
    { path: "web/src/gen/stars.ts", reason: "generated" },
  ]);
  expect(depcruiseDriver.applies(ctx)).toBe(true);
  const facts = await depcruiseDriver.run(ctx);

  expect([...facts.modules]).toEqual([
    ".hidden/tool.ts",
    "web/src/api/client.ts",
    "web/src/orbits/earth.ts",
    "web/src/orbits/kepler.ts",
    "web/src/orbits/moon.ts",
    "web/src/orbits/types.ts",
    "web/src/orbits/units.ts",
    "web/src/sky/body.ts",
    "web/src/sky/catalog.ts",
    "web/src/sky/lazy.ts",
    "web/src/sky/legacy.cjs",
    "web/src/sky/render.ts",
  ]);
  const local = (from: string, specifier: string, to: string | null) => ({
    from,
    specifier,
    to,
    external: null,
    typeOnly: false,
  });
  const render = "web/src/sky/render.ts";
  expect(facts.edges).toEqual([
    local(".hidden/tool.ts", "../web/src/sky/body", "web/src/sky/body.ts"),
    local("web/src/orbits/earth.ts", "./moon", "web/src/orbits/moon.ts"),
    local("web/src/orbits/kepler.ts", "./units.js", "web/src/orbits/units.ts"),
    local("web/src/orbits/moon.ts", "./earth", "web/src/orbits/earth.ts"),
    local(render, "../api/client", "web/src/api/client.ts"),
    {
      ...local(render, "../orbits/types", "web/src/orbits/types.ts"),
      typeOnly: true,
    },
    local(render, "./body", "web/src/sky/body.ts"),
    local(render, "./lazy", "web/src/sky/lazy.ts"),
    local(render, "./legacy.cjs", "web/src/sky/legacy.cjs"),
    local(render, "./missing", null),
    local(render, "@obs/web/orbits/kepler", "web/src/orbits/kepler.ts"),
    {
      ...local(render, "node:fs", null),
      external: { ecosystem: "node", name: "fs" },
    },
    {
      ...local(render, "react", null),
      external: { ecosystem: "npm", name: "react" },
    },
  ]);
  expect(facts.violations).toEqual([
    {
      rule: "sky-not-from-api",
      severity: "error",
      from: render,
      to: "web/src/api/client.ts",
    },
  ]);
  expect([...facts.circular]).toEqual([
    "web/src/orbits/earth.ts",
    "web/src/orbits/moon.ts",
  ]);
  // the raw output is deleted after parsing; the run config names the export's files
  expect(existsSync(join(ctx.workDir, "depcruise.out.json"))).toBe(false);
  expect(
    JSON.parse(readFileSync(join(ctx.workDir, "depcruise.run.json"), "utf8")),
  ).toEqual({
    extends: join(ctx.exportDir, "depcruise.json"),
    options: {
      baseDir: ctx.snapshotDir,
      tsConfig: { fileName: join(ctx.exportDir, "tsconfig.json") },
    },
  });
}, 300_000);

it("never runs a repo's own dependency-cruiser config", async () => {
  const root = mkdtempSync(join(tmpdir(), "hakutaku-oracle-depcruise-canary-"));
  made.push(root);
  const canary = join(root, "canary");
  // a config with a side effect, and one whose rule every import breaks
  const sideEffect = `require("node:fs").writeFileSync(${JSON.stringify(canary)}, "ran");\nmodule.exports = { forbidden: [] };\n`;
  const ownRule = JSON.stringify({
    forbidden: [{ name: "repo-own-rule", severity: "error", from: {}, to: {} }],
  });
  const repo = await makeRepo({
    commits: [
      {
        date: "2026-03-02T10:00:00Z",
        files: {
          "web/src/sky.ts":
            'import { body } from "./body";\nexport const sky = body;\n',
          "web/src/body.ts": "export const body = 1;\n",
          ".dependency-cruiser.js": sideEffect,
          ".dependency-cruiser.cjs": sideEffect,
          ".dependency-cruiser.json": ownRule,
        },
      },
    ],
  });
  const ctx = await exportOf(repo);
  // the export removed the repo's configs
  expect(ctx.manifest.engineConfigsRemoved).toEqual([
    ".dependency-cruiser.cjs",
    ".dependency-cruiser.js",
    ".dependency-cruiser.json",
  ]);
  for (const name of ctx.manifest.engineConfigsRemoved) {
    expect(existsSync(join(ctx.snapshotDir, name))).toBe(false);
  }
  // and the run passes its own config, so the copies where a run without --config would
  // look (the working directory), and beside the snapshot, are never read
  for (const dir of [ctx.workDir, ctx.exportDir]) {
    writeFileSync(join(dir, ".dependency-cruiser.js"), sideEffect);
    writeFileSync(join(dir, ".dependency-cruiser.cjs"), sideEffect);
    writeFileSync(join(dir, ".dependency-cruiser.json"), ownRule);
  }
  const facts = await depcruiseDriver.run(ctx);
  expect(existsSync(canary)).toBe(false);
  expect([...facts.modules]).toEqual(["web/src/body.ts", "web/src/sky.ts"]);
  expect(facts.violations).toEqual([]);
}, 300_000);

// enhanced-resolve, inside dependency-cruiser, reads ? in a request as a query, and answers
// orbit.ts for ./orbit?2; the driver reads such a specifier as written (sky#1 must not
// resolve to sky.ts either).
it("resolves odd file names to their own files, a name holding ? or # included", async () => {
  const odd = [
    "sky#1",
    "orbit?2",
    "sky map",
    "50%",
    "x:y",
    "~moon",
    "étoile",
    "trail-",
    "a--b",
  ];
  const files: Record<string, string> = {
    "web/sky.ts": "export const plain = 0;\n",
    "web/orbit.ts": "export const plain = 0;\n",
    "web/main.ts": lines(
      ...odd.map(
        (n, i) => `import { v${i} } from ${JSON.stringify(`./${n}`)};`,
      ),
      `export const all = [${odd.map((_, i) => `v${i}`).join(", ")}];`,
    ),
  };
  odd.forEach((n, i) => {
    files[`web/${n}.ts`] = `export const v${i} = ${i};\n`;
  });
  const repo = await makeRepo({
    commits: [{ date: "2026-03-02T10:00:00Z", files }],
  });
  const facts = await depcruiseDriver.run(await exportOf(repo));
  expect([...facts.modules].sort()).toEqual(Object.keys(files).sort());
  expect(
    facts.edges.map((e) => [e.specifier, e.to, e.external, e.typeOnly]),
  ).toEqual([...odd].sort().map((n) => [`./${n}`, `web/${n}.ts`, null, false]));
}, 300_000);

// doNotFollow matches a node_modules directory only, never a name that merely holds the word;
// and a file a relative import reaches outside the snapshot is resolved but never opened,
// which the unreadable file beside the snapshot proves (opening it would fail the run).
it("cruises a file whose name holds node_modules, and never opens a file outside the snapshot", async () => {
  const repo = await makeRepo({
    commits: [
      {
        date: "2026-03-02T10:00:00Z",
        files: {
          "web/sky.ts": lines(
            'import { clean } from "./no_node_modules";',
            'import { kit } from "./node_modules/kit/index.js";',
            'import { far } from "../../outside";',
            "export const sky = [clean, kit, far];",
          ),
          "web/no_node_modules.ts": "export const clean = 1;\n",
          "web/node_modules/kit/index.js": lines(
            'const deeper = require("./deeper.js");',
            "exports.kit = deeper;",
          ),
        },
      },
    ],
  });
  const ctx = await exportOf(repo);
  const outside = join(ctx.exportDir, "outside.ts");
  writeFileSync(
    outside,
    'import { s } from "./beyond";\nexport const far = s;\n',
  );
  chmodSync(outside, 0o000);
  try {
    const facts = await depcruiseDriver.run(ctx);
    expect([...facts.modules]).toEqual([
      "web/no_node_modules.ts",
      "web/sky.ts",
    ]);
    expect(
      facts.edges.map((e) => [e.from, e.specifier, e.to, e.external]),
    ).toEqual([
      ["web/sky.ts", "../../outside", null, null],
      ["web/sky.ts", "./no_node_modules", "web/no_node_modules.ts", null],
      [
        "web/sky.ts",
        "./node_modules/kit/index.js",
        null,
        { ecosystem: "npm", name: "kit" },
      ],
    ]);
  } finally {
    chmodSync(outside, 0o644);
  }
}, 300_000);

it("fails with dependency-cruiser's own error when it exits non-zero", async () => {
  const repo = await makeRepo({
    commits: [
      {
        date: "2026-03-02T10:00:00Z",
        files: { "web/src/sky.ts": "export const sky = 1;\n" },
      },
    ],
  });
  const ctx = await exportOf(repo);
  // a rule dependency-cruiser's schema refuses
  writeFileSync(
    join(ctx.exportDir, "depcruise.json"),
    JSON.stringify({
      forbidden: [{ name: "broken", from: { nope: 1 }, to: {} }],
    }),
  );
  await expect(depcruiseDriver.run(ctx)).rejects.toThrow(
    /^dependency-cruiser failed: .*ERROR/s,
  );
  expect(existsSync(join(ctx.workDir, "depcruise.out.json"))).toBe(false);
}, 300_000);
