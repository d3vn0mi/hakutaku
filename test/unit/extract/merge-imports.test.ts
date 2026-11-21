// The imports and externals tables: one row per import fact, resolved by the best tier that
// covers its file, with the specifier as written, deduped, and the counts the gates read.
import { expect, it } from "vitest";
import type { DepcruiseFacts } from "../../../src/extract/drivers/depcruise.js";
import type { GrimpFacts } from "../../../src/extract/drivers/grimp.js";
import { mergeDefinitions } from "../../../src/extract/merge/definitions.js";
import { fileRows } from "../../../src/extract/merge/files.js";
import { mergeImports } from "../../../src/extract/merge/imports.js";
import type { MergeInput } from "../../../src/extract/merge/types.js";
import {
  positionKey,
  type ScipFacts,
} from "../../../src/extract/scip/facts.js";
import type { ImportRow } from "../../../src/store/index.js";
import {
  astGrep,
  importFact,
  mergeInput,
  P,
  SIM,
  spot,
} from "./merge-input.js";

const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const high = (n: number) =>
  Array.from({ length: n }, (_, i) => ALPHA[(i * 37 + 11) % ALPHA.length]).join(
    "",
  );
const join = (...parts: string[]) => parts.join("");

function importsOf(input: MergeInput) {
  const files = fileRows(input);
  return mergeImports(input, files, mergeDefinitions(input, files));
}

// An import row: [id, source file, target file, target external, kind, line, specifier,
// producer]; resolved follows from the targets.
function rows(
  ...list: Array<
    [
      number,
      number,
      number | null,
      number | null,
      ImportRow["kind"],
      number,
      string,
      ImportRow["producer"],
    ]
  >
): ImportRow[] {
  return list.map(([id, src, dst, ext, kind, line, specifier, producer]) => ({
    id,
    src_file_id: src,
    dst_file_id: dst,
    dst_external_id: ext,
    kind,
    line,
    specifier,
    resolved: dst !== null || ext !== null ? 1 : 0,
    producer,
  }));
}

