#!/usr/bin/env node
// generate.mjs: writes the scale fixture, a large synthetic repository of a given size, for the
// checks that need one, such as the latency check of hakutaku mcp.
//
//   node fixtures/scale/generate.mjs --files <n> --out <dir>
//
// It writes a git repository at <dir> that holds exactly n files, with main checked out, and
// prints the commit main ends at, 40 hex digits, then a newline. <dir> may be missing, and is
// then made; otherwise it must be an empty directory. n is at least 6, so that every file and
// function a manifest names exists. Exit codes: 0 done; 1 a failure, with the reason on stderr;
// 2 a usage error, with the usage line on stderr.
//
// The files. package.json (one bin and two scripts), pyproject.toml (one console script) and
// py/src/scale/__init__.py; then, of the rest, 75% TypeScript modules
// packages/pNN/src/mNNNNN.ts, 100 to a package; 10% tests of some of them, mNNNNN.test.ts beside
// their module; and the 15% left Python modules py/src/scale/mNNNNN.py. Each language numbers its
// modules from 0, and a test has its module's number. NN has 2 digits and NNNNN 5, or more where
// n needs them.
//
// Each module:
// - imports 1 to 4 modules with lower numbers, in its own package or earlier ones (the first of
//   each language imports none): by a relative specifier in TypeScript, as scale.mNNNNN in
//   Python;
// - defines 3 to 6 exported functions, named from a small vocabulary that modules share, and one
//   class with two methods, each of which calls one of the module's functions;
// - calls 2 to 5 of the functions it imports, each once; it never imports a name twice, nor one
//   it defines;
// - about one in ten also imports an external module and calls it: node:fs, node:path, react or
//   zod in TypeScript, os, json or numpy in Python;
// - one in 200, the one numbered 199 modulo 200, also imports the module after it, which imports
//   it back, so the import graph has cycles; it takes at most 3 imports and 4 calls of its own
//   before that one, so it stays within the ranges above.
// A test imports vitest and its module, and calls two of its module's functions and a method.
//
// The history: 26 commits, one a week, written through git fast-import. Commit 1 adds every
// file. Commit k appends a comment line to each module and test whose number is congruent to k
// modulo 26.
//
// Determinism. Every choice comes from one mulberry32(0x5ca1e), drawn in a fixed order, and every
// date is fixed, so two runs with the same n write the same commits on any machine: git runs with
// no system or global config, no templates, HOME at a path that does not exist and an explicit -c
// for each setting this script relies on; the author and committer are
// Scale Author <scale@example.invalid>.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const USAGE =
  "usage: node fixtures/scale/generate.mjs --files <n> --out <dir>  (n at least 6; dir missing or empty)";
const MIN_FILES = 6;
const SEED = 0x5ca1e;
const AUTHOR = "Scale Author <scale@example.invalid>";
// Commit 1 at 2026-01-05 12:00 UTC, and each next one a week later.
const FIRST_COMMIT_TIME = Date.UTC(2026, 0, 5, 12) / 1000;
const WEEK = 7 * 86_400;
const COMMITS = 26;
const PACKAGE_SIZE = 100;
const CYCLE_EVERY = 200;
// The chance that a module imports an external module, and that an import stays near its
// importer: in its package in TypeScript, within the 100 modules before it in Python.
const EXTERNAL_CHANCE = 0.1;
const NEARBY_CHANCE = 0.6;

const GIT_CONFIG = [
  "-c",
  "init.defaultBranch=main",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.autocrlf=false",
  "-c",
  "gc.auto=0",
];
const GIT_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: "/nonexistent",
  LANG: "C",
  LC_ALL: "C",
  TZ: "UTC",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

