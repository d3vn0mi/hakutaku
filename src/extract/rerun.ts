// The sandboxed re-run: extract runs itself again, as `hakutaku extract ... --sandbox none
// --sandboxed-by <kind>`, inside the sandbox, and answers with the inner run's result. Every
// path is absolute and the engines directory is always named, since neither sandbox keeps
// this process's working directory or environment. What only this side knows, the sandbox's
// own warnings and the peak memory of bubblewrap's scope, is added to build.json afterwards.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Detail } from "../model/index.js";
import { readBuildFacts, writeBuildFacts } from "../store/index.js";
import type { ExtractResult } from "./index.js";
import { type Sandbox, sandboxCommand } from "./sandbox.js";

// The package root: two levels above this module, in src/ as in dist/. The re-run starts the
// built CLI, whichever of the two this module was loaded from.
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = join(PACKAGE_ROOT, "dist", "cli", "main.js");

const POLL_MS = 200;
const STDERR_TAIL = 4096;

// The inner run failed. It has recorded its own attempt, a provisional one when it was stopped;
// printed says whether its message is already on the stderr passed through.
export class SandboxedRunFailed extends Error {
  readonly printed: boolean;

  constructor(message: string, printed: boolean) {
    super(message);
    this.name = "SandboxedRunFailed";
    this.printed = printed;
  }
}

export interface Rerun {
  sandbox: Sandbox;
  dir: string;
  out: string;
  enginesDir: string;
  detail: Detail;
  noSource: boolean;
  memoryMax: string;
  pythonPath: string | null; // the pinned interpreter, whose prefix the sandbox must show
}

export async function extractInSandbox(r: Rerun): Promise<ExtractResult> {
  if (!statSync(CLI, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(
      "the sandbox re-runs hakutaku's built CLI, dist/cli/main.js, which is missing: build it, or extract with --sandbox none",
    );
  }
  const inner = [
    process.execPath,
    CLI,
    "extract",
    r.dir,
    "--out",
    r.out,
    "--engines-dir",
    r.enginesDir,
    "--detail",
    r.detail,
    ...(r.noSource ? ["--no-source"] : []),
    "--sandbox",
    "none",
    "--sandboxed-by",
    r.sandbox,
    "--memory-max",
    r.memoryMax,
  ];
  // bubblewrap binds the store's directory, which must exist
  const storeDir = dirname(r.out);
  mkdirSync(storeDir, { recursive: true });
  const { argv, warnings } = await sandboxCommand(
    r.sandbox,
    {
      exportDir: r.dir,
      enginesDir: r.enginesDir,
      storeDir,
      packageRoot: PACKAGE_ROOT,
      nodePrefix: dirname(dirname(process.execPath)),
      pythonPrefix:
        r.pythonPath === null ? null : dirname(dirname(r.pythonPath)),
      memoryMax: r.memoryMax,
    },
    inner,
  );
  // systemd-run --scope moves itself into the scope, then becomes bubblewrap: the child's
  // cgroup, once it is no longer this process's, is the scope's.
  const watchScope = r.sandbox === "bubblewrap" && argv[0] === "systemd-run";
  const ended = await runInner(argv, watchScope);
  if (ended.code === 0 || ended.code === 3) {
    const result = resultOf(ended.stdout);
    if (
      result.result === "built" &&
      (warnings.length > 0 || ended.peak !== null)
    ) {
      const facts = readBuildFacts(r.out);
      if (facts !== null) {
        writeBuildFacts(r.out, {
          ...facts,
          peakRssBytes: ended.peak ?? facts.peakRssBytes,
          warnings: [...warnings, ...facts.warnings],
        });
      }
    }
    return result;
  }
  const { message, printed } = innerFailure(ended);
  throw new SandboxedRunFailed(message, printed);
}

export interface Ended {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderrTail: string;
  peak: number | null;
}

// Runs the sandbox command with this process's environment, which systemd-run needs to reach
// the user manager. Its stderr is passed through as it comes.
function runInner(argv: string[], watchScope: boolean): Promise<Ended> {
  const [command = "", ...args] = argv;
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let tail = "";
    let peak: number | null = null;
    let settled = false;
    const own = cgroupOf("self");
    const pid = child.pid;
    const poll =
      watchScope && pid !== undefined
        ? setInterval(() => {
            const cgroup = cgroupOf(pid);
            if (cgroup === null || cgroup === own) return;
            const seen = memoryPeak(cgroup);
            if (seen !== null) peak = Math.max(peak ?? 0, seen);
          }, POLL_MS)
        : undefined;
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      tail = (tail + chunk.toString("utf8")).slice(-STDERR_TAIL);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      fail(
        new Error(`cannot start the sandbox: ${error.code ?? error.message}`),
      );
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      done({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderrTail: tail,
        peak,
      });
    });
  });
}

// The inner run's one result line.
function resultOf(stdout: string): ExtractResult {
  const line = stdout.trim().split("\n").pop() ?? "";
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    value = null;
  }
  const r = value as Partial<ExtractResult> | null;
  if (
    r === null ||
    typeof r !== "object" ||
    !["built", "skipped", "gates-failed"].includes(String(r.result)) ||
    typeof r.commit !== "string" ||
    !(typeof r.contentHash === "string" || r.contentHash === null) ||
    !Array.isArray(r.gates)
  ) {
    throw new SandboxedRunFailed(
      "the sandboxed extract printed no result",
      false,
    );
  }
  return r as ExtractResult;
}

// Why the inner run failed: its own message, which the CLI printed as "hakutaku: <message>",
// to the end of the stderr seen; else, when it printed none (stopped by a signal, such as at
// the memory cap), how it ended.
export function innerFailure(
  ended: Pick<Ended, "code" | "signal" | "stderrTail">,
): {
  message: string;
  printed: boolean;
} {
  const tail = `\n${ended.stderrTail}`;
  const at = tail.lastIndexOf("\nhakutaku: ");
  if (at !== -1) {
    return {
      message: tail.slice(at + "\nhakutaku: ".length).trimEnd(),
      printed: true,
    };
  }
  return {
    message:
      ended.code !== null
        ? `the sandboxed extract ended with exit code ${ended.code}`
        : `the sandboxed extract was stopped by ${ended.signal}`,
    printed: false,
  };
}

// A process's cgroup, from the "0::<path>" line of /proc/<pid>/cgroup; null where there is none.
export function cgroupOf(pid: number | "self"): string | null {
  try {
    const line = readFileSync(`/proc/${pid}/cgroup`, "utf8")
      .split("\n")
      .find((l) => l.startsWith("0::"));
    return line === undefined ? null : line.slice(3);
  } catch {
    return null;
  }
}

// A cgroup's peak memory in bytes, from its memory.peak; null where that cannot be read.
export function memoryPeak(cgroup: string): number | null {
  try {
    const text = readFileSync(
      join("/sys/fs/cgroup", cgroup, "memory.peak"),
      "utf8",
    ).trim();
    return /^\d+$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
}
