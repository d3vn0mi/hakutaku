// The engine runner (interfaces section 3.5): one engine run, in an environment built from
// scratch, at nice 19 and under a wall-clock timeout, with its peak memory and CPU time read
// from /proc on Linux.
import { type ChildProcess, spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { setPriority } from "node:os";
import { join, resolve } from "node:path";
import type { EngineName } from "../model/index.js";
import type { ExtractContext } from "./context.js";

export interface EngineRun {
  engine: EngineName;
  argv: string[]; // argv[0] is absolute: inside the engines dir, Node's execPath, or the pinned Python
  cwd: string; // never inside the snapshot
  env: Record<string, string>; // from scratch: engineEnv's
  timeoutMs: number; // 600000 at quick and standard, 3600000 at deep
  stdoutFile?: string; // otherwise stdout is captured, up to 64 MiB
  onSpawn?: (pid: number) => void; // (addition) called right after the spawn
}

export interface EngineRunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  wallMs: number;
  cpuMs: number | null;
  peakRssBytes: number | null;
  stdout: string;
  stderrTail: string; // the last 4 KiB
}

const STDOUT_CAP = 64 * 1024 * 1024;
const STDERR_TAIL = 4096;
const POLL_MS = 200;
const NICE = 19;
// /proc counts utime and stime in ticks of USER_HZ, which is 100 on every architecture Node
// runs on.
const MS_PER_TICK = 10;

// Runs one engine. It resolves when the engine has ended, whatever its exit, and rejects when
// it cannot be started, when onSpawn throws, or when its captured stdout passes 64 MiB; the
// engine is stopped and reaped before a rejection.
export function runEngine(run: EngineRun): Promise<EngineRunResult> {
  const [command, ...args] = run.argv;
  if (command === undefined) {
    return Promise.reject(new Error(`${run.engine}: no command to run`));
  }
  return new Promise((done, fail) => {
    const started = performance.now();
    let out: number | null = null;
    let child: ChildProcess;
    try {
      if (run.stdoutFile !== undefined) out = openSync(run.stdoutFile, "w");
      child = spawn(command, args, {
        cwd: run.cwd,
        env: run.env,
        stdio: ["ignore", out ?? "pipe", "pipe"],
      });
    } catch (error) {
      fail(error);
      return;
    } finally {
      if (out !== null) closeSync(out);
    }

    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let tail = Buffer.alloc(0);
    let cut = false;
    let timedOut = false;
    let failure: Error | null = null;
    let peakRssBytes: number | null = null;
    let cpuMs: number | null = null;
    let settled = false;
    const stop = (): void => {
      child.kill("SIGKILL");
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (failure !== null) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > STDOUT_CAP) {
        failure = new Error(
          `${run.engine}: stdout passed 64 MiB; the run was stopped`,
        );
        stdout.length = 0;
        stop();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const joined = Buffer.concat([tail, chunk]);
      if (joined.length > STDERR_TAIL) {
        cut = true;
        tail = Buffer.from(joined.subarray(joined.length - STDERR_TAIL));
      } else {
        tail = joined;
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, run.timeoutMs);
    let poll: NodeJS.Timeout | undefined;
    const pid = child.pid;
    // VmHWM is the peak resident set; utime and stime, the 14th and 15th fields of stat, follow
    // the command name, whose closing parenthesis is the line's last.
    const sample = (): void => {
      try {
        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        const hwm = /^VmHWM:\s*(\d+) kB$/m.exec(status);
        if (hwm !== null) {
          peakRssBytes = Math.max(peakRssBytes ?? 0, Number(hwm[1]) * 1024);
        }
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const ticks = Number(fields[11]) + Number(fields[12]);
        if (Number.isSafeInteger(ticks)) cpuMs = ticks * MS_PER_TICK;
      } catch {
        // the engine ended between two samples
      }
    };
    if (pid !== undefined) {
      try {
        setPriority(pid, NICE);
      } catch {
        // the engine has already ended
      }
      if (process.platform === "linux") {
        sample();
        poll = setInterval(sample, POLL_MS);
      }
      try {
        run.onSpawn?.(pid);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        stop();
      }
    }

    const finish = (): void => {
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
    };
    // Once the engine is reaped its pid may name another process, so sampling stops here.
    child.once("exit", () => clearInterval(poll));
    // Without a pid the spawn failed. Otherwise the error is a failed kill, and close still comes.
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (pid !== undefined || settled) return;
      finish();
      fail(
        new Error(
          `${run.engine}: cannot run ${command}: ${error.code ?? error.message}`,
        ),
      );
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      finish();
      if (failure !== null) {
        fail(failure);
        return;
      }
      done({
        exitCode: code,
        signal,
        timedOut,
        wallMs: Math.round(performance.now() - started),
        cpuMs,
        peakRssBytes,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderrTail: tailText(tail, cut),
      });
    });
  });
}

// A tail cut from a longer stderr may start inside a character: the bytes before the first
// character that starts in it are dropped, rather than read as U+FFFD.
function tailText(tail: Buffer, cut: boolean): string {
  let start = 0;
  if (cut) {
    while (
      start < 3 &&
      start < tail.length &&
      ((tail[start] ?? 0) & 0xc0) === 0x80
    ) {
      start++;
    }
  }
  return tail.subarray(start).toString("utf8");
}

// The environment an engine runs in, built from scratch in the work directory. <workDir>/bin/
// holds links to Node and, when the build has one, to the pinned Python, and is the whole PATH;
// HOME and TMPDIR are directories of their own beside it. Python's two variables keep the user's
// site-packages out of a run, and its bytecode files out of every directory.
export function engineEnv(
  ctx: Pick<ExtractContext, "workDir" | "pythonPath">,
  python: boolean,
): Record<string, string> {
  const work = resolve(ctx.workDir);
  const bin = join(work, "bin");
  const home = join(work, "home");
  const tmp = join(work, "tmp");
  for (const dir of [bin, home, tmp]) mkdirSync(dir, { recursive: true });
  linkTo(process.execPath, join(bin, "node"));
  if (ctx.pythonPath !== null) {
    linkTo(ctx.pythonPath, join(bin, "python"));
    linkTo(ctx.pythonPath, join(bin, "python3"));
  }
  const env: Record<string, string> = {
    PATH: bin,
    HOME: home,
    LANG: "C.UTF-8",
    TMPDIR: tmp,
  };
  if (python) {
    env.PYTHONNOUSERSITE = "1";
    env.PYTHONDONTWRITEBYTECODE = "1";
  }
  return env;
}

// Makes path a symbolic link to target, replacing whatever else is there.
function linkTo(target: string, path: string): void {
  try {
    if (readlinkSync(path) === target) return;
  } catch {
    // missing, or not a link
  }
  rmSync(path, { recursive: true, force: true });
  symlinkSync(target, path);
}
