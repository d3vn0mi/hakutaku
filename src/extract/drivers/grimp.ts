// The grimp driver: runs grimp from the engine lock, through hakutaku's Python driver
// (python/hakutaku_grimp_driver.py), over the packages under the profile's Python roots, and
// reads its answer: the modules it read, their imports with lines, the external modules they
// import, and the import chains that break the rules' layer contracts, all as dotted module
// names. The declared single-file modules are read beside the packages, parsed and never
// imported.
//
// grimp 3.18, as probed:
// - it finds each package by name on Python's path, and refuses one whose name finds a plain
//   module first (NotATopLevelModule), which stops the whole graph;
// - it walks each package's directory itself, following links, and reads every .py file there;
// - one file it cannot parse or decode stops the whole graph (SourceSyntaxError, UnicodeError);
// - an import of a submodule that does not exist lands on its nearest existing parent.
//
// So grimp never sees the snapshot itself. The driver builds a view of it in the work
// directory, holding the packages it reads and nothing else: each file the module index names
// under such a package, linked to its snapshot file, or an empty stand-in for a metadata-only
// file, so that no engine reads its content while imports of it still name it. A package is
// read when the module index gives its name to its own __init__.py, and neither the standard
// library nor grimp holds that name; any other is left out, and the build says so. Python's
// path then holds the view's roots and finds each package there, ahead of no other file of the
// snapshot.
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExportManifest } from "../../export/index.js";
import { pythonModuleIndex } from "../../manifests/index.js";
import {
  comparePaths,
  PYTHON_STDLIB,
  type Severity,
} from "../../model/index.js";
import type { Profile } from "../../profile/index.js";
import type { EngineDriver, ExtractContext } from "../context.js";
import { type EngineRunResult, engineEnv, runEngine } from "../run.js";

export interface GrimpImport {
  importer: string;
  imported: string;
  line: number;
}

export interface GrimpFacts {
  version: string;
  modules: Set<string>;
  imports: GrimpImport[];
  external: Set<string>;
  layerViolations: Array<{
    name: string;
    severity: Severity;
    importer: string;
    imported: string;
    chain: GrimpImport[];
  }>;
}

type LayerViolation = GrimpFacts["layerViolations"][number];

const TIMEOUT_MS = 600_000;
const DEEP_TIMEOUT_MS = 3_600_000;

const DRIVER = fileURLToPath(
  new URL("../../../python/hakutaku_grimp_driver.py", import.meta.url),
);

export const grimpDriver: EngineDriver<GrimpFacts> = {
  name: "grimp",
  minDetail: "quick",
  // grimp needs a Python and a package to read.
  applies: (ctx) =>
    ctx.pythonPath !== null &&
    selectInput(ctx.manifest, ctx.profile).packages.length > 0,
  run: runGrimp,
};

// One file of the view: a module the index names under a package grimp reads.
interface ViewFile {
  path: string; // the snapshot's path
  module: string;
  rootIndex: number; // the profile root it lies under
  relative: string; // its path below that root
  standIn: boolean; // metadata-only: an empty file takes its place
}

interface GrimpSelection {
  packages: Array<{ name: string; rootIndex: number }>; // in name order
  files: ViewFile[];
  singleFileModules: Array<{
    module: string;
    path: string;
    standIn: boolean;
  }>; // in name order
  leftOut: Array<{ dir: string; why: string }>; // in path order
}

// A name part Python can import, as pythonModuleIndex reads one.
const IDENTIFIER = /^[\p{XID_Start}_]\p{XID_Continue}*$/u;

// Names the standard library of a Python that grimp supports (3.10 on) may hold beyond
// PYTHON_STDLIB: the modules 3.11, 3.12 and 3.13 removed, and the test package, which
// sys.stdlib_module_names leaves out and some systems ship apart. The roots come after the
// standard library on Python's path, so such a name would find the standard library's module
// ahead of the snapshot's package on one machine and not on another; a package so named is
// left out on every machine, and so is one named grimp, which the engines' directory holds.
const OTHER_STDLIB: ReadonlySet<string> = new Set([
  "_crypt",
  "_msi",
  "aifc",
  "asynchat",
  "asyncore",
  "audioop",
  "binhex",
  "cgi",
  "cgitb",
  "chunk",
  "crypt",
  "distutils",
  "imghdr",
  "imp",
  "lib2to3",
  "mailcap",
  "msilib",
  "nis",
  "nntplib",
  "ossaudiodev",
  "pipes",
  "smtpd",
  "sndhdr",
  "spwd",
  "sunau",
  "telnetlib",
  "test",
  "uu",
  "xdrlib",
]);

