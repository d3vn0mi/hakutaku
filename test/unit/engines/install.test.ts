// installEngines without the network: npm and python3 are stand-in scripts on a PATH that holds
// nothing else, which record how they were called.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  findOnPath,
  InstallNotConfirmed,
  installEngines,
  pythonSatisfies,
  readLock,
} from "../../../src/engines/index.js";
import { tmp, writeScript } from "./fake.js";

const savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
});

const RESOLVER = "; Python imports will come from hakutaku's resolver";
const PIP_ARGS = [
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

interface Stage {
  root: string; // holds bin/, log/ and the engines directory
  bin: string; // the only directory on PATH
  log: string; // what the stand-ins record
  dir: string; // the engines directory to install
}

// A stand-in npm: it records its directory and arguments, copies the two files it was given,
// and exits with code.
function stage(npmCode = 0): Stage {
  const root = tmp();
  const s = {
    root,
    bin: join(root, "bin"),
    log: join(root, "log"),
    dir: join(root, "engines"),
  };
  mkdirSync(s.bin);
  mkdirSync(s.log);
  writeScript(
    join(s.bin, "npm"),
    [
      `pwd -P > "${s.log}/npm-cwd"`,
      `printf '%s\\n' "$@" > "${s.log}/npm-args"`,
      `/bin/cp package.json package-lock.json "${s.log}/"`,
      npmCode === 0
        ? "exit 0"
        : `echo "npm error network" >&2; exit ${npmCode}`,
    ].join("\n"),
  );
  process.env.PATH = s.bin;
  return s;
}

interface FakePython {
  version: string; // what the probe reports
  pip?: boolean; // python3 -m pip --version succeeds; true by default
  install?: boolean; // pip install succeeds; true by default
  imports?: boolean; // the real interpreter imports grimp; true by default
}

// A stand-in python3 on PATH, and the real interpreter it names, under root/real/. The real one
// only answers the import check.
function fakePython(
  s: Stage,
  p: FakePython,
): { python3: string; real: string } {
  const real = writeScript(
    join(s.root, "real", "python3.12"),
    p.imports === false
      ? 'echo "ImportError: cannot import grimp" >&2; exit 1'
      : `printf '%s\\n' "$@" > "${s.log}/import-args"; exit 0`,
  );
  const pip =
    p.pip === false
      ? 'echo "No module named pip" >&2; exit 1'
      : 'echo "pip 24.0"; exit 0';
  const install =
    p.install === false
      ? 'echo "ERROR: No matching distribution found for grimp" >&2; exit 1'
      : "/bin/mkdir -p python/grimp; exit 0";
  const python3 = writeScript(
    join(s.bin, "python3"),
    [
      'case "$1" in',
      `  -I) echo '{"version": "${p.version}", "executable": "${real}"}' ;;`,
      "  -m)",
      `    if [ "$3" = "--version" ]; then ${pip}; fi`,
      `    pwd -P > "${s.log}/pip-cwd"`,
      `    printf '%s\\n' "$@" > "${s.log}/pip-args"`,
      `    /bin/cp requirements.txt "${s.log}/"`,
      `    ${install}`,
      "    ;;",
      "esac",
    ].join("\n"),
  );
  return { python3, real };
}

const lines = (path: string): string[] =>
  readFileSync(path, "utf8").split("\n").slice(0, -1);

async function install(s: Stage, deep = false): Promise<string[]> {
  const logged: string[] = [];
  await installEngines({
    dir: s.dir,
    deep,
    yes: true,
    log: (l) => logged.push(l),
  });
  return logged;
}

const installed = (s: Stage) =>
  JSON.parse(readFileSync(join(s.dir, "installed.json"), "utf8"));

it("refuses to install without confirmation and touches nothing", async () => {
  const parent = tmp();
  const dir = join(parent, "engines");
  await expect(
    installEngines({ dir, deep: false, yes: false }),
  ).rejects.toThrow(InstallNotConfirmed);
  expect(existsSync(dir)).toBe(false);
  expect(readdirSync(parent)).toEqual([]);
});

it("installs the npm engines from the lock with npm ci, and records no Python without python3", async () => {
  const { lock, hash } = readLock();
  const s = stage();
  const before = Date.now();
  expect(await install(s)).toEqual([
    `grimp not installed: no python3 on PATH${RESOLVER}`,
  ]);
  expect(lines(join(s.log, "npm-args"))).toEqual([
    "ci",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--omit=dev",
  ]);
  expect(lines(join(s.log, "npm-cwd"))).toEqual([
    join(realpathSync(s.root), `engines.tmp-${process.pid}`, "npm"),
  ]);
  expect(JSON.parse(readFileSync(join(s.log, "package.json"), "utf8"))).toEqual(
    lock.npm.packageJson,
  );
  expect(
    JSON.parse(readFileSync(join(s.log, "package-lock.json"), "utf8")),
  ).toEqual(lock.npm.packageLock);
  expect(readdirSync(s.dir).sort()).toEqual([
    "installed.json",
    "npm",
    "python",
  ]);
  expect(readdirSync(join(s.dir, "python"))).toEqual([]);
  const record = installed(s);
  expect(Object.keys(record)).toEqual([
    "lockHash",
    "installedAt",
    "deep",
    "python",
  ]);
  expect(record).toMatchObject({ lockHash: hash, deep: false, python: null });
  expect(Date.parse(record.installedAt)).toBeGreaterThanOrEqual(before - 1000);
  expect(Date.parse(record.installedAt)).toBeLessThanOrEqual(Date.now());
  expect(readdirSync(s.root).sort()).toEqual(["bin", "engines", "log"]);
});

it("installs the dev engines too with deep, with --include=dev in place of --omit=dev", async () => {
  const s = stage();
  await install(s, true);
  expect(lines(join(s.log, "npm-args"))).toEqual([
    "ci",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--include=dev",
  ]);
  expect(installed(s).deep).toBe(true);
});

it("skips grimp when python3 is outside the lock's Python range", async () => {
  const s = stage();
  const { python3 } = fakePython(s, { version: "3.9.18" });
  expect(await install(s)).toEqual([
    `grimp not installed: python3 at ${python3} is Python 3.9.18, outside ${readLock().lock.pip.python}${RESOLVER}`,
  ]);
  expect(installed(s).python).toBeNull();
  expect(existsSync(join(s.log, "pip-args"))).toBe(false);
});

it("skips grimp when python3 has no pip", async () => {
  const s = stage();
  const { python3 } = fakePython(s, { version: "3.12.3", pip: false });
  expect(await install(s)).toEqual([
    `grimp not installed: python3 at ${python3} has no pip${RESOLVER}`,
  ]);
  expect(installed(s).python).toBeNull();
  expect(existsSync(join(s.log, "pip-args"))).toBe(false);
});

it("skips grimp when python3 does not run", async () => {
  const s = stage();
  const python3 = writeScript(join(s.bin, "python3"), "exit 4");
  expect(await install(s)).toEqual([
    `grimp not installed: python3 at ${python3} did not run (exit code 4)${RESOLVER}`,
  ]);
  expect(installed(s).python).toBeNull();
});

it("installs grimp with pip from the hashed requirements, and records the interpreter's real path", async () => {
  const s = stage();
  const { real } = fakePython(s, { version: "3.12.3" });
  expect(await install(s)).toEqual([]);
  expect(lines(join(s.log, "pip-args"))).toEqual(PIP_ARGS);
  expect(lines(join(s.log, "pip-cwd"))).toEqual([
    join(realpathSync(s.root), `engines.tmp-${process.pid}`),
  ]);
  expect(readFileSync(join(s.log, "requirements.txt"), "utf8")).toBe(
    readLock().lock.pip.requirements,
  );
  const imported = lines(join(s.log, "import-args"));
  expect(imported.slice(0, 3)).toEqual(["-I", "-S", "-c"]);
  expect(imported[4]).toBe(
    join(s.root, `engines.tmp-${process.pid}`, "python"),
  );
  expect(installed(s).python).toBe(real);
  expect(readdirSync(s.dir).sort()).toEqual([
    "installed.json",
    "npm",
    "python",
  ]);
  expect(readdirSync(join(s.dir, "python"))).toEqual(["grimp"]);
});

it("skips grimp, and keeps nothing of it, when pip fails", async () => {
  const s = stage();
  fakePython(s, { version: "3.16.0", install: false });
  expect(await install(s)).toEqual([
    `grimp not installed: pip could not install it (ERROR: No matching distribution found for grimp)${RESOLVER}`,
  ]);
  expect(installed(s).python).toBeNull();
  expect(readdirSync(join(s.dir, "python"))).toEqual([]);
  expect(readdirSync(s.dir).sort()).toEqual([
    "installed.json",
    "npm",
    "python",
  ]);
});

it("skips grimp when the real interpreter cannot import it", async () => {
  const s = stage();
  const { real } = fakePython(s, { version: "3.12.3", imports: false });
  expect(await install(s)).toEqual([
    `grimp not installed: ${real} cannot import it (ImportError: cannot import grimp)${RESOLVER}`,
  ]);
  expect(installed(s).python).toBeNull();
  expect(readdirSync(join(s.dir, "python"))).toEqual([]);
});

it("keeps an existing install, and leaves no temporary directory, when npm fails", async () => {
  const s = stage(1);
  mkdirSync(s.dir);
  writeFileSync(join(s.dir, "kept"), "");
  const failure = installEngines({ dir: s.dir, deep: false, yes: true });
  await expect(failure).rejects.toThrow(/^npm ci exited with code 1:\n/);
  await expect(failure).rejects.toThrow(/npm error network/);
  expect(readdirSync(s.dir)).toEqual(["kept"]);
  expect(readdirSync(s.root).sort()).toEqual(["bin", "engines", "log"]);
});

it("fails when there is no npm on PATH, and leaves nothing", async () => {
  const s = stage();
  process.env.PATH = join(s.root, "log");
  await expect(
    installEngines({ dir: s.dir, deep: false, yes: true }),
  ).rejects.toThrow(/^cannot run npm: /);
  expect(readdirSync(s.root).sort()).toEqual(["bin", "log"]);
});

it("replaces an existing install, through a directory named for this process", async () => {
  const s = stage();
  mkdirSync(join(s.dir, "npm"), { recursive: true });
  writeFileSync(join(s.dir, "npm", "stale"), "");
  mkdirSync(`${s.dir}.tmp-${process.pid}`);
  writeFileSync(join(`${s.dir}.tmp-${process.pid}`, "left-by-a-crash"), "");
  await install(s);
  expect(readdirSync(s.dir).sort()).toEqual([
    "installed.json",
    "npm",
    "python",
  ]);
  expect(readdirSync(join(s.dir, "npm")).sort()).toEqual([
    "package-lock.json",
    "package.json",
  ]);
  expect(readdirSync(s.root).sort()).toEqual(["bin", "engines", "log"]);
});

it("installs into a directory named with a trailing slash, beside it and not inside it", async () => {
  const s = stage();
  const logged: string[] = [];
  await installEngines({
    dir: `${s.dir}/`,
    deep: false,
    yes: true,
    log: (l) => logged.push(l),
  });
  expect(lines(join(s.log, "npm-cwd"))).toEqual([
    join(realpathSync(s.root), `engines.tmp-${process.pid}`, "npm"),
  ]);
  expect(readdirSync(s.dir).sort()).toEqual([
    "installed.json",
    "npm",
    "python",
  ]);
});

it.each<[string, string, boolean]>([
  ["3.12.3", ">=3.10", true],
  ["3.10.0", ">=3.10", true],
  ["3.10", ">=3.10", true],
  ["3.9.18", ">=3.10", false],
  ["4.0.0", ">=3.10, <4", false],
  ["3.13.1", ">=3.10,<3.13", false],
  ["3.12.9", ">3.12", true],
  ["3.12.0", ">3.12", false],
  ["3.11.4", "==3.11.*", true],
  ["3.12.0", "==3.11.*", false],
  ["3.11.4", "!=3.11.*", false],
  ["3.10.2", "~=3.10", true],
  ["4.1", "~=3.10", false],
  ["3.10.0", "<=3.10", true],
  ["3.12.3", "!=3.12.3", false],
  ["3.12.3", "==3.12.3", true],
])("reads %s against %s as %s", (version, spec, want) =>
  expect(pythonSatisfies(version, spec)).toBe(want),
);

it("refuses a Python range it cannot read", () => {
  expect(() => pythonSatisfies("3.12.3", ">=3.10a1")).toThrow(
    "cannot read the Python range >=3.10a1",
  );
  expect(() => pythonSatisfies("3.12.3", ">=3.*")).toThrow(
    "cannot read the Python range >=3.*",
  );
});

it("finds the first executable file of the name on PATH, skipping relative entries", () => {
  const root = tmp();
  const a = join(root, "a");
  const b = join(root, "b");
  const c = join(root, "c");
  const d = join(root, "d");
  mkdirSync(join(a, "python3"), { recursive: true });
  mkdirSync(b);
  writeFileSync(join(b, "python3"), "");
  chmodSync(join(b, "python3"), 0o644);
  writeScript(join(c, "python3"), "exit 0");
  writeScript(join(d, "python3"), "exit 0");
  // The current directory holds a python3 for "" and ".", and rel/ one for "rel".
  writeScript(join(root, "python3"), "exit 0");
  writeScript(join(root, "rel", "python3"), "exit 0");
  const cwd = process.cwd();
  process.chdir(root);
  try {
    expect(findOnPath("python3", [a, b, "", ".", "rel", c, d].join(":"))).toBe(
      join(c, "python3"),
    );
    expect(findOnPath("python3", ["", ".", "rel"].join(":"))).toBeNull();
  } finally {
    process.chdir(cwd);
  }
  expect(findOnPath("python3", [a, b].join(":"))).toBeNull();
  expect(findOnPath("python3", undefined)).toBeNull();
  expect(findOnPath("python3", "")).toBeNull();
});
