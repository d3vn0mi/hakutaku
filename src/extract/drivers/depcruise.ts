// The dependency-cruiser driver: runs dependency-cruiser from the engine lock over the
// snapshot, with the export's generated depcruise.json and tsconfig.json, and reads its JSON
// into the files it cruised, their import edges, the rule violations and the files in cycles.
//
// dependency-cruiser 17.4.3, as probed:
// - it resolves its file argument against baseDir, so the snapshot is passed as ".";
// - it exits 0 with the JSON output type even when a rule of severity error is broken;
// - it splits a node:, file:, data: or bun: scheme off module into protocol (and data:'s
//   media type into mimeType), but leaves it on a scheme-only built-in such as node:test;
// - it lists every target as a module too, and marks the ones it did not cruise (built-ins,
//   names it could not resolve, data files, doNotFollow matches) followable: false;
// - it resolves a relative import that leaves the snapshot, whose source then starts "../",
//   and would open and cruise it, but depcruise.json's doNotFollow keeps it followable: false;
// - it reads ? in a request as a query, so ./orbit?2 resolves to orbit.ts beside orbit?2.ts;
// - it reports each cycle once, with its modules in cycle.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { readLock, resolveBin } from "../../engines/index.js";
import { comparePaths, type Severity } from "../../model/index.js";
import type { EngineDriver, ExtractContext } from "../context.js";
import {
  builtinOf,
  type External,
  externalOf,
  fileOrPackage,
  inNodeModules,
  isRelative,
  isRepoPath,
  resolveTsImport,
  type TsResolution,
} from "../resolve/ts.js";
import { type EngineRunResult, engineEnv, runEngine } from "../run.js";

export interface DepcruiseFacts {
  modules: Set<string>;
  edges: Array<{
    from: string;
    specifier: string;
    to: string | null;
    external: { ecosystem: "npm" | "node"; name: string } | null;
    typeOnly: boolean;
  }>;
  violations: Array<{
    rule: string;
    severity: Severity;
    from: string;
    to: string;
  }>;
  circular: Set<string>;
}

type Edge = DepcruiseFacts["edges"][number];
type Violation = DepcruiseFacts["violations"][number];

const TIMEOUT_MS = 600_000;
const DEEP_TIMEOUT_MS = 3_600_000;

// The rule depcruise.json adds to report every cycle; hakutaku applies the cycles severity
// itself.
const CYCLE_RULE = "hakutaku-cycle";

const SCRIPT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

// Directories TypeScript's include wildcard never enters, besides those named with a dot.
const UNLISTED_DIRECTORIES = new Set([
  "node_modules",
  "bower_components",
  "jspm_packages",
]);

// The dependency types of an import that is gone at run time: import type and export type,
// a type position's import("./x").T, and a triple-slash path or types reference.
const TYPE_LEVEL = new Set([
  "type-only",
  "type-import",
  "triple-slash-file-reference",
  "triple-slash-type-reference",
]);

const SEVERITIES: ReadonlySet<string> = new Set(["error", "warn", "info"]);

export const depcruiseDriver: EngineDriver<DepcruiseFacts> = {
  name: "dependency-cruiser",
  minDetail: "quick",
  // A TS or JS file the generated tsconfig's include lists: with none, TypeScript's parse of
  // that tsconfig stops dependency-cruiser on TS18003 ("No inputs were found").
  applies: (ctx) => {
    const skipped = new Set(ctx.manifest.metadataOnly.map((m) => m.path));
    return ctx.manifest.tree.some(
      (e) =>
        (e.mode === "100644" || e.mode === "100755") &&
        !skipped.has(e.path) &&
        listedByInclude(e.path),
    );
  },
  run: runDepcruise,
};

// Whether TypeScript's include, snapshot/**/*, lists a path with a TS or JS extension: its
// wildcards enter no directory named with a leading dot, node_modules, bower_components or
// jspm_packages, and take no file named with a leading dot or ending .min.js.
function listedByInclude(path: string): boolean {
  const directories = path.split("/");
  const name = directories.pop() ?? "";
  return (
    SCRIPT_EXTENSIONS.has(posix.extname(name)) &&
    !name.startsWith(".") &&
    !name.endsWith(".min.js") &&
    directories.every((d) => !d.startsWith(".") && !UNLISTED_DIRECTORIES.has(d))
  );
}