// Why grimp cannot read a package of this name ahead of another module, or null.
function heldElsewhere(name: string): string | null {
  if (name === "grimp") return "grimp itself holds the name grimp";
  if (PYTHON_STDLIB.has(name) || OTHER_STDLIB.has(name)) {
    return `the standard library holds the name ${name}`;
  }
  return null;
}

// What grimp reads of a tree: the top-level packages under the profile's roots whose name the
// module index gives to their own __init__.py, the files the index names under them, and the
// declared single-file modules the index names by their stem. A package directly under a root
// whose name the index gives to another file, a module under an earlier root, is left out, and
// so is one whose name the standard library or grimp holds.
function selectInput(
  manifest: Pick<ExportManifest, "tree" | "metadataOnly">,
  profile: Pick<Profile, "python">,
): GrimpSelection {
  const roots = profile.python.roots;
  const regular = manifest.tree
    .filter((e) => e.mode === "100644" || e.mode === "100755")
    .map((e) => e.path);
  const index = pythonModuleIndex(
    regular,
    roots,
    profile.python.singleFileModules,
  );
  const metadataOnly = new Set(manifest.metadataOnly.map((m) => m.path));

  const chosen = new Map<string, { rootIndex: number; dir: string }>();
  const leftOut: GrimpSelection["leftOut"] = [];
  for (const path of regular) {
    if (posix.basename(path) !== "__init__.py") continue;
    const dir = posix.dirname(path);
    if (dir === ".") continue;
    const name = posix.basename(dir);
    const root = posix.dirname(dir);
    const rootIndex = roots.indexOf(root);
    // a directory directly under a root; one that is a root too holds an __init__.py that
    // names no module
    if (rootIndex < 0 || roots.includes(dir) || !IDENTIFIER.test(name)) {
      continue;
    }
    const holder = index.get(name);
    const why =
      heldElsewhere(name) ??
      (holder === path
        ? null
        : `${holder ?? "no file"} holds the name ${name} under the profile's roots`);
    if (why === null) chosen.set(name, { rootIndex, dir });
    else leftOut.push({ dir, why });
  }

  const files: ViewFile[] = [];
  for (const [module, path] of index) {
    const top = module.split(".")[0] ?? "";
    const pkg = chosen.get(top);
    if (pkg === undefined || !path.startsWith(`${pkg.dir}/`)) continue;
    const root = roots[pkg.rootIndex] ?? ".";
    files.push({
      path,
      module,
      rootIndex: pkg.rootIndex,
      relative: root === "." ? path : path.slice(root.length + 1),
      standIn: metadataOnly.has(path),
    });
  }

  const singles = new Map<string, string>();
  for (const path of profile.python.singleFileModules) {
    const module = posix.basename(path, ".py");
    if (index.get(module) === path) singles.set(module, path);
  }

  return {
    packages: [...chosen]
      .map(([name, { rootIndex }]) => ({ name, rootIndex }))
      .sort((a, b) => comparePaths(a.name, b.name)),
    files,
    singleFileModules: [...singles]
      .sort(([a], [b]) => comparePaths(a, b))
      .map(([module, path]) => ({
        module,
        path,
        standIn: metadataOnly.has(path),
      })),
    leftOut: leftOut.sort((a, b) => comparePaths(a.dir, b.dir)),
  };
}

