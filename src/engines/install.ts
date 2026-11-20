// Installs the engines the lock pins: the one networked function in hakutaku. npm checks every
// integrity hash of the npm engines, and pip every sha256 of grimp's wheel.
import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { removeTree } from "../export/index.js";
import { type EngineLock, readLock } from "./lock.js";

// installEngines' answer to yes: false. It is thrown before anything is touched; the CLI asks.
export class InstallNotConfirmed extends Error {
  constructor() {
    super("the engine install was not confirmed");
    this.name = "InstallNotConfirmed";
  }
}

export interface InstallOptions {
  dir: string;
  deep: boolean; // scip-python too, the lock's one devDependency
  yes: boolean;
  log?: (line: string) => void; // warnings; process.stderr by default
}

// pip installs exactly the hashed wheels, into <dir>/python, from a binary only, and reads no
// configuration or environment variable of its own.
const PIP_INSTALL = [
  "-m",
  "pip",
  "install",
  "--isolated",
  "--disable-pip-version-check",
  "--no-input",
  "--only-binary=:all:",
  "--require-hashes",
  "--no-deps",
  "--target",
  "python",
  "-r",
  "requirements.txt",
];

// Prints the interpreter's version and its real path, read with -I, so no environment variable,
// user site or current directory can change the answer.
const PROBE =
  'import json, os, sys; e = sys.executable; print(json.dumps({"version": "%d.%d.%d" % tuple(sys.version_info[:3]), "executable": os.path.realpath(e) if e else None}))';

// Imports grimp from the directory given as the first argument, with no site-packages.
const IMPORT_GRIMP =
  "import sys; sys.path.insert(0, sys.argv[1]); import grimp";

const TAIL_CHARS = 64 * 1024;

interface Ran {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string; // the last 64 KiB
  stderr: string; // the last 64 KiB
  error: Error | null; // when the program could not be started
}

// Runs a program without a shell, with this process's environment, and keeps the end of its
// output.
function run(command: string, args: string[], cwd: string): Promise<Ran> {
  return new Promise((done) => {
    let settled = false;
    const finish = (r: Ran): void => {
      if (settled) return;
      settled = true;
      done(r);
    };
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8").on("data", (s: string) => {
      stdout = (stdout + s).slice(-TAIL_CHARS);
    });
    child.stderr.setEncoding("utf8").on("data", (s: string) => {
      stderr = (stderr + s).slice(-TAIL_CHARS);
    });
    child.on("error", (error) => {
      if (child.pid === undefined) {
        finish({ code: null, signal: null, stdout, stderr, error });
      }
    });
    child.on("close", (code, signal) =>
      finish({ code, signal, stdout, stderr, error: null }),
    );
  });
}

const succeeded = (r: Ran): boolean => r.error === null && r.code === 0;

// Why a run did not succeed, in a few words.
function how(r: Ran): string {
  if (r.error !== null) {
    const code = (r.error as NodeJS.ErrnoException).code;
    return `cannot run it: ${code ?? r.error.message}`;
  }
  if (r.signal !== null) return `stopped by ${r.signal}`;
  return `exit code ${r.code}`;
}

function lastLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .pop() ?? ""
  );
}

// "npm ci exited with code 1:" and the last lines npm wrote on stderr.
function failure(command: string, label: string, r: Ran): Error {
  let why: string;
  if (r.error !== null) why = `cannot run ${command}: ${r.error.message}`;
  else if (r.signal !== null) why = `${label} was stopped by ${r.signal}`;
  else why = `${label} exited with code ${r.code}`;
  const tail = r.stderr.trimEnd().split("\n").slice(-20).join("\n");
  return new Error(tail === "" ? why : `${why}:\n${tail}`);
}

// The first file called name, executable, in an absolute entry of path, as a shell finds a
// command. Relative and empty entries name the current directory, which may be anything, and
// are skipped.
export function findOnPath(
  name: string,
  path: string | undefined,
): string | null {
  for (const entry of (path ?? "").split(delimiter)) {
    if (!isAbsolute(entry)) continue;
    const candidate = join(entry, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not there, or not executable
    }
  }
  return null;
}

const CLAUSE = /^(~=|===|==|!=|<=|>=|<|>)\s*(\d+(?:\.\d+)*)(\.\*)?$/;

