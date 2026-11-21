// The scale fixture's generator, fixtures/scale/generate.mjs, with git alone and no engine: the
// repository it writes is the same on every run, holds exactly the files asked for, in the
// layout and history it promises, with every import naming a module it wrote, and a bad command
// line exits 2 and writes nothing.
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { findSecrets } from "../../../src/redact/index.js";
import { git } from "../../helpers/git.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const GENERATE = join(ROOT, "fixtures", "scale", "generate.mjs");
const GENERATE_TIMEOUT = 120_000;
const WEEK = 7 * 86_400;

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A fresh, empty directory under the OS temp directory, removed after the last test.
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-scale-"));
  made.push(dir);
  return dir;
}

const tmpA = scratch();
const tmpB = scratch();
const tmpC = scratch();

// The generator run with these arguments.
function run(args: string[]) {
  return spawnSync(process.execPath, [GENERATE, ...args], {
    encoding: "utf8",
    timeout: GENERATE_TIMEOUT,
  });
}

// n files written at out: the commit it printed, which must be all it printed.
function gen(n: number, out: string): string {
  const r = run(["--files", String(n), "--out", out]);
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toMatch(/^[0-9a-f]{40}\n$/);
  return r.stdout.trim();
}

function status(args: string[]): number | null {
  return run(args).status;
}

it(
  "is deterministic and writes the requested number of files",
  () => {
    const a = gen(300, tmpA);
    const b = gen(300, tmpB);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    expect(a).toBe(b);
    expect(git(tmpA, "ls-files").trim().split("\n")).toHaveLength(300);
    expect(Number(git(tmpA, "rev-list", "--count", "HEAD").trim())).toBe(26);
    const files = git(tmpA, "ls-files");
    for (const re of [
      /\.test\.ts$/m,
      /\.py$/m,
      /^package\.json$/m,
      /^pyproject\.toml$/m,
    ]) {
      expect(files).toMatch(re);
    }
  },
  GENERATE_TIMEOUT,
);

it("refuses bad usage with exit 2", () => {
  for (const args of [[], ["--files", "0", "--out", tmpC], ["--files", "10"]]) {
    expect(status(args)).toBe(2);
  }
});

// The repository of 300 files written once more, for the tests below.
let repo = "";
let paths: string[] = [];
beforeAll(() => {
  repo = scratch();
  gen(300, repo);
  paths = git(repo, "ls-files").split("\n");
}, GENERATE_TIMEOUT);

const TS_MODULE = /^packages\/p(\d{2,})\/src\/m(\d{5,})\.ts$/;
const TS_TEST = /^packages\/p(\d{2,})\/src\/m(\d{5,})\.test\.ts$/;
const PY_MODULE = /^py\/src\/scale\/m(\d{5,})\.py$/;

// A module's number, read from its path; undefined for any other file.
function numberOf(path: string): number | undefined {
  const m = TS_MODULE.exec(path) ?? TS_TEST.exec(path);
  if (m !== null) return Number(m[2]);
  const py = PY_MODULE.exec(path);
  return py === null ? undefined : Number(py[1]);
}

const text = (path: string): string => readFileSync(join(repo, path), "utf8");

it("lays out three manifests, then 75% TypeScript modules, 10% their tests and 15% Python modules", () => {
  const ts = paths.filter((p) => TS_MODULE.test(p));
  const tests = paths.filter((p) => TS_TEST.test(p));
  const py = paths.filter((p) => PY_MODULE.test(p));
  // 297 files after the three: 222, 29 and the 46 left
  expect([ts.length, tests.length, py.length]).toEqual([222, 29, 46]);
  expect(
    paths.filter(
      (p) => !TS_MODULE.test(p) && !TS_TEST.test(p) && !PY_MODULE.test(p),
    ),
  ).toEqual(["package.json", "py/src/scale/__init__.py", "pyproject.toml"]);
  // each language numbers its modules from 0, and a package holds 100 of them
  expect(ts.map((p) => numberOf(p))).toEqual([...Array(222).keys()]);
  expect(py.map((p) => numberOf(p))).toEqual([...Array(46).keys()]);
  for (const p of ts) {
    const m = TS_MODULE.exec(p);
    expect(Number(m?.[1]), p).toBe(Math.floor(Number(m?.[2]) / 100));
  }
  // a test sits beside its module
  for (const p of tests) {
    expect(paths, p).toContain(p.replace(/\.test\.ts$/, ".ts"));
  }
  // checked out: the work tree holds what the index does
  expect(git(repo, "status", "--porcelain")).toBe("");
});

