// The engine runner: one engine run, in an environment built from
// scratch, at nice 19 and under a wall-clock timeout, with its peak memory and CPU time read
// from /proc on Linux. Also how a failed run is worded, the same way for every engine: how it
// ended first, then a cleaned excerpt of what it said.
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
import { homeRoot, type Root, textCleaner } from "../redact/index.js";
import { cgroupOf, oomKills } from "./cgroup.js";
import type { ExtractContext } from "./context.js";

export interface EngineRun {
  engine: EngineName;
  argv: string[]; // argv[0] is absolute: inside the engines dir, Node's execPath, or the pinned Python
  cwd: string; // never inside the snapshot
  env: Record<string, string>; // from scratch: engineEnv's
  timeoutMs: number; // 600000 at quick and standard, 3600000 at deep
  stdoutFile?: string; // otherwise stdout is captured, up to 64 MiB
  stderrMark?: string; // a text looked for in the whole of stderr, not only its tail
  onSpawn?: (pid: number) => void; // called right after the spawn
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
  stderrCut: boolean; // whether stderr was longer than its tail
  stderrMarked: boolean; // whether stderrMark appeared anywhere in stderr
  heapOutOfMemory: boolean; // whether Node's heap-out-of-memory error appeared anywhere in stderr
  // Whether the kernel killed a process of this cgroup for want of memory while the engine ran,
  // from memory.events; null where that cannot be read, as inside bubblewrap.
  oomKilled: boolean | null;
  startError: string | null; // the error code when the engine could not be started, such as ENOENT
}

const STDOUT_CAP = 64 * 1024 * 1024;
// How Node says its JavaScript heap ran out, before it aborts.
const HEAP_OUT_OF_MEMORY = Buffer.from("JavaScript heap out of memory");
const STDERR_TAIL = 4096;
const POLL_MS = 200;
const NICE = 19;
// /proc counts utime and stime in ticks of USER_HZ, which is 100 on every architecture Node
// runs on.
const MS_PER_TICK = 10;

