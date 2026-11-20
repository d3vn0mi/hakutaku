import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, expect, it } from "vitest";
import {
  type EngineRun,
  engineEnv,
  runEngine,
} from "../../../src/extract/run.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A fresh directory under the OS temp directory, removed after the file's last test.
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-run-"));
  made.push(dir);
  return dir;
};

const dir = tmp();
const h = join(dir, "home");
const p = join(dir, "bin");
const t = join(dir, "tmp");
const MIB_64 = 64 * 1024 * 1024;
const PYTHON = "/opt/python/bin/python3.12";

// Each run is `node -e <script>`, with argv[0] process.execPath.
const run = (script: string, patch: Partial<EngineRun> = {}): EngineRun => ({
  engine: "ast-grep",
  argv: [process.execPath, "-e", script],
  cwd: dir,
  env: { HOME: h, LANG: "C.UTF-8", PATH: p, TMPDIR: t },
  timeoutMs: 30_000,
  ...patch,
});

it("passes exactly the env it is given", async () => {
  const r = await runEngine(
    run("console.log(Object.keys(process.env).sort().join(','))", {
      env: { HOME: h, LANG: "C.UTF-8", PATH: p, TMPDIR: t },
    }),
  );
  expect(r.stdout.trim()).toBe("HOME,LANG,PATH,TMPDIR");
});

it("kills a run that passes its timeout", async () => {
  const r = await runEngine(
    run("setTimeout(() => {}, 60000)", { timeoutMs: 500 }),
  );
  expect(r.timedOut).toBe(true);
  expect(r.signal).toBe("SIGKILL");
  expect(r.wallMs).toBeLessThan(5000);
  expect(r.exitCode).toBeNull();
});

it("keeps the last 4 KiB of stderr and writes stdout to a file when asked", async () => {
  // 700 lines of 8 bytes and 699 line ends: 6,299 bytes, all ASCII
  const said = Array.from(
    { length: 700 },
    (_, i) => `sky ${String(i).padStart(4, "0")}`,
  ).join("\n");
  const file = join(tmp(), "orbit.out");
  const r = await runEngine(
    run(
      `process.stderr.write(${JSON.stringify(said)}); process.stdout.write("orbit ".repeat(1000));`,
      { stdoutFile: file },
    ),
  );
  expect(r.exitCode).toBe(0);
  expect(r.stderrTail).toBe(said.slice(-4096));
  expect(r.stdout).toBe("");
  expect(readFileSync(file, "utf8")).toBe("orbit ".repeat(1000));
});

it("reports peak memory on Linux and calls onSpawn with the pid", async () => {
  const seen: number[] = [];
  // the engine fills 64 MiB and spins for 300 ms, then lives 300 ms more
  const r = await runEngine(
    run(
      "const b = Buffer.alloc(64 * 1024 * 1024, 1); const end = Date.now() + 300; while (Date.now() < end); setTimeout(() => console.log(process.pid, b.length), 300)",
      { onSpawn: (pid) => seen.push(pid) },
    ),
  );
  expect(seen).toEqual([Number(r.stdout.split(" ")[0])]);
  if (process.platform === "linux") {
    expect(r.peakRssBytes).toBeGreaterThanOrEqual(MIB_64);
    expect(r.cpuMs).toBeGreaterThan(0);
  } else {
    expect(r.peakRssBytes).toBeNull();
    expect(r.cpuMs).toBeNull();
  }
});

it("runs in its cwd at nice 19, and reports stdout and the exit code", async () => {
  const cwd = join(tmp(), "cwd");
  mkdirSync(cwd);
  const r = await runEngine(
    run(
      'setTimeout(() => { console.log(process.cwd(), require("node:os").getPriority()); process.exit(3); }, 100)',
      { cwd },
    ),
  );
  expect(r).toMatchObject({
    exitCode: 3,
    signal: null,
    timedOut: false,
    stdout: `${realpathSync(cwd)} 19\n`,
    stderrTail: "",
  });
});

it("keeps a stdout of exactly 64 MiB", async () => {
  const r = await runEngine(
    run(`process.stdout.write(Buffer.alloc(${MIB_64}, "a"))`),
  );
  expect(r.exitCode).toBe(0);
  expect(r.stdout.length).toBe(MIB_64);
  expect(r.stdout.startsWith("aaaa") && r.stdout.endsWith("aaaa")).toBe(true);
});

it("fails a run that writes more than 64 MiB to stdout, and stops it", async () => {
  let pid = 0;
  await expect(
    runEngine(
      run(
        `process.stdout.write(Buffer.alloc(${MIB_64 + 1}, "a")); setTimeout(() => {}, 60000);`,
        { onSpawn: (spawned) => (pid = spawned) },
      ),
    ),
  ).rejects.toThrow("ast-grep: stdout passed 64 MiB; the run was stopped");
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow(); // ESRCH: stopped and reaped
});

