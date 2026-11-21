// Checks an engines directory against the lock: its installed.json, each engine's bin, and,
// unless asked not to, the version each engine reports.
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Detail, EngineName } from "../model/index.js";
import { resolveBin } from "./dirs.js";
import { ENGINE_ORDER, type EngineEntry, readLock } from "./lock.js";

// <dir>/installed.json, written last by an install. python is the interpreter found at install
// time, which grimp is then run with; null when grimp was not installed.
export interface Installed {
  lockHash: string;
  installedAt: string;
  deep: boolean;
  python: string | null;
}

export interface EngineRow {
  engine: EngineName;
  version: string;
  minDetail: Detail;
  installed: boolean;
}

type InstalledRead =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "another lock" }
  | { kind: "ok"; installed: Installed };

// A --version run's limit. An engine answers in about a second; scip-typescript loads
// TypeScript first.
const VERSION_TIMEOUT_MS = 60_000;

// Prints grimp's version, from the directory given as the first argument before anything else
// on sys.path. Run with -I -S, so neither the environment nor any site-packages is read, and -B,
// so that nothing it imports writes bytecode into the engines directory.
const GRIMP_VERSION =
  'import sys; sys.path.insert(0, sys.argv[1]); import importlib.metadata as m; print(m.version("grimp"))';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The record when it is valid and made for this lock. The lock hash is compared before the
// other fields, so a record from another version of hakutaku reads as another lock. A path
// that is not a regular file (a FIFO, a directory) is never opened.
function loadInstalled(dir: string): InstalledRead {
  const path = join(dir, "installed.json");
  let value: unknown;
  try {
    if (!statSync(path).isFile()) return { kind: "invalid" };
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR"
      ? { kind: "missing" }
      : { kind: "invalid" };
  }
  if (!isRecord(value) || typeof value.lockHash !== "string") {
    return { kind: "invalid" };
  }
  if (value.lockHash !== readLock().hash) return { kind: "another lock" };
  const { installedAt, deep, python } = value;
  if (
    typeof installedAt !== "string" ||
    typeof deep !== "boolean" ||
    !(python === null || (typeof python === "string" && isAbsolute(python)))
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "ok",
    installed: { lockHash: value.lockHash, installedAt, deep, python },
  };
}

// <dir>/installed.json, or null when it is missing, not valid, or made for another lock.
export function readInstalled(dir: string): Installed | null {
  const read = loadInstalled(dir);
  return read.kind === "ok" ? read.installed : null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// What a --version run printed: the last word of its first non-empty line ("ast-grep 0.51.1"
// reads 0.51.1), or why it printed nothing.
function reported(r: SpawnSyncReturns<string>): string {
  if (r.error !== undefined) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") return "nothing (timed out)";
    return `nothing (cannot run it: ${code ?? r.error.message})`;
  }
  if (r.signal !== null) return `nothing (stopped by ${r.signal})`;
  if (r.status !== 0) return `nothing (exit code ${r.status})`;
  const line = r.stdout
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  return line?.split(/\s+/).pop() ?? "nothing";
}

// Runs an engine for its version from the engines directory, with an environment of its own:
// LANG, and a PATH holding only Node's directory.
function versionProblem(
  name: EngineName,
  expected: string,
  argv: [string, ...string[]],
  cwd: string,
): string | null {
  const [command, ...args] = argv;
  const r = spawnSync(command, args, {
    cwd,
    env: { LANG: "C.UTF-8", PATH: dirname(process.execPath) },
    encoding: "utf8",
    timeout: VERSION_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const got = reported(r);
  return got === expected
    ? null
    : `${name} reports ${got}, expected ${expected}`;
}

// The problem with one engine of a valid install, or null. grimp's bin is the python/ folder,
// and it needs the interpreter installed.json names. A Node engine runs as
// process.execPath <bin>; any other bin runs itself.
function engineProblem(
  dir: string,
  name: EngineName,
  entry: EngineEntry,
  installed: Installed,
  runVersions: boolean,
): string | null {
  const bin = resolveBin(dir, entry.bin);
  if (name === "grimp") {
    const python = installed.python;
    if (python === null || !isDirectory(bin)) return `grimp missing at ${bin}`;
    if (!isFile(python)) return `grimp missing at ${python}`;
    if (!runVersions) return null;
    return versionProblem(
      name,
      entry.version,
      [python, "-I", "-S", "-B", "-c", GRIMP_VERSION, bin],
      dir,
    );
  }
  if (!isFile(bin)) return `${name} missing at ${bin}`;
  if (!runVersions) return null;
  const argv: [string, ...string[]] = /\.[cm]?js$/.test(bin)
    ? [process.execPath, bin, "--version"]
    : [bin, "--version"];
  return versionProblem(name, entry.version, argv, dir);
}

// Problems, in the engines' order: "not installed" (no installed.json), "installed.json is not
// valid", "installed for another lock", "<engine> missing at <path>", and "<engine> reports
// <x>, expected <version>". grimp is checked only when the install found a Python, and
// scip-python only with deep. Extract passes runVersions: false.
export function verifyEngines(
  dir: string,
  opts: { deep?: boolean; runVersions?: boolean } = {},
): { ok: boolean; problems: string[] } {
  const read = loadInstalled(dir);
  const problems: string[] = [];
  if (read.kind === "missing") problems.push("not installed");
  else if (read.kind === "invalid")
    problems.push("installed.json is not valid");
  else if (read.kind === "another lock") {
    problems.push("installed for another lock");
  } else {
    const { lock } = readLock();
    for (const name of ENGINE_ORDER) {
      const entry = lock.engines[name];
      if (entry === undefined) continue;
      if (name === "scip-python" && opts.deep !== true) continue;
      if (name === "grimp" && read.installed.python === null) continue;
      const problem = engineProblem(
        dir,
        name,
        entry,
        read.installed,
        opts.runVersions ?? true,
      );
      if (problem !== null) problems.push(problem);
    }
  }
  return { ok: problems.length === 0, problems };
}

// Every engine of the lock, in order, and whether dir holds it for this lock. No engine is run.
export function listEngines(dir: string): EngineRow[] {
  const { lock } = readLock();
  const read = loadInstalled(dir);
  return ENGINE_ORDER.flatMap((name) => {
    const entry = lock.engines[name];
    if (entry === undefined) return [];
    const installed =
      read.kind === "ok" &&
      engineProblem(dir, name, entry, read.installed, false) === null;
    return [
      {
        engine: name,
        version: entry.version,
        minDetail: entry.minDetail,
        installed,
      },
    ];
  });
}