// Runs one engine. It resolves when the engine has ended, whatever its exit, or could not be
// started, which startError then says; it rejects when its stdout file cannot be opened, when
// onSpawn throws, or when its captured stdout passes 64 MiB, and the engine is stopped and reaped
// before a rejection.
export function runEngine(run: EngineRun): Promise<EngineRunResult> {
  const [command, ...args] = run.argv;
  if (command === undefined) {
    return Promise.reject(new Error(`${run.engine}: no command to run`));
  }
  return new Promise((done, fail) => {
    const started = performance.now();
    const cgroup = process.platform === "linux" ? cgroupOf("self") : null;
    const killsBefore = cgroup === null ? null : oomKills(cgroup);
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
    const mark =
      run.stderrMark === undefined || run.stderrMark === ""
        ? null
        : Buffer.from(run.stderrMark);
    let marked = false;
    let heapOutOfMemory = false;
    let timedOut = false;
    let failure: Error | null = null;
    let peakRssBytes: number | null = null;
    let cpuMs: number | null = null;
    let settled = false;
    let stopped = false;
    let exited = false;
    // A process the engine started can hold its stdout and stderr open after the engine has
    // gone, which would keep close from coming. Once a stopped engine has exited, its pipes
    // are closed on this side, so a stop always ends the run.
    const release = (): void => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const stop = (): void => {
      stopped = true;
      child.kill("SIGKILL");
      if (exited) release();
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
      // The tail holds the last bytes before this chunk, so a mark split between two chunks
      // is found too, as long as it is shorter than the tail.
      if (mark !== null && !marked) marked = joined.includes(mark);
      if (!heapOutOfMemory)
        heapOutOfMemory = joined.includes(HEAP_OUT_OF_MEMORY);
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
    child.once("exit", () => {
      exited = true;
      clearInterval(poll);
      if (stopped) release();
    });
    // Without a pid the spawn failed. Otherwise the error is a failed kill, and close still comes.
    // The error's message names the command's path, so only its code is kept.
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (pid !== undefined || settled) return;
      finish();
      done({
        exitCode: null,
        signal: null,
        timedOut: false,
        wallMs: Math.round(performance.now() - started),
        cpuMs: null,
        peakRssBytes: null,
        stdout: "",
        stderrTail: "",
        stderrCut: false,
        stderrMarked: false,
        heapOutOfMemory: false,
        oomKilled: null,
        startError: error.code ?? "unknown error",
      });
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      finish();
      if (failure !== null) {
        fail(failure);
        return;
      }
      const killsAfter = cgroup === null ? null : oomKills(cgroup);
      done({
        exitCode: code,
        signal,
        timedOut,
        wallMs: Math.round(performance.now() - started),
        cpuMs,
        peakRssBytes,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderrTail: tailText(tail, cut),
        stderrCut: cut,
        stderrMarked: marked,
        heapOutOfMemory,
        oomKilled:
          killsBefore === null || killsAfter === null
            ? null
            : killsAfter > killsBefore,
        startError: null,
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

// What a failure's wording needs beyond the run: the timeout the run had; the memory cap the
// sandbox applies to the build, or null when nothing caps it; the cap the engine's JavaScript
// heap is cut from, or null when Node sizes its own heap; and how a text is cleaned.
export interface FailureContext {
  timeoutMs: number;
  memoryCap: string | null;
  heapCap: string | null;
  clean: (text: string) => string;
}

// How a run ended, as one clause. memory says whether a larger memory cap can repair it.
export interface RunEnd {
  text: string;
  memory: boolean;
}

const DEFAULT_MEMORY_MAX = "3G";
// The repair of a run that a larger memory cap may let finish.
export const LARGER_CAP = "rebuild with a larger --memory-max";

// How a run ended, the first that applies: it could not start; it timed out; it reached the
// memory cap, which only a sandbox that applies one can say, from an OOM kill counted in its
// cgroup or, where that count cannot be read, from a SIGKILL that was not the timeout's; Node's
// heap ran out; a signal stopped it; it exited non-zero. Null for an exit 0 within its timeout.
export function runEnd(r: EngineRunResult, f: FailureContext): RunEnd | null {
  if (r.startError !== null) {
    return { text: `could not start: ${r.startError}`, memory: false };
  }
  if (r.timedOut) {
    return { text: `timed out after ${f.timeoutMs / 1000} s`, memory: false };
  }
  if (r.exitCode === 0) return null;
  if (
    f.memoryCap !== null &&
    (r.oomKilled === true || (r.oomKilled === null && r.signal === "SIGKILL"))
  ) {
    return {
      text: `reached the ${f.memoryCap} memory cap; ${LARGER_CAP}`,
      memory: true,
    };
  }
  if (r.heapOutOfMemory) {
    return f.heapCap === null
      ? { text: "ran out of JavaScript heap", memory: false }
      : { text: `ran out of JavaScript heap; ${LARGER_CAP}`, memory: true };
  }
  if (r.signal !== null) {
    return { text: `stopped by ${r.signal}`, memory: false };
  }
  return { text: `exit code ${r.exitCode}`, memory: false };
}

// A failed run's wording: how it ended, then the excerpt on the lines below; null when the run
// did not fail. The excerpt is the stderr tail's, else said, the engine's own words from
// elsewhere, such as its stdout.
export function runFailure(
  r: EngineRunResult,
  f: FailureContext,
  said?: string,
): { text: string; end: RunEnd } | null {
  const end = runEnd(r, f);
  if (end === null) return null;
  let excerpt = excerptOf(r.stderrTail, r.stderrCut, f.clean);
  if (excerpt === "" && said !== undefined) {
    excerpt = excerptOf(said, false, f.clean);
  }
  return { text: excerpt === "" ? end.text : `${end.text}\n${excerpt}`, end };
}

// The whole lines of a text, cleaned. A tail cut from a longer stderr loses its first line,
// whose start may be gone; each line loses its trailing spaces, and the text its blank lines at
// either end.
export function excerptOf(
  text: string,
  cut: boolean,
  clean: (text: string) => string,
): string {
  const lines = text.split("\n").map((line) => line.trimEnd());
  if (cut) lines.shift();
  while (lines[0] === "") lines.shift();
  while (lines.at(-1) === "") lines.pop();
  return lines.length === 0 ? "" : clean(lines.join("\n"));
}

type RootsOf = Pick<
  ExtractContext,
  "snapshotDir" | "exportDir" | "workDir" | "enginesDir" | "storeDir" | "home"
>;

// The paths a build's texts name by token: the snapshot, the export, the work directory, the
// store's directory, the engines, the Node that runs them, then the home directory, the
// context's own or else this process's.
export function buildRoots(ctx: RootsOf): Root[] {
  const roots: Root[] = [
    [resolve(ctx.snapshotDir), "<snapshot>"],
    [resolve(ctx.exportDir), "<export>"],
    [resolve(ctx.workDir), "<work>"],
    [resolve(ctx.enginesDir), "<engines>"],
    [process.execPath, "<node>"],
  ];
  if (ctx.storeDir !== undefined) {
    roots.push([resolve(ctx.storeDir), "<store>"]);
  }
  const home = ctx.home === undefined ? homeRoot() : ctx.home;
  if (home !== null) roots.push([home, "~"]);
  return roots;
}

// A driver's failure context: the build's memory cap when its sandbox applies one, the same cap
// as the heap's when the driver cuts the engine's heap from it, and the build's roots.
export function failureContext(
  ctx: RootsOf & Pick<ExtractContext, "memoryMax" | "memoryCapped">,
  timeoutMs: number,
  opts: { heap?: boolean } = {},
): FailureContext {
  const cap = ctx.memoryMax ?? DEFAULT_MEMORY_MAX;
  return {
    timeoutMs,
    memoryCap: ctx.memoryCapped === true ? cap : null,
    heapCap: opts.heap === true ? cap : null,
    clean: textCleaner(buildRoots(ctx)),
  };
}

// A failed engine run, with how it ended, which a build records beside the message.
export class EngineFailure extends Error {
  readonly end: RunEnd;

  constructor(message: string, end: RunEnd) {
    super(message);
    this.name = "EngineFailure";
    this.end = end;
  }
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