it("rejects a run whose program cannot be started, without calling onSpawn", async () => {
  const seen: number[] = [];
  const missing = join(dir, "missing-engine");
  await expect(
    runEngine(run("", { argv: [missing], onSpawn: (pid) => seen.push(pid) })),
  ).rejects.toThrow(`ast-grep: cannot run ${missing}: ENOENT`);
  expect(seen).toEqual([]);
});

it("starts the stderr tail at a whole character", async () => {
  // 5,001 bytes: the last 4,096 start on the second byte of the 453rd é
  const said = `${"é".repeat(2500)}!`;
  const r = await runEngine(
    run(`process.stderr.write(${JSON.stringify(said)})`),
  );
  expect(r.stderrTail).toBe(`${"é".repeat(2047)}!`);
});

it("makes bin, home and tmp in the work directory, and an env of exactly those", () => {
  const work = join(tmp(), "work.tmp-1");
  const env = engineEnv({ workDir: work, pythonPath: null }, false);
  expect(env).toEqual({
    PATH: join(work, "bin"),
    HOME: join(work, "home"),
    LANG: "C.UTF-8",
    TMPDIR: join(work, "tmp"),
  });
  expect(Object.keys(env)).toEqual(["PATH", "HOME", "LANG", "TMPDIR"]);
  expect(readdirSync(join(work, "bin"))).toEqual(["node"]);
  expect(readlinkSync(join(work, "bin", "node"))).toBe(process.execPath);
  expect(readdirSync(join(work, "home"))).toEqual([]);
  expect(readdirSync(join(work, "tmp"))).toEqual([]);
});

it("links python and python3 to the pinned interpreter, and adds the Python variables when asked", () => {
  const work = join(tmp(), "work.tmp-1");
  const env = engineEnv({ workDir: work, pythonPath: PYTHON }, true);
  expect(Object.entries(env)).toEqual([
    ["PATH", join(work, "bin")],
    ["HOME", join(work, "home")],
    ["LANG", "C.UTF-8"],
    ["TMPDIR", join(work, "tmp")],
    ["PYTHONNOUSERSITE", "1"],
    ["PYTHONDONTWRITEBYTECODE", "1"],
  ]);
  expect(readdirSync(join(work, "bin")).sort()).toEqual([
    "node",
    "python",
    "python3",
  ]);
  expect(readlinkSync(join(work, "bin", "python"))).toBe(PYTHON);
  expect(readlinkSync(join(work, "bin", "python3"))).toBe(PYTHON);
  // without python, a fresh work directory gets the links all the same, but not the variables
  const other = join(tmp(), "work.tmp-2");
  expect(
    Object.keys(engineEnv({ workDir: other, pythonPath: PYTHON }, false)),
  ).toEqual(["PATH", "HOME", "LANG", "TMPDIR"]);
  expect(readdirSync(join(other, "bin")).sort()).toEqual([
    "node",
    "python",
    "python3",
  ]);
});

it("can be made again in the same work directory, re-pointing a link that names another target", () => {
  const work = join(tmp(), "work.tmp-1");
  engineEnv({ workDir: work, pythonPath: "/opt/python/bin/python3.11" }, true);
  engineEnv({ workDir: work, pythonPath: PYTHON }, true);
  expect(readlinkSync(join(work, "bin", "python"))).toBe(PYTHON);
  expect(readlinkSync(join(work, "bin", "python3"))).toBe(PYTHON);
  expect(readlinkSync(join(work, "bin", "node"))).toBe(process.execPath);
});

it("gives absolute paths for a relative work directory", () => {
  const work = join(tmp(), "work.tmp-1");
  const env = engineEnv(
    { workDir: relative(process.cwd(), work), pythonPath: null },
    false,
  );
  expect(env.PATH).toBe(join(work, "bin"));
  expect(env.HOME).toBe(join(work, "home"));
  expect(env.TMPDIR).toBe(join(work, "tmp"));
});

it("puts node on the env's PATH through its link", async () => {
  const work = join(tmp(), "work.tmp-1");
  const r = await runEngine({
    engine: "dependency-cruiser",
    argv: [
      process.execPath,
      "-e",
      'console.log(require("node:child_process").execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim())',
    ],
    cwd: work,
    env: engineEnv({ workDir: work, pythonPath: null }, false),
    timeoutMs: 30_000,
  });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.trim()).toBe(realpathSync(process.execPath));
});