// The vocabulary. A function is named by a verb and a noun (buildTable, build_table), a class by
// a noun and a role (TableStore), a method by one word.
const VERBS = [
  "build",
  "check",
  "count",
  "decode",
  "encode",
  "fetch",
  "filter",
  "format",
  "load",
  "merge",
  "parse",
  "render",
  "resolve",
  "scan",
  "sort",
  "update",
];
const NOUNS = [
  "batch",
  "cache",
  "edge",
  "event",
  "field",
  "frame",
  "graph",
  "index",
  "node",
  "packet",
  "query",
  "record",
  "shard",
  "table",
  "token",
  "window",
];
const ROLES = ["builder", "reader", "store", "writer"];
const METHODS = ["apply", "close", "flush", "open", "reset", "run", "step", "update"];
const FUNCTIONS = VERBS.length * NOUNS.length;
const CLASSES = NOUNS.length * ROLES.length;

// The external modules, each with its import line and a call of it.
const EXTERNALS = {
  ts: [
    { line: 'import { existsSync } from "node:fs";', call: 'existsSync("data") ? 1 : 0' },
    { line: 'import { join } from "node:path";', call: 'join("data", "part").length' },
    { line: 'import { createElement } from "react";', call: 'createElement("div") === null ? 0 : 1' },
    { line: 'import { z } from "zod";', call: "z.number().parse(total)" },
  ],
  py: [
    { line: "import os", call: 'len(os.path.join("data", "part"))' },
    { line: "import json", call: "len(json.dumps(total))" },
    { line: "import numpy as np", call: "int(np.sum(np.ones(3)))" },
  ],
};

class UsageError extends Error {}

// mulberry32: a 32-bit generator of numbers in [0, 1).
function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(SEED);
// A whole number in [0, n).
const below = (n) => Math.floor(random() * n);

const capital = (word) => word.charAt(0).toUpperCase() + word.slice(1);
const pad = (n, width) => String(n).padStart(width, "0");

function functionName(lang, f) {
  const verb = VERBS[Math.floor(f / NOUNS.length)];
  const noun = NOUNS[f % NOUNS.length];
  return lang === "ts" ? verb + capital(noun) : `${verb}_${noun}`;
}

const className = (c) =>
  capital(NOUNS[Math.floor(c / ROLES.length)]) + capital(ROLES[c % ROLES.length]);

// The modules of one language, count of them, in number order: what each imports (the target's
// number and the names it imports from it, in the order taken), its functions, its class and
// methods, and its external module (an index into EXTERNALS[lang]) or null.
function planModules(lang, count) {
  const modules = [];
  const opensCycle = (j) => j % CYCLE_EVERY === CYCLE_EVERY - 1 && j + 1 < count;
  // a lower number, often near j
  const nearby = (j) => {
    const start = lang === "ts" ? j - (j % PACKAGE_SIZE) : Math.max(0, j - PACKAGE_SIZE);
    if (start < j && random() < NEARBY_CHANCE) return start + below(j - start);
    return below(j);
  };
  for (let j = 0; j < count; j++) {
    const opens = opensCycle(j);
    // the module that opened a cycle just before this one, which this one imports first
    const closes = j > 0 && opensCycle(j - 1) ? modules[j - 1] : undefined;
    const imports = [];
    const imported = new Set();
    // imports one more name of target, one it does not import yet; false when none is left
    const take = (target) => {
      const free = modules[target].functions.filter((f) => !imported.has(f));
      if (free.length === 0) return false;
      const name = free[below(free.length)];
      imported.add(name);
      const found = imports.find((i) => i.target === target);
      if (found === undefined) imports.push({ target, names: [name] });
      else found.names.push(name);
      return true;
    };
    const targets = Math.min(j, 1 + below(opens ? 3 : 4));
    const calls = 2 + below(opens ? 3 : 4);
    if (closes !== undefined) take(j - 1);
    for (let tries = 0; imports.length < targets && tries < 64; tries++) {
      const target = nearby(j);
      if (!imports.some((i) => i.target === target)) take(target);
    }
    while (imported.size < calls) {
      const open = imports.filter((i) =>
        modules[i.target].functions.some((f) => !imported.has(f)),
      );
      if (open.length === 0) break;
      take(open[below(open.length)].target);
    }
    // Its own names: none it imports, and, after a module that opened a cycle, none that module
    // defines or imports, so that that module can import any of them back.
    const avoid = new Set(imported);
    if (closes !== undefined) {
      for (const f of [...closes.functions, ...closes.imported]) avoid.add(f);
    }
    const functions = [];
    const defines = 3 + below(4);
    while (functions.length < defines) {
      const f = below(FUNCTIONS);
      if (!avoid.has(f) && !functions.includes(f)) functions.push(f);
    }
    const cls = below(CLASSES);
    const methods = [];
    while (methods.length < 2) {
      const m = below(METHODS.length);
      if (!methods.includes(m)) methods.push(m);
    }
    if (closes !== undefined) {
      // the import back up the chain, which closes the cycle
      const name = functions[below(functions.length)];
      closes.imports.push({ target: j, names: [name] });
      closes.imported.add(name);
    }
    const external = random() < EXTERNAL_CHANCE ? below(EXTERNALS[lang].length) : null;
    modules.push({ number: j, imports, imported, functions, cls, methods, external });
  }
  return modules;
}