async function runGrimp(ctx: ExtractContext): Promise<GrimpFacts> {
  const python = ctx.pythonPath;
  if (python === null) throw new Error("grimp failed: no Python to run it");
  const workDir = resolve(ctx.workDir);
  const snapshotDir = resolve(ctx.snapshotDir);
  const selected = selectInput(ctx.manifest, ctx.profile);
  for (const p of selected.leftOut) {
    ctx.log(
      `grimp: left out the package ${p.dir}: ${p.why}; hakutaku's resolver reads its imports`,
    );
  }

  // The view: <workDir>/grimp/roots/<root index>/ for the packages, and
  // <workDir>/grimp/single/ for the single-file modules, which are never on Python's path.
  const view = join(workDir, "grimp");
  rmSync(view, { recursive: true, force: true });
  const byView = new Map<string, { path: string; module: string }>();
  const place = (at: string, path: string, standIn: boolean): void => {
    mkdirSync(dirname(at), { recursive: true });
    if (standIn) writeFileSync(at, "");
    else symlinkSync(join(snapshotDir, path), at);
  };
  const rootDir = (rootIndex: number): string =>
    join(view, "roots", String(rootIndex));
  for (const f of selected.files) {
    const at = join(rootDir(f.rootIndex), f.relative);
    place(at, f.path, f.standIn);
    byView.set(at, f);
  }
  const singles = selected.singleFileModules.map((m) => {
    const at = join(view, "single", `${m.module}.py`);
    place(at, m.path, m.standIn);
    byView.set(at, m);
    return { module: m.module, file: at };
  });

  const input = {
    enginesPython: join(resolve(ctx.enginesDir), "python"),
    roots: [...new Set(selected.packages.map((p) => p.rootIndex))]
      .sort((a, b) => a - b)
      .map(rootDir),
    packages: selected.packages.map((p) => p.name),
    singleFileModules: singles,
    layers: (ctx.rules?.layers ?? []).map((l) => ({
      name: l.name,
      severity: l.severity,
      containers: l.containers ?? [],
      layers: l.layers,
    })),
  };
  const inputPath = join(workDir, "grimp-input.json");
  writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`);

  const timeoutMs = ctx.detail === "deep" ? DEEP_TIMEOUT_MS : TIMEOUT_MS;
  const out = join(workDir, "grimp.out.json");
  try {
    const result = await runEngine({
      engine: "grimp",
      // -I ignores every PYTHON* variable, PYTHONDONTWRITEBYTECODE among them: -B keeps
      // Python from writing bytecode next to grimp in the engines directory.
      argv: [python, "-I", "-S", "-B", DRIVER, inputPath],
      cwd: workDir,
      env: engineEnv(ctx, true),
      timeoutMs,
      stdoutFile: out,
    });
    const failure = failureOf(result, timeoutMs);
    if (failure !== null) throw new Error(`grimp failed: ${failure}`);
    let text: string;
    try {
      text = readFileSync(out, "utf8");
    } catch (error) {
      throw new Error(
        `grimp failed: cannot read its output (${messageOf(error)})`,
      );
    }
    const { facts, unreadable, warnings } = readOutput(text);

    // Stand-ins and files grimp could not read hold no imports it read.
    const unread = new Set(
      [...selected.files, ...selected.singleFileModules]
        .filter((f) => f.standIn)
        .map((f) => f.module),
    );
    const notRead = unreadable.map((u) => {
      const file = byView.get(u.file);
      if (file === undefined) {
        throw new Error(
          `grimp failed: it names a file it was not given: ${u.file}`,
        );
      }
      unread.add(file.module);
      return { path: file.path, reason: u.reason };
    });
    for (const u of notRead.sort((a, b) => comparePaths(a.path, b.path))) {
      ctx.log(
        `grimp: could not read ${u.path} (${u.reason}); hakutaku's resolver reads its imports`,
      );
    }
    for (const line of warnings) ctx.log(`grimp: ${line}`);
    return {
      ...facts,
      modules: new Set([...facts.modules].filter((m) => !unread.has(m))),
    };
  } finally {
    rmSync(out, { force: true });
  }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Why a run failed, or null. The driver prints an error's type and message on stderr and
// exits 3.
function failureOf(r: EngineRunResult, timeoutMs: number): string | null {
  const tail = r.stderrTail.trim();
  if (r.timedOut) {
    return `timed out after ${timeoutMs / 1000} s${tail === "" ? "" : `\n${tail}`}`;
  }
  if (r.exitCode === 0) return null;
  if (tail !== "") return tail;
  return r.signal !== null
    ? `stopped by ${r.signal}`
    : `exit code ${r.exitCode}`;
}

// The facts in the driver's JSON output, in comparePaths order whatever order it wrote them,
// each list without repeats.
export function parseGrimpOutput(json: string): GrimpFacts {
  return readOutput(json).facts;
}

const SEVERITIES: ReadonlySet<string> = new Set(["error", "warn", "info"]);