it("resolves TS imports by dependency-cruiser, then SCIP, then hakutaku's resolver", () => {
  const BODY = "web/src/body.ts";
  const EXTRA = "web/src/extra.ts";
  const RENDER = "web/src/render.ts";
  const FILES: Record<string, string> = {
    [BODY]: "export interface Body {}\n",
    [EXTRA]: "import type { Body } from './body';\n",
    "web/src/gen.ts": "export const gen = 1;\n",
    [RENDER]:
      "import { Body } from './body';\nimport { readFile } from 'node:fs';\nimport React from 'react';\nimport { gone } from './missing';\nimport { gen } from './gen';\n",
  };
  const at = (file: string, line: number, specifier: string) =>
    spot(FILES[file] ?? "", line, `'${specifier}'`);
  const facts = astGrep({
    imports: [
      importFact(EXTRA, at(EXTRA, 1, "./body"), "./body", "type-only"),
      importFact(RENDER, at(RENDER, 1, "./body"), "./body"),
      importFact(RENDER, at(RENDER, 2, "node:fs"), "node:fs"),
      importFact(RENDER, at(RENDER, 3, "react"), "react"),
      importFact(RENDER, at(RENDER, 4, "./missing"), "./missing"),
      importFact(RENDER, at(RENDER, 5, "./gen"), "./gen"),
    ],
  });
  // dependency-cruiser lists render.ts but not extra.ts, and keeps the metadata-only gen.ts
  // and every import of it out
  const depcruise: DepcruiseFacts = {
    modules: new Set([BODY, RENDER]),
    edges: [
      {
        from: RENDER,
        specifier: "./body",
        to: BODY,
        external: null,
        typeOnly: false,
      },
      {
        from: RENDER,
        specifier: "./missing",
        to: null,
        external: null,
        typeOnly: false,
      },
      {
        from: RENDER,
        specifier: "node:fs",
        to: null,
        external: { ecosystem: "node", name: "fs" },
        typeOnly: false,
      },
      {
        from: RENDER,
        specifier: "react",
        to: null,
        external: { ecosystem: "npm", name: "react" },
        typeOnly: false,
      },
    ],
    violations: [],
    circular: new Set(),
  };
  const scip: ScipFacts = {
    documents: new Set([BODY, EXTRA, RENDER]),
    definitions: [],
    uses: [],
    moduleAt: new Map([
      [positionKey(EXTRA, at(EXTRA, 1, "./body")), BODY],
      [positionKey(RENDER, at(RENDER, 1, "./body")), BODY],
    ]),
    duplicates: [],
  };
  const options = { metadataOnly: { "web/src/gen.ts": "generated" as const } };
  const externals = [
    { id: 1, ecosystem: "node", name: "fs", files: 1 },
    { id: 2, ecosystem: "npm", name: "react", files: 1 },
  ];

  const cruised = importsOf(
    mergeInput(FILES, {
      ...options,
      facts: { astGrep: facts, depcruise, scip },
    }),
  );
  expect(cruised.imports).toEqual(
    rows(
      [1, 2, 1, null, "type-only", 1, "./body", "hakutaku-resolver"],
      [2, 4, 1, null, "static", 1, "./body", "dependency-cruiser"],
      [3, 4, null, 1, "static", 2, "node:fs", "dependency-cruiser"],
      [4, 4, null, 2, "static", 3, "react", "dependency-cruiser"],
      [5, 4, null, null, "static", 4, "./missing", "hakutaku-resolver"],
      [6, 4, 3, null, "static", 5, "./gen", "hakutaku-resolver"],
    ),
  );
  expect(cruised.externals).toEqual(externals);
  expect(cruised.indexed).toEqual(
    new Map([["typescript", new Set([BODY, RENDER])]]),
  );

  // dependency-cruiser failed: SCIP names the modules it binds, and nothing else
  const bound = importsOf(
    mergeInput(FILES, { ...options, facts: { astGrep: facts, scip } }),
  );
  expect(bound.imports).toEqual(
    rows(
      [1, 2, 1, null, "type-only", 1, "./body", "scip-typescript"],
      [2, 4, 1, null, "static", 1, "./body", "scip-typescript"],
      [3, 4, null, 1, "static", 2, "node:fs", "hakutaku-resolver"],
      [4, 4, null, 2, "static", 3, "react", "hakutaku-resolver"],
      [5, 4, null, null, "static", 4, "./missing", "hakutaku-resolver"],
      [6, 4, 3, null, "static", 5, "./gen", "hakutaku-resolver"],
    ),
  );
  expect(bound.externals).toEqual(externals);
  expect(bound.indexed).toEqual(
    new Map([["typescript", new Set([BODY, EXTRA, RENDER])]]),
  );

  const resolved = importsOf(
    mergeInput(FILES, { ...options, facts: { astGrep: facts } }),
  );
  expect(resolved.imports).toEqual(
    rows(
      [1, 2, 1, null, "type-only", 1, "./body", "hakutaku-resolver"],
      [2, 4, 1, null, "static", 1, "./body", "hakutaku-resolver"],
      [3, 4, null, 1, "static", 2, "node:fs", "hakutaku-resolver"],
      [4, 4, null, 2, "static", 3, "react", "hakutaku-resolver"],
      [5, 4, null, null, "static", 4, "./missing", "hakutaku-resolver"],
      [6, 4, 3, null, "static", 5, "./gen", "hakutaku-resolver"],
    ),
  );
  expect(resolved.externals).toEqual(externals);
});