function numbers(version: string): number[] {
  return version.split(".").map(Number);
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Whether a release version ("3.12.3") meets a PEP 440 specifier set (">=3.10", ">=3.10,<4",
// "==3.11.*", "~=3.10"): every clause must hold. A clause it cannot read throws.
export function pythonSatisfies(version: string, spec: string): boolean {
  if (!/^\d+(?:\.\d+)*$/.test(version)) {
    throw new RangeError(`not a release version: ${version}`);
  }
  const v = numbers(version);
  const unreadable = (): never => {
    throw new RangeError(`cannot read the Python range ${spec}`);
  };
  return spec
    .split(",")
    .map((clause) => clause.trim())
    .filter((clause) => clause !== "")
    .every((clause) => {
      const m = CLAUSE.exec(clause);
      if (m === null) return unreadable();
      const [, op, number = "", star] = m;
      const w = numbers(number);
      if (star !== undefined) {
        if (op !== "==" && op !== "!=") return unreadable();
        const prefix = compare(v.slice(0, w.length), w) === 0;
        return op === "==" ? prefix : !prefix;
      }
      const c = compare(v, w);
      switch (op) {
        case ">=":
          return c >= 0;
        case ">":
          return c > 0;
        case "<=":
          return c <= 0;
        case "<":
          return c < 0;
        case "!=":
          return c !== 0;
        case "~=":
          // ~=X.Y means >=X.Y and ==X.*
          if (w.length < 2) return unreadable();
          return (
            c >= 0 && compare(v.slice(0, w.length - 1), w.slice(0, -1)) === 0
          );
        default:
          return c === 0;
      }
    });
}

function readProbe(
  stdout: string,
): { version: string; executable: string | null } | null {
  try {
    const value: unknown = JSON.parse(stdout);
    if (typeof value !== "object" || value === null) return null;
    const { version, executable } = value as Record<string, unknown>;
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
      return null;
    }
    if (executable === null) return { version, executable: null };
    if (typeof executable !== "string" || !isAbsolute(executable)) return null;
    return { version, executable };
  } catch {
    return null;
  }
}

// Installs grimp into <work>/python with the python3 found on PATH, and answers the
// interpreter's real path, which installed.json records. Without a suitable Python, or when pip
// or the import fails, it logs why, leaves python/ empty and answers null: Python imports then
// come from hakutaku's resolver.
async function installGrimp(
  work: string,
  lock: EngineLock,
  log: (line: string) => void,
): Promise<string | null> {
  const target = join(work, "python");
  mkdirSync(target);
  const skip = (reason: string): null => {
    removeTree(target);
    mkdirSync(target);
    log(
      `grimp not installed: ${reason}; Python imports will come from hakutaku's resolver`,
    );
    return null;
  };
  const python3 = findOnPath("python3", process.env.PATH);
  if (python3 === null) return skip("no python3 on PATH");
  const probe = await run(python3, ["-I", "-c", PROBE], work);
  if (!succeeded(probe)) {
    return skip(`python3 at ${python3} did not run (${how(probe)})`);
  }
  const found = readProbe(probe.stdout.trim());
  if (found === null) {
    return skip(`python3 at ${python3} did not report its version`);
  }
  if (found.executable === null) {
    return skip(`python3 at ${python3} did not name its interpreter`);
  }
  const range = lock.pip.python;
  if (!pythonSatisfies(found.version, range)) {
    return skip(
      `python3 at ${python3} is Python ${found.version}, outside ${range}`,
    );
  }
  if (!succeeded(await run(python3, ["-m", "pip", "--version"], work))) {
    return skip(`python3 at ${python3} has no pip`);
  }
  const requirements = join(work, "requirements.txt");
  writeFileSync(requirements, lock.pip.requirements);
  const pip = await run(python3, PIP_INSTALL, work);
  rmSync(requirements, { force: true });
  if (!succeeded(pip)) {
    return skip(
      `pip could not install it (${lastLine(pip.stderr) || how(pip)})`,
    );
  }
  const imported = await run(
    found.executable,
    ["-I", "-S", "-c", IMPORT_GRIMP, target],
    work,
  );
  if (!succeeded(imported)) {
    return skip(
      `${found.executable} cannot import it (${lastLine(imported.stderr) || how(imported)})`,
    );
  }
  return found.executable;
}

// Puts work in dir's place. A directory already at dir is moved aside first, put back if the
// second rename fails, and removed after.
function swapIn(work: string, dir: string): void {
  const old = `${dir}.old-${process.pid}`;
  removeTree(old);
  let moved = false;
  try {
    renameSync(dir, old);
    moved = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    renameSync(work, dir);
  } catch (error) {
    if (moved) renameSync(old, dir);
    throw error;
  }
  if (moved) removeTree(old);
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

// Installs into <dir>.tmp-<pid>/: npm/package.json and npm/package-lock.json from the lock, then
// npm ci --ignore-scripts --no-audit --no-fund with --omit=dev, or with --include=dev when deep
// (NODE_ENV=production omits dev by default, and would drop scip-python), then grimp with pip,
// then installed.json, last. The directory is then renamed to dir. On any failure the temporary
// directory is removed and dir is left as it was. yes: false rejects with InstallNotConfirmed
// before anything is touched.
export async function installEngines(opts: InstallOptions): Promise<void> {
  if (!opts.yes) throw new InstallNotConfirmed();
  const log =
    opts.log ??
    ((line: string) => {
      process.stderr.write(`${line}\n`);
    });
  const { lock, hash } = readLock();
  const dir = resolve(opts.dir);
  const work = `${dir}.tmp-${process.pid}`;
  mkdirSync(dirname(dir), { recursive: true });
  removeTree(work);
  mkdirSync(work);
  try {
    const npmDir = join(work, "npm");
    mkdirSync(npmDir);
    writeFileSync(join(npmDir, "package.json"), json(lock.npm.packageJson));
    writeFileSync(
      join(npmDir, "package-lock.json"),
      json(lock.npm.packageLock),
    );
    const npm = await run(
      "npm",
      [
        "ci",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        opts.deep ? "--include=dev" : "--omit=dev",
      ],
      npmDir,
    );
    if (!succeeded(npm)) throw failure("npm", "npm ci", npm);
    const python = await installGrimp(work, lock, log);
    writeFileSync(
      join(work, "installed.json"),
      json({
        lockHash: hash,
        installedAt: new Date().toISOString(),
        deep: opts.deep,
        python,
      }),
    );
    swapIn(work, dir);
  } catch (error) {
    removeTree(work);
    throw error;
  }
}