function readOutput(text: string): {
  facts: GrimpFacts;
  unreadable: Array<{ file: string; reason: string }>;
  warnings: string[];
} {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`grimp's output is not JSON (${messageOf(error)})`);
  }
  const fail = (where: string): never => {
    throw new Error(`grimp's output is not in its JSON shape: ${where}`);
  };
  if (!isRecord(json)) return fail("not an object");
  if (typeof json.grimp !== "string") return fail("grimp is not a string");
  const version = json.grimp;
  const modules = namesAt(json.modules, "modules", fail);
  if (!Array.isArray(json.imports)) return fail("imports is not an array");
  const imports = json.imports.map((i: unknown, n: number) =>
    importAt(i, `imports[${n}]`, fail),
  );
  const external = namesAt(json.external, "external", fail);
  if (!Array.isArray(json.layerViolations)) {
    return fail("layerViolations is not an array");
  }
  const layerViolations = json.layerViolations.map(
    (v: unknown, n: number): LayerViolation => {
      const at = `layerViolations[${n}]`;
      if (!isRecord(v)) return fail(`${at} is not an object`);
      if (typeof v.name !== "string") return fail(`${at}.name is not a string`);
      if (typeof v.severity !== "string" || !SEVERITIES.has(v.severity)) {
        return fail(`${at}.severity is not error, warn or info`);
      }
      const importer = moduleAt(v.importer, `${at}.importer`, fail);
      const imported = moduleAt(v.imported, `${at}.imported`, fail);
      if (!Array.isArray(v.chain) || v.chain.length === 0) {
        return fail(`${at}.chain is not a list of imports`);
      }
      return {
        name: v.name,
        severity: v.severity as Severity,
        importer,
        imported,
        chain: v.chain.map((step: unknown, j: number) =>
          importAt(step, `${at}.chain[${j}]`, fail),
        ),
      };
    },
  );
  const unreadable = json.unreadable;
  if (
    !Array.isArray(unreadable) ||
    !unreadable.every(
      (u: unknown) =>
        isRecord(u) &&
        typeof u.file === "string" &&
        typeof u.reason === "string",
    )
  ) {
    return fail("unreadable is not a list of files and reasons");
  }
  const warnings = json.warnings;
  if (
    !Array.isArray(warnings) ||
    !warnings.every((w: unknown) => typeof w === "string")
  ) {
    return fail("warnings is not a list of strings");
  }
  return {
    facts: {
      version,
      modules: new Set(modules.sort(comparePaths)),
      imports: unique(imports.sort(compareImports), compareImports),
      external: new Set(external.sort(comparePaths)),
      layerViolations: unique(
        layerViolations.sort(compareViolations),
        compareViolations,
      ),
    },
    unreadable: unreadable as Array<{ file: string; reason: string }>,
    warnings: warnings as string[],
  };
}

// A dotted module name: one or more parts, none empty.
const isModule = (v: unknown): v is string =>
  typeof v === "string" && v !== "" && v.split(".").every((p) => p !== "");

function moduleAt(v: unknown, at: string, fail: (w: string) => never): string {
  return isModule(v) ? v : fail(`${at} is not a module`);
}

function namesAt(v: unknown, at: string, fail: (w: string) => never): string[] {
  if (!Array.isArray(v)) return fail(`${at} is not an array`);
  return v.map((name: unknown, n: number) =>
    moduleAt(name, `${at}[${n}]`, fail),
  );
}

function importAt(
  v: unknown,
  at: string,
  fail: (w: string) => never,
): GrimpImport {
  if (!isRecord(v)) return fail(`${at} is not an object`);
  const importer = moduleAt(v.importer, `${at}.importer`, fail);
  const imported = moduleAt(v.imported, `${at}.imported`, fail);
  if (
    typeof v.line !== "number" ||
    !Number.isSafeInteger(v.line) ||
    v.line < 1
  ) {
    return fail(`${at}.line is not a line`);
  }
  return { importer, imported, line: v.line };
}

function compareImports(a: GrimpImport, b: GrimpImport): number {
  return (
    comparePaths(a.importer, b.importer) ||
    comparePaths(a.imported, b.imported) ||
    a.line - b.line
  );
}

function compareViolations(a: LayerViolation, b: LayerViolation): number {
  const byFields =
    comparePaths(a.name, b.name) ||
    comparePaths(a.severity, b.severity) ||
    comparePaths(a.importer, b.importer) ||
    comparePaths(a.imported, b.imported);
  if (byFields !== 0) return byFields;
  for (let i = 0; i < Math.min(a.chain.length, b.chain.length); i++) {
    const step = compareImports(
      a.chain[i] as GrimpImport,
      b.chain[i] as GrimpImport,
    );
    if (step !== 0) return step;
  }
  return a.chain.length - b.chain.length;
}

// A sorted list without the items equal to the one before.
function unique<T>(sorted: T[], compare: (a: T, b: T) => number): T[] {
  return sorted.filter(
    (item, i) => i === 0 || compare(sorted[i - 1] as T, item) !== 0,
  );
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