it("resolves Python imports by grimp inside packages and by hakutaku's resolver outside them", () => {
  const CLI = "sim/src/observatory/ephemeris/cli.py";
  const TEST = "sim/tests/test_cli.py";
  const CLI_TEXT =
    "import importlib\nimport json\nfrom .. import catalog\nfrom ..catalog import STARS\nimport numpy.linalg\nimport observatory.catalog; mod = importlib.import_module('observatory.catalog')\nfrom .missing import orbit\n";
  const grimp: GrimpFacts = {
    version: "3.18",
    modules: new Set([
      "observatory",
      "observatory.catalog",
      "observatory.ephemeris",
      "observatory.ephemeris.cli",
    ]),
    imports: [
      { importer: "observatory.ephemeris.cli", imported: "importlib", line: 1 },
      { importer: "observatory.ephemeris.cli", imported: "json", line: 2 },
      { importer: "observatory.ephemeris.cli", imported: "numpy", line: 5 },
      {
        importer: "observatory.ephemeris.cli",
        imported: "observatory.catalog",
        line: 3,
      },
      {
        importer: "observatory.ephemeris.cli",
        imported: "observatory.catalog",
        line: 4,
      },
      {
        importer: "observatory.ephemeris.cli",
        imported: "observatory.catalog",
        line: 6,
      },
      // grimp lands the import of a missing module on its nearest existing parent
      {
        importer: "observatory.ephemeris.cli",
        imported: "observatory.ephemeris",
        line: 7,
      },
    ],
    external: new Set(["importlib", "json", "numpy"]),
    layerViolations: [],
  };
  const merged = importsOf(
    mergeInput(
      {
        "sim/src/observatory/__init__.py": "",
        "sim/src/observatory/catalog.py": "STARS = []\n",
        "sim/src/observatory/ephemeris/__init__.py": "",
        [CLI]: CLI_TEXT,
        [TEST]: "from observatory.ephemeris import cli\nimport os\n",
      },
      {
        profile: SIM,
        facts: {
          pythonResolver: "grimp",
          grimp,
          astGrep: astGrep({
            imports: [
              importFact(CLI, P(1, 8), "importlib"),
              importFact(CLI, P(2, 8), "json"),
              importFact(CLI, P(3, 6), "..", "static", ["catalog"]),
              importFact(CLI, P(4, 6), "..catalog", "static", ["STARS"]),
              importFact(CLI, P(5, 8), "numpy.linalg"),
              importFact(CLI, P(6, 8), "observatory.catalog"),
              // grimp never reads a dynamic import, so hakutaku's resolver does, even on
              // a line where grimp imports the same module
              importFact(
                CLI,
                spot(CLI_TEXT, 6, "'observatory.catalog'"),
                "observatory.catalog",
                "dynamic",
              ),
              importFact(CLI, P(7, 6), ".missing", "static", ["orbit"]),
              // the tests are under no root, so grimp read none of them
              importFact(TEST, P(1, 6), "observatory.ephemeris", "static", [
                "cli",
              ]),
              importFact(TEST, P(2, 8), "os"),
            ],
          }),
        },
      },
    ),
  );
  expect(merged.imports).toEqual(
    rows(
      [1, 4, null, 2, "static", 1, "importlib", "grimp"],
      [2, 4, null, 3, "static", 2, "json", "grimp"],
      [3, 4, 2, null, "static", 3, "..catalog", "grimp"],
      [4, 4, 2, null, "static", 4, "..catalog", "grimp"],
      [5, 4, null, 1, "static", 5, "numpy.linalg", "grimp"],
      [6, 4, 2, null, "dynamic", 6, "observatory.catalog", "hakutaku-resolver"],
      [7, 4, 2, null, "static", 6, "observatory.catalog", "grimp"],
      // hakutaku's resolver alone would leave it unresolved: the module does not exist
      [8, 4, 3, null, "static", 7, ".missing", "grimp"],
      [
        9,
        5,
        4,
        null,
        "static",
        1,
        "observatory.ephemeris.cli",
        "hakutaku-resolver",
      ],
      [10, 5, null, 4, "static", 2, "os", "hakutaku-resolver"],
    ),
  );
  expect(merged.externals).toEqual([
    { id: 1, ecosystem: "pypi", name: "numpy", files: 1 },
    { id: 2, ecosystem: "python", name: "importlib", files: 1 },
    { id: 3, ecosystem: "python", name: "json", files: 1 },
    { id: 4, ecosystem: "python", name: "os", files: 1 },
  ]);
  expect(merged.indexed).toEqual(
    new Map([
      [
        "python",
        new Set([
          "sim/src/observatory/__init__.py",
          "sim/src/observatory/catalog.py",
          "sim/src/observatory/ephemeris/__init__.py",
          CLI,
        ]),
      ],
    ]),
  );
  expect(merged.relative).toEqual({ total: 3, unresolved: 0 });
});