// One module's imports, definitions and calls, read from its text.
interface Parsed {
  imports: Array<{ target: number; names: string[] }>;
  externals: string[];
  functions: string[];
  classes: string[];
  methods: string[];
  calls: Map<string, number>; // each imported name, and the lines that call it
}

const TS_IMPORT = /^import \{ ([^}]+) \} from "([^"]+)";$/;
const PY_IMPORT = /^from scale\.(m\d+) import (.+)$/;
const PY_EXTERNAL = /^import (os|json|numpy as np)$/;

function parse(path: string): Parsed {
  const lines = text(path).split("\n");
  const ts = path.endsWith(".ts");
  const parsed: Parsed = {
    imports: [],
    externals: [],
    functions: [],
    classes: [],
    methods: [],
    calls: new Map(),
  };
  const body: string[] = [];
  for (const line of lines) {
    const tsImport = ts ? TS_IMPORT.exec(line) : null;
    const pyImport = ts ? null : PY_IMPORT.exec(line);
    const pyExternal = ts ? null : PY_EXTERNAL.exec(line);
    if (tsImport !== null) {
      const [, names = "", specifier = ""] = tsImport;
      if (!specifier.startsWith(".")) {
        parsed.externals.push(specifier);
        continue;
      }
      const target = posix.join(posix.dirname(path), `${specifier}.ts`);
      expect(paths, `${path} imports ${specifier}`).toContain(target);
      parsed.imports.push({
        target: numberOf(target) ?? -1,
        names: names.split(", "),
      });
    } else if (pyImport !== null) {
      const [, module = "", names = ""] = pyImport;
      const target = `py/src/scale/${module}.py`;
      expect(paths, `${path} imports scale.${module}`).toContain(target);
      parsed.imports.push({
        target: numberOf(target) ?? -1,
        names: names.split(", "),
      });
    } else if (pyExternal !== null) {
      parsed.externals.push((pyExternal[1] ?? "").split(" ")[0] ?? "");
    } else {
      body.push(line);
      const def = ts
        ? /^export function (\w+)\(/.exec(line)
        : /^def (\w+)\(/.exec(line);
      if (def !== null) parsed.functions.push(def[1] ?? "");
      const cls = ts
        ? /^export class (\w+) \{$/.exec(line)
        : /^class (\w+):$/.exec(line);
      if (cls !== null) parsed.classes.push(cls[1] ?? "");
      const method = ts
        ? /^ {2}(\w+)\(value: number\): number \{$/.exec(line)
        : /^ {4}def (\w+)\(self, value\):$/.exec(line);
      if (method !== null) parsed.methods.push(method[1] ?? "");
    }
  }
  for (const name of parsed.imports.flatMap((i) => i.names)) {
    const call = new RegExp(`\\b${name}\\(`);
    parsed.calls.set(name, body.filter((line) => call.test(line)).length);
  }
  return parsed;
}

it("gives each module 1 to 4 imports of lower-numbered modules, 3 to 6 functions, one class with two methods, and 2 to 5 calls of what it imports", () => {
  for (const pattern of [TS_MODULE, PY_MODULE]) {
    const modules = paths.filter((p) => pattern.test(p));
    for (const [j, path] of modules.entries()) {
      const m = parse(path);
      const backEdge = j % 200 === 199 && j + 1 < modules.length;
      expect(m.functions.length, path).toBeGreaterThanOrEqual(3);
      expect(m.functions.length, path).toBeLessThanOrEqual(6);
      expect(m.classes, path).toHaveLength(1);
      expect(new Set(m.methods).size, path).toBe(2);
      expect(m.methods, path).toHaveLength(2);
      const names = m.imports.flatMap((i) => i.names);
      // no name is imported twice, or imported and defined
      expect(new Set([...names, ...m.functions]).size, path).toBe(
        names.length + m.functions.length,
      );
      for (const [name, lines] of m.calls) {
        expect(lines, `${path} calls ${name}`).toBe(1);
      }
      if (j === 0) {
        expect(m.imports, path).toEqual([]);
        continue;
      }
      expect(m.imports.length, path).toBeGreaterThanOrEqual(1);
      expect(m.imports.length, path).toBeLessThanOrEqual(4);
      expect(names.length, path).toBeGreaterThanOrEqual(2);
      expect(names.length, path).toBeLessThanOrEqual(5);
      const targets = m.imports.map((i) => i.target);
      expect(new Set(targets).size, path).toBe(targets.length);
      for (const t of targets) {
        if (backEdge && t === j + 1) continue;
        expect(t, path).toBeLessThan(j);
      }
    }
  }
});

it("closes an import cycle at one module in 200, the one numbered 199 modulo 200", () => {
  const importsOf = (path: string): number[] =>
    parse(path).imports.map((i) => i.target);
  expect(importsOf("packages/p01/src/m00199.ts")).toContain(200);
  expect(importsOf("packages/p02/src/m00200.ts")).toContain(199);
  // no other module imports a higher number
  for (const pattern of [TS_MODULE, PY_MODULE]) {
    for (const path of paths.filter((p) => pattern.test(p))) {
      const n = numberOf(path) ?? -1;
      if (n === 199) continue;
      for (const t of importsOf(path)) expect(t, path).toBeLessThan(n);
    }
  }
});

it("has about one module in ten import one external module of its language, and call it", () => {
  const ts = paths
    .filter((p) => TS_MODULE.test(p))
    .flatMap((p) => parse(p).externals);
  const py = paths
    .filter((p) => PY_MODULE.test(p))
    .flatMap((p) => parse(p).externals);
  for (const e of ts)
    expect(["node:fs", "node:path", "react", "zod"]).toContain(e);
  for (const e of py) expect(["os", "json", "numpy"]).toContain(e);
  // 268 modules, each importing one with a chance of 1 in 10
  expect(ts.length + py.length).toBeGreaterThanOrEqual(13);
  expect(ts.length + py.length).toBeLessThanOrEqual(54);
  for (const path of paths.filter((p) => TS_MODULE.test(p))) {
    const t = text(path);
    for (const [module, call] of [
      ["node:fs", "existsSync("],
      ["node:path", "join("],
      ["react", "createElement("],
      ["zod", "z.number()"],
    ] as const) {
      if (t.includes(`from "${module}"`)) expect(t, path).toContain(call);
    }
  }
});

it("tests two functions and a method of its module, through vitest", () => {
  for (const path of paths.filter((p) => TS_TEST.test(p))) {
    const t = text(path);
    const module = parse(path.replace(/\.test\.ts$/, ".ts"));
    expect(t, path).toContain('import { expect, it } from "vitest";');
    const [first = "", second = ""] = module.functions;
    expect(t, path).toContain(
      `import { ${first}, ${second}, ${module.classes[0]} } from "./${posix.basename(path, ".test.ts")}";`,
    );
    expect(t, path).toContain(`${first}(1)`);
    expect(t, path).toContain(`${second}(2)`);
    expect(t, path).toContain(`.${module.methods[0]}(3)`);
  }
});

it("names in its manifests only files and a function it wrote", () => {
  const manifest = JSON.parse(text("package.json"));
  expect(Object.keys(manifest.bin)).toHaveLength(1);
  expect(Object.keys(manifest.scripts)).toHaveLength(2);
  // a built path, whose source is the module of the same name under src/
  const built = (p: string): string =>
    p.replace("/dist/", "/src/").replace(/\.js$/, ".ts");
  for (const target of Object.values<string>(manifest.bin)) {
    expect(paths).toContain(built(target));
  }
  const started = /^node (\S+)$/.exec(manifest.scripts.start)?.[1] ?? "";
  expect(paths).toContain(built(started));
  const pyproject = text("pyproject.toml");
  const script = /^\[project\.scripts\]\n[\w-]+ = "scale\.(m\d+):(\w+)"$/m.exec(
    pyproject,
  );
  expect(script, pyproject).not.toBeNull();
  const [, module = "", fn = ""] = script ?? [];
  expect(parse(`py/src/scale/${module}.py`).functions).toContain(fn);
});

it("writes 26 commits a week apart by Scale Author, each after the first appending a comment line to the files numbered k modulo 26", () => {
  const log = git(
    repo,
    "log",
    "--reverse",
    "--format=@@%an <%ae>|%cn <%ce>|%at|%ct",
    "--numstat",
  );
  const commits = log
    .split("@@")
    .slice(1)
    .map((chunk) => {
      const [head = "", ...rest] = chunk.trim().split("\n");
      const [author, committer, at, ct] = head.split("|");
      return {
        author,
        committer,
        at: Number(at),
        ct: Number(ct),
        stats: rest.filter((l) => l !== "").map((l) => l.split("\t")),
      };
    });
  expect(commits).toHaveLength(26);
  for (const [i, c] of commits.entries()) {
    expect(c.author).toBe("Scale Author <scale@example.invalid>");
    expect(c.committer).toBe("Scale Author <scale@example.invalid>");
    expect(c.at).toBe(c.ct);
    if (i > 0) expect(c.ct - (commits[i - 1]?.ct ?? 0)).toBe(WEEK);
  }
  expect(commits[0]?.stats.map((s) => s[2]).sort()).toEqual([...paths].sort());
  for (let k = 2; k <= 26; k++) {
    const stats = commits[k - 1]?.stats ?? [];
    const touched = paths.filter((p) => {
      const n = numberOf(p);
      return n !== undefined && n % 26 === k % 26;
    });
    expect(stats.map((s) => s[2]).sort(), `commit ${k}`).toEqual(
      [...touched].sort(),
    );
    for (const [added, deleted, path] of stats) {
      expect([added, deleted], `${path} in commit ${k}`).toEqual(["1", "0"]);
      const last = text(path ?? "")
        .trimEnd()
        .split("\n")
        .at(-1);
      expect(last, path).toMatch(path?.endsWith(".py") ? /^# / : /^\/\/ /);
    }
  }
});

it("writes no secret-shaped text", () => {
  for (const path of paths) {
    expect(findSecrets(text(path)), path).toEqual([]);
  }
});

it("refuses a bad command line with exit 2, names the usage, and writes nothing", () => {
  const out = scratch();
  const full = scratch();
  writeFileSync(join(full, "keep"), "");
  const file = join(scratch(), "a-file");
  writeFileSync(file, "");
  for (const args of [
    ["--files", "300", "--out", out, "--seed", "1"],
    ["--files", "300", "--out", out, "extra"],
    ["--files", "-3", "--out", out],
    ["--files", "1.5", "--out", out],
    ["--files", "ten", "--out", out],
    ["--files", "", "--out", out],
    ["--files", "5", "--out", out],
    ["--out", out],
    ["--files", "300", "--out", ""],
    ["--files", "300", "--out", full],
    ["--files", "300", "--out", file],
  ]) {
    const r = run(args);
    expect(r.status, args.join(" ")).toBe(2);
    expect(r.stdout, args.join(" ")).toBe("");
    expect(r.stderr, args.join(" ")).toContain(
      "usage: node fixtures/scale/generate.mjs --files <n> --out <dir>",
    );
  }
  expect(readdirSync(out)).toEqual([]);
  expect(readdirSync(full)).toEqual(["keep"]);
  // the smallest repository it writes: the three manifests, two TypeScript modules and one
  // Python module, each named by a manifest
  const smallest = scratch();
  gen(6, smallest);
  expect(git(smallest, "ls-files").split("\n")).toEqual([
    "package.json",
    "packages/p00/src/m00000.ts",
    "packages/p00/src/m00001.ts",
    "py/src/scale/__init__.py",
    "py/src/scale/m00000.py",
    "pyproject.toml",
  ]);
});
