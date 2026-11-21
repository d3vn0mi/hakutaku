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
  type EngineRunResult,
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

it("reports a mark seen anywhere in stderr, even one split between writes and cut from the tail", async () => {
  // the mark comes in two writes 50 ms apart, then 6,000 bytes push it out of the tail
  const marked = await runEngine(
    run(
      'process.stderr.write("sky: orbit fa"); setTimeout(() => process.stderr.write("iled here\\n" + "x".repeat(6000)), 50);',
      { stderrMark: "orbit failed" },
    ),
  );
  expect(marked.stderrTail).not.toContain("orbit failed");
  expect(marked.stderrMarked).toBe(true);
  const unmarked = await runEngine(
    run('process.stderr.write("orbit fine\\n");', {
      stderrMark: "orbit failed",
    }),
  );
  expect(unmarked.stderrMarked).toBe(false);
  // without a mark to look for, none is reported
  const none = await runEngine(run('process.stderr.write("orbit failed");'));
  expect(none.stderrMarked).toBe(false);
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

// An engine that starts a process of its own, which inherits its stdout and stderr and sleeps
// for a minute, writes that process's pid to a file, and then runs then. The test stops the
// process by that pid when it ends, whatever happened.
async function withGrandchild(
  then: string,
  check: (r: () => Promise<EngineRunResult>) => Promise<void>,
  patch: Partial<EngineRun> = {},
): Promise<void> {
  const pidFile = join(tmp(), "grandchild.pid");
  const script = `
const { spawn } = require("node:child_process");
const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "inherit" });
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
${then}`;
  try {
    await check(() => runEngine(run(script, { timeoutMs: 500, ...patch })));
  } finally {
    try {
      process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
    } catch {
      // never started, or already gone
    }
  }
}

it("ends a run at its timeout though a process the engine started still holds its output", () =>
  withGrandchild("setTimeout(() => {}, 60000);", async (go) => {
    const r = await go();
    expect(r.timedOut).toBe(true);
    expect(r.signal).toBe("SIGKILL");
    expect(r.wallMs).toBeLessThan(5000);
  }));

it("ends a run at its timeout when the engine has exited but a process it started holds its output", () =>
  withGrandchild('console.log("orbit"); g.unref();', async (go) => {
    const r = await go();
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.wallMs).toBeLessThan(5000);
  }));

it("fails a run over 64 MiB at once though a process the engine started still holds its output", () =>
  withGrandchild(
    `process.stdout.write(Buffer.alloc(${MIB_64 + 1}, "a")); setTimeout(() => {}, 60000);`,
    async (go) => {
      const started = performance.now();
      await expect(go()).rejects.toThrow(
        "ast-grep: stdout passed 64 MiB; the run was stopped",
      );
      expect(performance.now() - started).toBeLessThan(5000);
    },
    { timeoutMs: 30_000 },
  ));

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

it("reports a run whose program cannot be started by its error code alone, without calling onSpawn", async () => {
  const seen: number[] = [];
  const missing = join(dir, "missing-engine");
  const r = await runEngine(
    run("", { argv: [missing], onSpawn: (pid) => seen.push(pid) }),
  );
  expect(r).toMatchObject({
    startError: "ENOENT",
    exitCode: null,
    signal: null,
    timedOut: false,
    stdout: "",
    stderrTail: "",
  });
  expect(JSON.stringify(r)).not.toContain(dir);
  expect(seen).toEqual([]);
  // a run that started has no start error
  expect((await runEngine(run("process.exit(0)"))).startError).toBeNull();
});

it("watches the whole of stderr for Node's heap running out, even once it is cut from the tail", async () => {
  // Node's line comes in two writes 50 ms apart, then 6,000 bytes push it out of the tail
  const out = await runEngine(
    run(
      'process.stderr.write("FATAL ERROR: Reached heap limit Allocation failed - JavaScript he"); setTimeout(() => process.stderr.write("ap out of memory\\n" + "x".repeat(6000)), 50);',
    ),
  );
  expect(out.stderrTail).not.toContain("heap out of memory");
  expect(out.heapOutOfMemory).toBe(true);
  expect(out.stderrCut).toBe(true);
  const fine = await runEngine(run('process.stderr.write("orbit fine\\n")'));
  expect(fine.heapOutOfMemory).toBe(false);
  expect(fine.stderrCut).toBe(false);
});

it("counts no OOM kill for a run that ends well, where the cgroup can be read at all", async () => {
  const r = await runEngine(run("process.exit(0)"));
  expect([false, null]).toContain(r.oomKilled);
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