it("writes a submodule import's specifier with its name", () => {
  const REBUILD = "sim/src/observatory/tools/rebuild.py";
  const files = {
    "sim/src/observatory/__init__.py": "VERSION = '1.0'\n",
    "sim/src/observatory/ephemeris/__init__.py": "",
    "sim/src/observatory/tools/__init__.py": "",
    "sim/src/observatory/tools/helpers.py": "",
    [REBUILD]:
      "from observatory import ephemeris, VERSION\nfrom . import helpers\nfrom .. import *\n",
  };
  const facts = astGrep({
    imports: [
      importFact(REBUILD, P(1, 6), "observatory", "static", [
        "ephemeris",
        "VERSION",
      ]),
      importFact(REBUILD, P(2, 6), ".", "static", ["helpers"]),
      importFact(REBUILD, P(3, 6), "..", "static", ["*"]),
    ],
  });
  // from observatory import ephemeris: "observatory.ephemeris"; VERSION is no module, so the
  // statement also imports "observatory"; a module of dots only takes the name with no dot
  const expected = (producer: ImportRow["producer"]) =>
    rows(
      [1, 5, 1, null, "static", 1, "observatory", producer],
      [2, 5, 2, null, "static", 1, "observatory.ephemeris", producer],
      [3, 5, 4, null, "static", 2, ".helpers", producer],
      [4, 5, 1, null, "static", 3, "..", producer],
    );
  expect(
    importsOf(mergeInput(files, { profile: SIM, facts: { astGrep: facts } }))
      .imports,
  ).toEqual(expected("hakutaku-resolver"));
  const importer = "observatory.tools.rebuild";
  const grimp: GrimpFacts = {
    version: "3.18",
    modules: new Set([
      "observatory",
      "observatory.ephemeris",
      "observatory.tools",
      "observatory.tools.helpers",
      importer,
    ]),
    imports: [
      { importer, imported: "observatory", line: 1 },
      { importer, imported: "observatory", line: 3 },
      { importer, imported: "observatory.ephemeris", line: 1 },
      { importer, imported: "observatory.tools.helpers", line: 2 },
    ],
    external: new Set(),
    layerViolations: [],
  };
  expect(
    importsOf(
      mergeInput(files, {
        profile: SIM,
        facts: { astGrep: facts, grimp, pythonResolver: "grimp" },
      }),
    ).imports,
  ).toEqual(expected("grimp"));
});

it("counts computed imports and unresolved relative imports", () => {
  const RUN = "scripts/run.sh";
  const INIT = "sim/src/observatory/__init__.py";
  const LOADER = "web/src/loader.ts";
  const LOADER_TEXT =
    "import { x } from '../lib/x';\nimport { y } from './missing';\nimport React from 'react';\nexport const load = (name: string) => import(name);\n";
  const merged = importsOf(
    mergeInput(
      {
        "README.md": "see import(name)\n",
        "scripts/lib.sh": "greet() { echo hi; }\n",
        [RUN]: "source ./lib.sh\nsource ./gone.sh\n",
        [INIT]: "from .. import sky\nfrom . import catalog\n",
        "sim/src/observatory/catalog.py": "",
        "web/lib/x.ts": "export const x = 1;\n",
        [LOADER]: LOADER_TEXT,
      },
      {
        profile: SIM,
        facts: {
          astGrep: astGrep({
            imports: [
              importFact(RUN, P(1, 8), "./lib.sh", "source"),
              importFact(RUN, P(2, 8), "./gone.sh", "source"),
              // .. climbs past the top package, and sky is no module of it
              importFact(INIT, P(1, 6), "..", "static", ["sky"]),
              importFact(INIT, P(2, 6), ".", "static", ["catalog"]),
              importFact(
                LOADER,
                spot(LOADER_TEXT, 1, "'../lib/x'"),
                "../lib/x",
              ),
              importFact(
                LOADER,
                spot(LOADER_TEXT, 2, "'./missing'"),
                "./missing",
              ),
              importFact(LOADER, spot(LOADER_TEXT, 3, "'react'"), "react"),
            ],
            // a doc is on no map: its computed import is not counted
            computed: [
              { file: LOADER, line: 4 },
              { file: "README.md", line: 1 },
            ],
          }),
        },
      },
    ),
  );
  expect(merged.computedImports).toBe(1);
  expect(merged.relative).toEqual({ total: 6, unresolved: 3 });
  expect(merged.imports).toEqual(
    rows(
      [1, 3, 2, null, "source", 1, "./lib.sh", "ast-grep"],
      [2, 3, null, null, "source", 2, "./gone.sh", "ast-grep"],
      [3, 4, null, null, "static", 1, "..", "hakutaku-resolver"],
      [4, 4, 5, null, "static", 2, ".catalog", "hakutaku-resolver"],
      [5, 7, 6, null, "static", 1, "../lib/x", "hakutaku-resolver"],
      [6, 7, null, null, "static", 2, "./missing", "hakutaku-resolver"],
      [7, 7, null, 1, "static", 3, "react", "hakutaku-resolver"],
    ),
  );
  expect(merged.externals).toEqual([
    { id: 1, ecosystem: "npm", name: "react", files: 1 },
  ]);
});