function generate(n, out) {
  // the three manifests, then 75%, 10% and the rest
  const rest = n - 3;
  const tsCount = Math.floor((rest * 3) / 4);
  const testCount = Math.floor(rest / 10);
  const pyCount = rest - tsCount - testCount;
  const packageWidth = Math.max(2, String(Math.ceil(tsCount / PACKAGE_SIZE) - 1).length);
  const moduleWidth = Math.max(5, String(Math.max(tsCount, pyCount) - 1).length);
  const ts = planModules("ts", tsCount);
  const py = planModules("py", pyCount);
  // the modules that have a test, spread evenly over the TypeScript ones
  const tested = new Set(
    Array.from({ length: testCount }, (_, i) => Math.floor((i * tsCount) / testCount)),
  );

  const moduleBase = (j) => `m${pad(j, moduleWidth)}`;
  const packageDir = (j) => `packages/p${pad(Math.floor(j / PACKAGE_SIZE), packageWidth)}`;
  const tsPath = (j) => `${packageDir(j)}/src/${moduleBase(j)}.ts`;
  const testPath = (j) => `${packageDir(j)}/src/${moduleBase(j)}.test.ts`;
  const pyPath = (j) => `py/src/scale/${moduleBase(j)}.py`;
  const specifier = (from, to) =>
    packageDir(from) === packageDir(to)
      ? `./${moduleBase(to)}`
      : `../../${packageDir(to).slice("packages/".length)}/src/${moduleBase(to)}`;
  const header = (j) => `Module ${j} of the scale fixture, a generated repository.`;

  function tsModule(m) {
    const name = (f) => functionName("ts", f);
    const lines = [`// ${header(m.number)}`];
    if (m.external !== null) lines.push(EXTERNALS.ts[m.external].line);
    for (const i of m.imports) {
      lines.push(`import { ${i.names.map(name).join(", ")} } from "${specifier(m.number, i.target)}";`);
    }
    lines.push("");
    const callees = m.imports.flatMap((i) => i.names);
    for (const [k, f] of m.functions.entries()) {
      lines.push(
        `// ${name(f)} adds to its value what each function it calls gives for the running total.`,
        `export function ${name(f)}(value: number): number {`,
        `  let total = value + ${k + 1};`,
      );
      if (k === 0 && m.external !== null) {
        lines.push(`  total += ${EXTERNALS.ts[m.external].call};`);
      }
      for (const [c, callee] of callees.entries()) {
        if (c % m.functions.length === k) lines.push(`  total += ${name(callee)}(total);`);
      }
      lines.push("  return total;", "}", "");
    }
    const cls = className(m.cls);
    lines.push(`// ${cls} counts the values it is given.`, `export class ${cls} {`, "  count = 0;");
    for (const [k, method] of m.methods.entries()) {
      lines.push(
        "",
        `  ${METHODS[method]}(value: number): number {`,
        "    this.count += 1;",
        `    return ${name(m.functions[k])}(value) + this.count;`,
        "  }",
      );
    }
    lines.push("}", "");
    return lines.join("\n");
  }

  function tsTest(m) {
    const [a, b] = m.functions.map((f) => functionName("ts", f));
    const cls = className(m.cls);
    return [
      `// Tests of module ${m.number} of the scale fixture, a generated repository.`,
      'import { expect, it } from "vitest";',
      `import { ${a}, ${b}, ${cls} } from "./${moduleBase(m.number)}";`,
      "",
      `it("${a} gives a number", () => {`,
      `  expect(typeof ${a}(1)).toBe("number");`,
      "});",
      "",
      `it("${b} gives a number", () => {`,
      `  expect(typeof ${b}(2)).toBe("number");`,
      "});",
      "",
      `it("${cls} counts", () => {`,
      `  const subject = new ${cls}();`,
      `  expect(typeof subject.${METHODS[m.methods[0]]}(3)).toBe("number");`,
      "});",
      "",
    ].join("\n");
  }

  function pyModule(m) {
    const name = (f) => functionName("py", f);
    const sections = [`"""${header(m.number)}"""`];
    const imports = [];
    if (m.external !== null) imports.push(EXTERNALS.py[m.external].line);
    if (m.external !== null && m.imports.length > 0) imports.push("");
    for (const i of m.imports) {
      imports.push(`from scale.${moduleBase(i.target)} import ${i.names.map(name).join(", ")}`);
    }
    if (imports.length > 0) sections.push(imports.join("\n"));
    const callees = m.imports.flatMap((i) => i.names);
    const blocks = m.functions.map((f, k) => {
      const lines = [
        `def ${name(f)}(value):`,
        '    """Adds to value what each function it calls gives for the running total."""',
        `    total = value + ${k + 1}`,
      ];
      if (k === 0 && m.external !== null) {
        lines.push(`    total += ${EXTERNALS.py[m.external].call}`);
      }
      for (const [c, callee] of callees.entries()) {
        if (c % m.functions.length === k) lines.push(`    total += ${name(callee)}(total)`);
      }
      lines.push("    return total");
      return lines.join("\n");
    });
    const cls = [`class ${className(m.cls)}:`, '    """Counts the values it is given."""', "", "    count = 0"];
    for (const [k, method] of m.methods.entries()) {
      cls.push(
        "",
        `    def ${METHODS[method]}(self, value):`,
        "        self.count += 1",
        `        return ${name(m.functions[k])}(value) + self.count`,
      );
    }
    blocks.push(cls.join("\n"));
    return `${sections.join("\n\n")}\n\n\n${blocks.join("\n\n\n")}\n`;
  }

  // Every file as commit 1 adds it, in a fixed order, with the module number of each module and
  // test, and the comment that starts a line in it.
  const files = [
    {
      path: "package.json",
      text: `${JSON.stringify(
        {
          name: "scale",
          version: "0.0.0",
          private: true,
          type: "module",
          bin: { scale: `${packageDir(0)}/dist/${moduleBase(0)}.js` },
          scripts: {
            start: `node ${packageDir(1)}/dist/${moduleBase(1)}.js`,
            test: "vitest run",
          },
        },
        null,
        2,
      )}\n`,
    },
    {
      path: "pyproject.toml",
      text: [
        "[project]",
        'name = "scale"',
        'version = "0.0.0"',
        'requires-python = ">=3.10"',
        "",
        "[project.scripts]",
        `scale-report = "scale.${moduleBase(0)}:${functionName("py", py[0].functions[0])}"`,
        "",
        "[tool.setuptools.packages.find]",
        'where = ["py/src"]',
        "",
      ].join("\n"),
    },
    {
      path: "py/src/scale/__init__.py",
      text: `"""The scale fixture's Python package, a generated repository."""\n`,
    },
  ];
  for (const m of ts) {
    files.push({ path: tsPath(m.number), text: tsModule(m), number: m.number, comment: "//" });
    if (tested.has(m.number)) {
      files.push({ path: testPath(m.number), text: tsTest(m), number: m.number, comment: "//" });
    }
  }
  for (const m of py) {
    files.push({ path: pyPath(m.number), text: pyModule(m), number: m.number, comment: "#" });
  }
  if (files.length !== n) throw new Error(`wrote ${files.length} files, not ${n}`);

  // The fast-import stream: data lengths are in bytes.
  const stream = [];
  const data = (text) => {
    stream.push(`data ${Buffer.byteLength(text)}\n`, text, "\n");
  };
  for (let k = 1; k <= COMMITS; k++) {
    const time = FIRST_COMMIT_TIME + (k - 1) * WEEK;
    stream.push(
      "commit refs/heads/main\n",
      `author ${AUTHOR} ${time} +0000\n`,
      `committer ${AUTHOR} ${time} +0000\n`,
    );
    data(k === 1 ? "Add the generated files\n" : `Touch the modules numbered ${k % COMMITS} modulo ${COMMITS}\n`);
    for (const file of files) {
      if (k === 1) {
        stream.push(`M 100644 inline ${file.path}\n`);
        data(file.text);
      } else if (file.number !== undefined && file.number % COMMITS === k % COMMITS) {
        stream.push(`M 100644 inline ${file.path}\n`);
        data(`${file.text}${file.comment} touched in commit ${k}\n`);
      }
    }
    stream.push("\n");
  }
  stream.push("done\n");

  git(out, ["init", "--quiet", "--template=", "."]);
  git(out, ["fast-import", "--quiet", "--done"], stream.join(""));
  // main checked out, into the index and the work tree
  git(out, ["checkout", "--quiet", "--force", "main"]);
  return git(out, ["rev-parse", "HEAD"]).trim();
}