async function runDepcruise(ctx: ExtractContext): Promise<DepcruiseFacts> {
  const exportDir = resolve(ctx.exportDir);
  const workDir = resolve(ctx.workDir);
  // The run config adds the absolute paths the export could not write: baseDir, the
  // snapshot, and the generated tsconfig. --config is always passed, so no config of the
  // analysed repo, or of the working directory, is ever read.
  const runConfig = join(workDir, "depcruise.run.json");
  writeFileSync(
    runConfig,
    `${JSON.stringify(
      {
        extends: join(exportDir, "depcruise.json"),
        options: {
          baseDir: resolve(ctx.snapshotDir),
          tsConfig: { fileName: join(exportDir, "tsconfig.json") },
        },
      },
      null,
      2,
    )}\n`,
  );
  const bin = resolveBin(
    ctx.enginesDir,
    readLock().lock.engines["dependency-cruiser"].bin,
  );
  const timeoutMs = ctx.detail === "deep" ? DEEP_TIMEOUT_MS : TIMEOUT_MS;
  const out = join(workDir, "depcruise.out.json");
  try {
    const result = await runEngine({
      engine: "dependency-cruiser",
      argv: [
        process.execPath,
        bin,
        "--config",
        runConfig,
        "--output-type",
        "json",
        ".",
      ],
      cwd: workDir,
      env: engineEnv(ctx, false),
      timeoutMs,
      stdoutFile: out,
    });
    const failure = failureOf(result, timeoutMs);
    if (failure !== null)
      throw new Error(`dependency-cruiser failed: ${failure}`);
    let text: string;
    try {
      text = readFileSync(out, "utf8");
    } catch (error) {
      throw new Error(
        `dependency-cruiser failed: cannot read its output (${messageOf(error)})`,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `dependency-cruiser failed: its output is not JSON (${messageOf(error)})`,
      );
    }
    return parseDepcruise(json);
  } finally {
    rmSync(out, { force: true });
  }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Why a run failed, or null. Every non-zero exit is a failure, since a broken rule still
// exits 0 with the JSON output type.
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

// The facts in dependency-cruiser's JSON output, in path order whatever order it lists them.
// - modules: the repo files it cruised, never a target it only listed, a file under
//   node_modules, or a file outside the snapshot;
// - edges: one per dependency of those files, with hakutaku's own externals (never
//   dependency-cruiser's coreModule, so the store does not depend on the running Node);
// - violations: summary.violations without the cycle rule, each along a dependency on a
//   repo file;
// - circular: the modules of every cycle the cycle rule reports, when all are repo files.
export function parseDepcruise(json: unknown): DepcruiseFacts {
  const output = readOutput(json);
  const cruised = output.modules.filter(wasCruised);
  const modules = new Set(cruised.map((m) => m.source).sort(comparePaths));

  const edges = unique(
    cruised
      .flatMap((m) => m.dependencies.map((d) => edgeOf(m.source, d, modules)))
      .sort(compareEdges),
    compareEdges,
  );

  const fileEdges = new Set(
    edges.flatMap((e) => (e.to === null ? [] : [pairKey(e.from, e.to)])),
  );
  const found: Violation[] = [];
  const inCycles: string[] = [];
  for (const v of output.violations) {
    if (v.rule.name === CYCLE_RULE) {
      const names = [v.from, v.to, ...v.cycle];
      if (names.every((name) => modules.has(name))) inCycles.push(...names);
      continue;
    }
    if (!fileEdges.has(pairKey(v.from, v.to))) continue;
    found.push({
      rule: v.rule.name,
      severity: v.rule.severity,
      from: v.from,
      to: v.to,
    });
  }
  return {
    modules,
    edges,
    violations: unique(found.sort(compareViolations), compareViolations),
    circular: new Set([...new Set(inCycles)].sort(comparePaths)),
  };
}

function wasCruised(m: RawModule): boolean {
  return (
    m.followable !== false &&
    m.coreModule !== true &&
    m.couldNotResolve !== true &&
    isRepoPath(m.source) &&
    !inNodeModules(m.source)
  );
}

function edgeOf(
  from: string,
  d: RawDependency,
  modules: ReadonlySet<string>,
): Edge {
  const specifier = specifierOf(d);
  // the repo path the import names: its literal reading, when that is in question, else
  // the one dependency-cruiser resolved it to, or null
  const target =
    literalTarget(from, specifier, modules) ??
    (d.couldNotResolve || d.coreModule || !isRepoPath(d.resolved)
      ? null
      : d.resolved);
  let resolution: TsResolution;
  if (isRelative(specifier)) {
    resolution = target === null ? null : fileOrPackage(target);
  } else {
    resolution =
      builtinOf(specifier) ??
      (target === null ? null : fileOrPackage(target)) ??
      externalOf(specifier);
  }
  return {
    from,
    specifier,
    to: resolution !== null && "file" in resolution ? resolution.file : null,
    external:
      resolution !== null && "ecosystem" in resolution
        ? { ecosystem: resolution.ecosystem, name: resolution.name }
        : null,
    typeOnly: d.dependencyTypes.some((t) => TYPE_LEVEL.has(t)),
  };
}

// enhanced-resolve, inside dependency-cruiser, reads ? in a request as a query, so it answers
// orbit.ts for ./orbit?2 even beside orbit?2.ts (probed), and may read # as a fragment.
// TypeScript reads a specifier as written: a relative one holding ? or # takes the file its
// literal reading names among the cruised modules, when one does. Otherwise
// dependency-cruiser's answer stands, which is right for a bundler's "./logo.svg?url".
function literalTarget(
  from: string,
  specifier: string,
  modules: ReadonlySet<string>,
): string | null {
  if (!isRelative(specifier) || !/[?#]/.test(specifier)) return null;
  const literal = resolveTsImport(from, specifier, {
    paths: modules,
    aliases: {},
    workspaces: new Map(),
  });
  return literal !== null && "file" in literal ? literal.file : null;
}

// The specifier as the import wrote it: dependency-cruiser splits a scheme off module into
// protocol, and data:'s media type into mimeType, except where module keeps the scheme.
function specifierOf(d: RawDependency): string {
  if (d.protocol === undefined) return d.module;
  const rest = d.module.startsWith(d.protocol)
    ? d.module.slice(d.protocol.length)
    : d.module;
  const media = d.mimeType === undefined ? "" : `${d.mimeType},`;
  return `${d.protocol}${media}${rest}`;
}

const pairKey = (from: string, to: string): string =>
  JSON.stringify([from, to]);

function compareEdges(a: Edge, b: Edge): number {
  return (
    comparePaths(a.from, b.from) ||
    comparePaths(a.specifier, b.specifier) ||
    compareNullable(a.to, b.to) ||
    compareExternal(a.external, b.external) ||
    Number(a.typeOnly) - Number(b.typeOnly)
  );
}

function compareViolations(a: Violation, b: Violation): number {
  return (
    comparePaths(a.from, b.from) ||
    comparePaths(a.to, b.to) ||
    comparePaths(a.rule, b.rule) ||
    comparePaths(a.severity, b.severity)
  );
}

function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return comparePaths(a, b);
}

function compareExternal(a: External | null, b: External | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  return comparePaths(a.ecosystem, b.ecosystem) || comparePaths(a.name, b.name);
}

// A sorted list without the items equal to the one before.
function unique<T>(sorted: T[], compare: (a: T, b: T) => number): T[] {
  return sorted.filter(
    (item, i) => i === 0 || compare(sorted[i - 1] as T, item) !== 0,
  );
}

// The parts of dependency-cruiser's output the facts read, checked field by field.
interface RawDependency {
  module: string;
  protocol?: string;
  mimeType?: string;
  resolved: string;
  coreModule: boolean;
  couldNotResolve: boolean;
  dependencyTypes: string[];
}

interface RawModule {
  source: string;
  followable?: boolean;
  coreModule?: boolean;
  couldNotResolve?: boolean;
  dependencies: RawDependency[];
}

interface RawViolation {
  from: string;
  to: string;
  rule: { name: string; severity: Severity };
  cycle: string[];
}

function readOutput(json: unknown): {
  modules: RawModule[];
  violations: RawViolation[];
} {
  const fail = (where: string): never => {
    throw new Error(
      `dependency-cruiser's output is not in its JSON shape: ${where}`,
    );
  };
  if (!isRecord(json)) return fail("not an object");
  if (!Array.isArray(json.modules)) return fail("modules is not an array");
  if (!isRecord(json.summary)) return fail("summary is not an object");
  if (!Array.isArray(json.summary.violations)) {
    return fail("summary.violations is not an array");
  }
  const modules = json.modules.map((m: unknown, i: number): RawModule => {
    const at = `modules[${i}]`;
    if (!isRecord(m) || typeof m.source !== "string") {
      return fail(`${at}.source is not a string`);
    }
    for (const flag of ["followable", "coreModule", "couldNotResolve"]) {
      if (m[flag] !== undefined && typeof m[flag] !== "boolean") {
        fail(`${at}.${flag} is not a boolean`);
      }
    }
    if (!Array.isArray(m.dependencies)) {
      return fail(`${at}.dependencies is not an array`);
    }
    return {
      source: m.source,
      followable: m.followable as boolean | undefined,
      coreModule: m.coreModule as boolean | undefined,
      couldNotResolve: m.couldNotResolve as boolean | undefined,
      dependencies: m.dependencies.map((d: unknown, j: number) =>
        readDependency(d, `${at}.dependencies[${j}]`, fail),
      ),
    };
  });
  const violations = json.summary.violations.map(
    (v: unknown, i: number): RawViolation => {
      const at = `summary.violations[${i}]`;
      if (
        !isRecord(v) ||
        typeof v.from !== "string" ||
        typeof v.to !== "string"
      ) {
        return fail(`${at} has no from and to`);
      }
      const rule = v.rule;
      if (
        !isRecord(rule) ||
        typeof rule.name !== "string" ||
        typeof rule.severity !== "string" ||
        !SEVERITIES.has(rule.severity)
      ) {
        return fail(
          `${at}.rule is not a name and an error, warn or info severity`,
        );
      }
      // 17.x writes a cycle's modules as { name }; earlier majors wrote the names
      const cycle = v.cycle ?? [];
      if (!Array.isArray(cycle)) return fail(`${at}.cycle is not an array`);
      return {
        from: v.from,
        to: v.to,
        rule: { name: rule.name, severity: rule.severity as Severity },
        cycle: cycle.map((c: unknown, j: number) => {
          const name = isRecord(c) ? c.name : c;
          return typeof name === "string"
            ? name
            : fail(`${at}.cycle[${j}] names no module`);
        }),
      };
    },
  );
  return { modules, violations };
}

function readDependency(
  d: unknown,
  at: string,
  fail: (where: string) => never,
): RawDependency {
  if (!isRecord(d)) return fail(`${at} is not an object`);
  for (const field of ["module", "resolved"]) {
    if (typeof d[field] !== "string") fail(`${at}.${field} is not a string`);
  }
  for (const field of ["protocol", "mimeType"]) {
    if (d[field] !== undefined && typeof d[field] !== "string") {
      fail(`${at}.${field} is not a string`);
    }
  }
  for (const field of ["coreModule", "couldNotResolve"]) {
    if (typeof d[field] !== "boolean") fail(`${at}.${field} is not a boolean`);
  }
  if (
    !Array.isArray(d.dependencyTypes) ||
    !d.dependencyTypes.every((t: unknown) => typeof t === "string")
  ) {
    fail(`${at}.dependencyTypes is not a list of strings`);
  }
  return {
    module: d.module as string,
    protocol: d.protocol as string | undefined,
    mimeType: d.mimeType as string | undefined,
    resolved: d.resolved as string,
    coreModule: d.coreModule as boolean,
    couldNotResolve: d.couldNotResolve as boolean,
    dependencyTypes: d.dependencyTypes as string[],
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