it("reads a plugin-style repo's top as the package its relative imports start from", () => {
  const TOP = "__init__.py";
  const CHART = "sky/chart.py";
  const merged = importsOf(
    mergeInput(
      {
        [TOP]:
          "from .sky import chart\nfrom . import helpers\nfrom .. import outside\n",
        "helpers.py": "def shine():\n    return 1\n",
        "sky/__init__.py": "",
        [CHART]: "from .. import helpers\n",
      },
      {
        // the root a generated profile gives a repo whose top holds an __init__.py
        profile: { python: { roots: ["."], singleFileModules: [] } },
        facts: {
          astGrep: astGrep({
            imports: [
              importFact(TOP, P(1, 6), ".sky", "static", ["chart"]),
              importFact(TOP, P(2, 6), ".", "static", ["helpers"]),
              // .. climbs past the repo top, the outermost package
              importFact(TOP, P(3, 6), "..", "static", ["outside"]),
              importFact(CHART, P(1, 6), "..", "static", ["helpers"]),
            ],
          }),
        },
      },
    ),
  );
  // the submodules a from-import names are written with their names, as anywhere else
  expect(merged.imports).toEqual(
    rows(
      [1, 1, 4, null, "static", 1, ".sky.chart", "hakutaku-resolver"],
      [2, 1, 2, null, "static", 2, ".helpers", "hakutaku-resolver"],
      [3, 1, null, null, "static", 3, "..", "hakutaku-resolver"],
      [4, 4, 2, null, "static", 1, "..helpers", "hakutaku-resolver"],
    ),
  );
  expect(merged.relative).toEqual({ total: 4, unresolved: 1 });
});

it("names node built-ins by top-level name", () => {
  const A = "web/src/a.ts";
  const B = "web/src/b.ts";
  const FILES: Record<string, string> = {
    [A]: "import { readFile } from 'fs/promises';\nimport { join } from 'node:path';\n",
    [B]: "import fs from 'fs';\nimport test from 'node:test';\n",
  };
  const imp = (file: string, line: number, specifier: string) =>
    importFact(
      file,
      spot(FILES[file] ?? "", line, `'${specifier}'`),
      specifier,
    );
  const merged = importsOf(
    mergeInput(FILES, {
      facts: {
        astGrep: astGrep({
          imports: [
            imp(A, 1, "fs/promises"),
            imp(A, 2, "node:path"),
            imp(B, 1, "fs"),
            imp(B, 2, "node:test"),
          ],
        }),
      },
    }),
  );
  expect(merged.externals).toEqual([
    { id: 1, ecosystem: "node", name: "fs", files: 2 },
    { id: 2, ecosystem: "node", name: "path", files: 1 },
    { id: 3, ecosystem: "node", name: "test", files: 1 },
  ]);
  expect(merged.imports).toEqual(
    rows(
      [1, 1, null, 1, "static", 1, "fs/promises", "hakutaku-resolver"],
      [2, 1, null, 2, "static", 2, "node:path", "hakutaku-resolver"],
      [3, 2, null, 1, "static", 1, "fs", "hakutaku-resolver"],
      [4, 2, null, 3, "static", 2, "node:test", "hakutaku-resolver"],
    ),
  );
});