// git in the repository, given input on its stdin when there is one; its standard output.
function git(cwd, args, input) {
  const r = spawnSync("git", [...GIT_CONFIG, ...args], {
    cwd,
    env: GIT_ENV,
    input,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  if (r.error !== undefined || r.status !== 0) {
    throw new Error(`git ${args[0]}: ${r.error?.message ?? r.stderr.trim()}`);
  }
  return r.stdout;
}

function commandLine(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: { files: { type: "string" }, out: { type: "string" } },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { files, out } = values;
  if (files === undefined) throw new UsageError("--files is required");
  const n = /^[0-9]+$/.test(files) ? Number(files) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < MIN_FILES) {
    throw new UsageError(`--files must be a whole number, at least ${MIN_FILES}`);
  }
  if (out === undefined || out === "") throw new UsageError("--out is required");
  return { n, out: resolve(out) };
}

// out made when it is missing; otherwise it must be an empty directory.
function prepareOut(out) {
  const stats = statSync(out, { throwIfNoEntry: false });
  if (stats === undefined) {
    mkdirSync(out, { recursive: true });
    return;
  }
  if (!stats.isDirectory()) throw new UsageError(`${out} is not a directory`);
  if (readdirSync(out).length > 0) throw new UsageError(`${out} is not empty`);
}

try {
  const { n, out } = commandLine(process.argv.slice(2));
  prepareOut(out);
  process.stdout.write(`${generate(n, out)}\n`);
} catch (error) {
  process.stderr.write(`generate.mjs: ${error instanceof Error ? error.message : String(error)}\n`);
  if (error instanceof UsageError) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
  } else {
    process.exitCode = 1;
  }
}