it("stores a dependency-cruiser edge no statement names at its specifier's string, else at line 1 with a warning", () => {
  const CLOCK = "web/src/clock.ts";
  const merged = importsOf(
    mergeInput(
      {
        [CLOCK]:
          '// the sky\'s clock\n\n/// <reference types="node" />\nexport const now = 0;\n',
      },
      {
        facts: {
          astGrep: astGrep({}),
          depcruise: {
            modules: new Set([CLOCK]),
            edges: [
              {
                from: CLOCK,
                specifier: "./ghost",
                to: null,
                external: null,
                typeOnly: false,
              },
              {
                from: CLOCK,
                specifier: "node",
                to: null,
                external: { ecosystem: "npm", name: "node" },
                typeOnly: true,
              },
            ],
            violations: [],
            circular: new Set(),
          },
        },
      },
    ),
  );
  expect(merged.imports).toEqual(
    rows(
      [1, 1, null, null, "static", 1, "./ghost", "hakutaku-resolver"],
      [2, 1, null, 1, "type-only", 3, "node", "dependency-cruiser"],
    ),
  );
  expect(merged.externals).toEqual([
    { id: 1, ecosystem: "npm", name: "node", files: 1 },
  ]);
  expect(merged.warnings).toEqual([
    'web/src/clock.ts: dependency-cruiser found an import of "./ghost" that no string literal holds; stored at line 1',
  ]);
  expect(merged.relative).toEqual({ total: 1, unresolved: 1 });
});

it("resolves a shell source relative to its file, then to the repo top", () => {
  const SYNC = "scripts/sync.sh";
  const merged = importsOf(
    mergeInput(
      {
        "lib/env.sh": "export SKY=1\n",
        "scripts/deploy.sh": "echo deploy\n",
        // what /etc/profile would name if it were joined to the file's directory
        "scripts/etc/profile": "# not the system profile\n",
        "scripts/lib/common.sh": "greet() { :; }\n",
        [SYNC]:
          "source ./lib/common.sh\n. lib/env.sh\nsource /etc/profile\nbash deploy.sh\n",
      },
      {
        facts: {
          astGrep: astGrep({
            imports: [
              importFact(SYNC, P(1, 8), "./lib/common.sh", "source"),
              // scripts/lib/env.sh does not exist; lib/env.sh at the top does
              importFact(SYNC, P(2, 3), "lib/env.sh", "source"),
              // an absolute path names no repo file
              importFact(SYNC, P(3, 8), "/etc/profile", "source"),
              importFact(SYNC, P(4, 6), "deploy.sh", "exec"),
            ],
          }),
        },
      },
    ),
  );
  expect(merged.imports).toEqual(
    rows(
      [1, 5, 4, null, "source", 1, "./lib/common.sh", "ast-grep"],
      [2, 5, 1, null, "source", 2, "lib/env.sh", "ast-grep"],
      [3, 5, null, null, "source", 3, "/etc/profile", "ast-grep"],
      [4, 5, 2, null, "exec", 4, "deploy.sh", "ast-grep"],
    ),
  );
  expect(merged.relative).toEqual({ total: 1, unresolved: 0 });
  expect(merged.indexed).toEqual(
    new Map([
      [
        "shell",
        new Set([
          "lib/env.sh",
          "scripts/deploy.sh",
          "scripts/lib/common.sh",
          SYNC,
        ]),
      ],
    ]),
  );
});

it("keeps the import facts of code, test and test-support files only", () => {
  const merged = importsOf(
    mergeInput(
      {
        "web/src/a.ts": "export const a = 1;\n",
        "web/src/b.ts": "import { a } from './a';\n",
        // a NUL byte makes the file other, whatever its extension
        "web/src/blob.ts": "import { a } from './a';\0\n",
      },
      {
        facts: {
          astGrep: astGrep({
            imports: [
              importFact("web/src/b.ts", P(1, 19), "./a"),
              importFact("web/src/blob.ts", P(1, 19), "./a"),
            ],
            computed: [{ file: "web/src/blob.ts", line: 1 }],
          }),
        },
      },
    ),
  );
  expect(merged.imports).toEqual(
    rows([1, 2, 1, null, "static", 1, "./a", "hakutaku-resolver"]),
  );
  expect(merged.computedImports).toBe(0);
  expect(merged.importersOf).toEqual(
    new Map([["web/src/a.ts", new Set(["web/src/b.ts"])]]),
  );
  expect(merged.indexed).toEqual(
    new Map([["typescript", new Set(["web/src/a.ts", "web/src/b.ts"])]]),
  );
});

it("redacts specifiers, then orders and dedupes the rows, and counts each external's importing files", () => {
  const A = "web/src/a.ts";
  const github = join("gh", "p_", high(36));
  const A_TEXT = `import React from 'react';\nimport { useState } from 'react';\nimport { x } from './x';\nimport cfg from 'https://example.invalid/${github}';\nimport { x as z } from './x'; export * from './y';\n`;
  const merged = importsOf(
    mergeInput(
      {
        [A]: A_TEXT,
        "web/src/b.ts": "import React from 'react';\n",
        "web/src/x.ts": "export const x = 1;\n",
        "web/src/y.ts": "export const y = 2;\n",
      },
      {
        facts: {
          astGrep: astGrep({
            imports: [
              // on one line, the specifier orders the rows before the kind does
              importFact(A, spot(A_TEXT, 5, "'./y'"), "./y", "re-export"),
              importFact(A, spot(A_TEXT, 5, "'./x'"), "./x"),
              importFact(
                A,
                spot(A_TEXT, 4, "'https:"),
                `https://example.invalid/${github}`,
              ),
              importFact(A, spot(A_TEXT, 3, "'./x'"), "./x"),
              // the same fact twice is one row
              importFact(A, spot(A_TEXT, 3, "'./x'"), "./x"),
              importFact(A, spot(A_TEXT, 2, "'react'"), "react"),
              importFact(A, spot(A_TEXT, 1, "'react'"), "react"),
              importFact("web/src/b.ts", P(1, 19), "react"),
            ],
          }),
        },
      },
    ),
  );
  expect(merged.imports).toEqual(
    rows(
      [1, 1, null, 1, "static", 1, "react", "hakutaku-resolver"],
      [2, 1, null, 1, "static", 2, "react", "hakutaku-resolver"],
      [3, 1, 3, null, "static", 3, "./x", "hakutaku-resolver"],
      [
        4,
        1,
        null,
        null,
        "static",
        4,
        "https://example.invalid/«redacted:github-token»",
        "hakutaku-resolver",
      ],
      [5, 1, 3, null, "static", 5, "./x", "hakutaku-resolver"],
      [6, 1, 4, null, "re-export", 5, "./y", "hakutaku-resolver"],
      [7, 2, null, 1, "static", 1, "react", "hakutaku-resolver"],
    ),
  );
  expect(merged.externals).toEqual([
    { id: 1, ecosystem: "npm", name: "react", files: 2 },
  ]);
  expect(merged.redactions).toBe(1);
});

it("stores an external's name redacted, as one row for names that redact alike, counted once", () => {
  const A = "web/src/a.ts";
  const B = "web/src/b.ts";
  // two bare specifiers that are secrets, each a package name of its own
  const first = join("gh", "p_", high(36));
  const second = join("gh", "p_", high(40));
  const FILES: Record<string, string> = {
    [A]: `import a from '${first}';\nimport React from 'react';\n`,
    [B]: `import b from '${second}';\n`,
  };
  const merged = importsOf(
    mergeInput(FILES, {
      facts: {
        astGrep: astGrep({
          imports: [
            importFact(A, spot(FILES[A] ?? "", 1, `'${first}'`), first),
            importFact(A, spot(FILES[A] ?? "", 2, "'react'"), "react"),
            importFact(B, spot(FILES[B] ?? "", 1, `'${second}'`), second),
          ],
        }),
      },
    }),
  );
  const hidden = "«redacted:github-token»";
  expect(merged.externals).toEqual([
    { id: 1, ecosystem: "npm", name: "react", files: 1 },
    { id: 2, ecosystem: "npm", name: hidden, files: 2 },
  ]);
  expect(merged.imports).toEqual(
    rows(
      [1, 1, null, 2, "static", 1, hidden, "hakutaku-resolver"],
      [2, 1, null, 1, "static", 2, "react", "hakutaku-resolver"],
      [3, 2, null, 2, "static", 1, hidden, "hakutaku-resolver"],
    ),
  );
  // the two specifiers, and the one external row
  expect(merged.redactions).toBe(3);
});
