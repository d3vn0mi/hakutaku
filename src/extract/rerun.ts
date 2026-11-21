// The sandboxed re-run: extract runs itself again, as `hakutaku extract ... --sandbox none
// --sandboxed-by <kind>`, inside the sandbox, whose one writable path is the build's work
// directory. The inner run builds its store there, with its build facts and attempts beside it,
// and never sees the store's directory. Once it has ended, and every process of the sandbox with
// it, this process checks each file it will use before it uses one, and words the inner run's
// failure, when it failed, for the attempt. Every path is absolute and the engines directory is
// always named, since neither sandbox keeps this process's working directory or environment.
import { spawn } from "node:child_process";
import { lstatSync, type Stats, statSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_ORDER } from "../engines/index.js";
import type { Detail } from "../model/index.js";
import {
  type Attempt,
  type BuildFacts,
  MAX_JSON_BYTES,
  openStore,
  readAttempt,
  readBuildFacts,
} from "../store/index.js";
import { cgroupOf, memoryPeak, oomKills } from "./cgroup.js";
import type { ExtractResult } from "./index.js";
import { LARGER_CAP } from "./run.js";
import { capsMemory, type Sandbox, sandboxCommand } from "./sandbox.js";

// The package root: two levels above this module, in src/ as in dist/. The re-run starts the
// built CLI, whichever of the two this module was loaded from.
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = join(PACKAGE_ROOT, "dist", "cli", "main.js");

const POLL_MS = 200;
const STDERR_TAIL = 4096;

// The store the inner run builds in the work directory; its build.json and attempt.json sit
// beside it there.
const INNER_STORE = "store.sqlite";

// The inner run failed, or left a file this process refuses to use. printed says whether its
// message is already on the stderr passed through.
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
  work: string; // the build's work directory, which the caller made: all the sandbox can write
  commit: string; // the export's commit, which the store and facts the inner run leaves must name
  enginesDir: string;
  detail: Detail;
  noSource: boolean;
  memoryMax: string;
  pythonPath: string | null; // the pinned interpreter, whose prefix the sandbox must show
  home: string | null; // the user's home directory, which the inner run's texts name as ~
  // The current store's unresolved relative imports, which the unresolved-imports gate must not
  // pass, and which the inner run cannot read: null when there is no current store.
  currentUnresolved: number | null;
}

// A sandboxed build that did not fail: its gates failed, or it built a store this process has
// checked, ready to swap in.
export type SandboxedBuild =
  | { result: "gates-failed"; inner: ExtractResult }
  | {
      result: "built";
      inner: ExtractResult;
      contentHash: string;
      store: string; // the gated store in the work directory
      engines: BuildFacts["engines"];
      warnings: string[]; // the sandbox's own, then the inner run's
      peakRssBytes: number | null;
    };

export async function extractInSandbox(r: Rerun): Promise<SandboxedBuild> {
  if (!statSync(CLI, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(
      "the sandbox re-runs hakutaku's built CLI, dist/cli/main.js, which is missing: build it, or extract with --sandbox none",
    );
  }
  const capped = await capsMemory(r.sandbox);
  const { argv, warnings } = await sandboxCommand(
    r.sandbox,
    {
      exportDir: r.dir,
      enginesDir: r.enginesDir,
      workDir: r.work,
      packageRoot: PACKAGE_ROOT,
      nodePrefix: dirname(dirname(process.execPath)),
      pythonPrefix:
        r.pythonPath === null ? null : dirname(dirname(r.pythonPath)),
      memoryMax: r.memoryMax,
    },
    innerArgv(r, capped),
  );
  // systemd-run --scope moves itself into the scope, then becomes bubblewrap: the child's
  // cgroup, once it is no longer this process's, is the scope's.
  const watchScope = r.sandbox === "bubblewrap" && argv[0] === "systemd-run";
  const ended = await runInner(argv, watchScope);
  if (ended.code === 0 || ended.code === 3) {
    const inner = resultOf(ended.stdout);
    // it was asked for this commit, and cannot skip a build it has no store for
    if (inner.commit !== r.commit || inner.result === "skipped") {
      throw new SandboxedRunFailed(
        "the sandboxed extract answered for another build",
        false,
      );
    }
    if (inner.result === "gates-failed")
      return { result: "gates-failed", inner };
    const { store, facts } = takeBuilt(r.work, {
      commit: r.commit,
      contentHash: inner.contentHash ?? "",
    });
    return {
      result: "built",
      inner,
      contentHash: facts.contentHash,
      store,
      engines: facts.engines,
      warnings: [...warnings, ...facts.warnings],
      peakRssBytes: ended.peak ?? facts.peakRssBytes,
    };
  }
  const { message, printed } = innerFailure(ended, {
    sandbox: r.sandbox,
    memoryCap: capped ? r.memoryMax : null,
    oomContinue: argv.includes("OOMPolicy=continue"),
    commit: r.commit,
    draft: draftAttempt(r.work),
  });
  throw new SandboxedRunFailed(message, printed);
}

// The inner run's command: extract into the work directory, with every path absolute, no
// sandbox of its own, the one it is inside, whether that one caps its memory, the home
// directory, which inside bubblewrap is not its HOME, and the current store's unresolved
// imports.
export function innerArgv(r: Rerun, capped: boolean): string[] {
  return [
    process.execPath,
    CLI,
    "extract",
    r.dir,
    "--out",
    join(r.work, INNER_STORE),
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
    ...(capped ? ["--memory-capped"] : []),
    ...(r.home === null ? [] : ["--home", r.home]),
    ...(r.currentUnresolved === null
      ? []
      : ["--current-unresolved", String(r.currentUnresolved)]),
  ];
}

export interface Ended {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderrTail: string;
  peak: number | null;
  // Whether the kernel killed a process of bubblewrap's scope for want of memory: true once its
  // memory.events counts a kill, false when a read after the sandbox ended counts none, and null
  // when no read could tell, since the scope may be gone before one.
  oomKilled: boolean | null;
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
    let scope: string | null = null;
    let killed = false;
    let after: number | null = null;
    let settled = false;
    const own = cgroupOf("self");
    const pid = child.pid;
    const poll =
      watchScope && pid !== undefined
        ? setInterval(() => {
            const cgroup = cgroupOf(pid);
            if (cgroup !== null && cgroup !== own) scope = cgroup;
            if (scope === null) return;
            const seen = memoryPeak(scope);
            if (seen !== null) peak = Math.max(peak ?? 0, seen);
            killed ||= (oomKills(scope) ?? 0) > 0;
          }, POLL_MS)
        : undefined;
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      tail = (tail + chunk.toString("utf8")).slice(-STDERR_TAIL);
    });
    // Once bubblewrap has exited, no process of its sandbox is left, and the scope's count is
    // final while the scope is still there to read.
    child.once("exit", () => {
      clearInterval(poll);
      if (scope !== null) after = oomKills(scope);
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
        oomKilled:
          killed || (after ?? 0) > 0 ? true : after === 0 ? false : null,
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

// The store and build facts a built inner run left in the work directory, each checked before
// this process uses it: the store must open as a store of the commit, with the content hash the
// inner run reported and every gate passed, and build.json must hold the facts of that store.
export function takeBuilt(
  work: string,
  reported: { commit: string; contentHash: string },
): { store: string; facts: BuildFacts } {
  const store = join(work, INNER_STORE);
  refuseUnusable(store, "store.sqlite", Number.POSITIVE_INFINITY);
  const opened = openStore(store);
  if ("code" in opened) {
    throw refused("store.sqlite", `does not open (${opened.reason})`);
  }
  let asReported: boolean;
  try {
    asReported =
      opened.meta.commit === reported.commit &&
      opened.run.contentHash === reported.contentHash &&
      opened.meta.gates.every((g) => g.ok);
  } finally {
    opened.close();
  }
  if (!asReported) {
    throw refused(
      "store.sqlite",
      "is not the store the sandboxed extract reported",
    );
  }
  refuseUnusable(join(work, "build.json"), "build.json", MAX_JSON_BYTES);
  const facts = readBuildFacts(store);
  if (
    facts === null ||
    facts.commit !== reported.commit ||
    facts.contentHash !== reported.contentHash
  ) {
    throw refused("build.json", "is not the build facts of the store reported");
  }
  return { store, facts };
}

// The attempt the inner run last recorded in the work directory, when that file can be used.
function draftAttempt(work: string): Attempt | null {
  if (problemAt(join(work, "attempt.json"), MAX_JSON_BYTES) !== null) {
    return null;
  }
  return readAttempt(join(work, INNER_STORE));
}

// Why a file the sandbox left cannot be used, or null. Any process of the sandbox could have
// written it, so it must be a regular file, not a link, with one name, owned by this user, and
// no larger than max bytes.
export function fileProblem(stats: Stats, max: number): string | null {
  if (stats.isSymbolicLink()) return "is a link";
  if (!stats.isFile()) return "is not a regular file";
  if (stats.nlink !== 1) return "has more than one name";
  if (stats.uid !== process.getuid?.()) return "is not owned by this user";
  if (stats.size > max) return `is larger than ${max} bytes`;
  return null;
}

// fileProblem of the file at path, read with lstat, so that a link is never followed.
function problemAt(path: string, max: number): string | null {
  let stats: Stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "is missing"
      : "cannot be read";
  }
  return fileProblem(stats, max);
}

function refuseUnusable(path: string, name: string, max: number): void {
  const problem = problemAt(path, max);
  if (problem !== null) throw refused(name, problem);
}

const refused = (name: string, problem: string): SandboxedRunFailed =>
  new SandboxedRunFailed(
    `the sandboxed build's ${name} is refused: it ${problem}`,
    false,
  );

// A provisional attempt, as markStage records it, and the stages it records.
const PROVISIONAL = /^interrupted or still running \(pid \d+\): (.*)$/;
const STAGES: ReadonlySet<string> = new Set([
  ...ENGINE_ORDER.map((name) => `running ${name}`),
  "writing the store",
  "checking the gates",
  "swapping the store",
]);

// Why the inner run failed: the reason of the failed attempt it recorded for this commit; else
// its own message, which the CLI printed as "hakutaku: <message>", to the end of the stderr
// seen; else, when it printed none (stopped by a signal, such as at the memory cap), how it
// ended, with the stage its last provisional attempt names.
export function innerFailure(
  ended: Pick<Ended, "code" | "signal" | "stderrTail" | "oomKilled">,
  ctx: {
    sandbox: Sandbox;
    memoryCap: string | null; // the cap the sandbox applies, or null when it applies none
    // whether the sandbox command carries OOMPolicy=continue, so that a kill at the cap stops
    // only the process the kernel killed, never the whole unit
    oomContinue: boolean;
    commit: string;
    draft: Attempt | null; // the inner run's last attempt
  },
): { message: string; printed: boolean } {
  const tail = `\n${ended.stderrTail}`;
  const at = tail.lastIndexOf("\nhakutaku: ");
  const printed = at !== -1;
  const draft =
    ctx.draft?.commit === ctx.commit && ctx.draft.result === "failed"
      ? ctx.draft.reason
      : undefined;
  const stage = draft === undefined ? undefined : PROVISIONAL.exec(draft)?.[1];
  if (draft !== undefined && stage === undefined) {
    return { message: draft, printed };
  }
  if (printed) {
    return {
      message: tail.slice(at + "\nhakutaku: ".length).trimEnd(),
      printed,
    };
  }
  const where =
    stage !== undefined && STAGES.has(stage) ? ` while ${stage}` : "";
  return {
    message: `the sandboxed extract failed${where}: ${endOf(ended, ctx)}`,
    printed: false,
  };
}

// How the inner run ended. A signal that stopped it reaches this process as an exit code, unless
// it stopped the sandbox command itself: bubblewrap exits 128 + N for a run that signal N
// stopped, and systemd-run --wait exits 255 for a service whose main process a signal stopped,
// which is most often SIGKILL, and 1 for one that failed otherwise.
//
// The memory cap is said only where an OOM kill was counted in bubblewrap's scope. Nothing else
// tells a kill at the cap from another, so where no count could be read, an end the cap can give
// names it only as one possible cause, with its repair: a SIGKILL, which is how the kernel kills
// a process at the cap, and so how systemd-run's 255 ends a service under OOMPolicy=continue
// (probed); and, under systemd-run without OOMPolicy=continue, an exit 1, which is how a kill at
// the cap that stops the whole service ends it (probed: systemd 255 says "oom-kill" for it, and
// "signal" for the same kill under OOMPolicy=continue).
function endOf(
  ended: Pick<Ended, "code" | "signal" | "oomKilled">,
  ctx: { sandbox: Sandbox; memoryCap: string | null; oomContinue: boolean },
): string {
  let code = ended.code;
  let signal = ended.signal;
  if (signal === null && code !== null) {
    const decoded =
      ctx.sandbox === "bubblewrap"
        ? code > 128
          ? signalName(code - 128)
          : null
        : code === 255
          ? "SIGKILL"
          : null;
    if (decoded !== null) {
      signal = decoded;
      code = null;
    }
  }
  const text = signal !== null ? `stopped by ${signal}` : `exit code ${code}`;
  if (ctx.memoryCap === null) return text;
  if (ended.oomKilled === true) {
    return `reached the ${ctx.memoryCap} memory cap; ${LARGER_CAP}`;
  }
  const maybeCap =
    ended.oomKilled === null &&
    (signal === "SIGKILL" ||
      (ctx.sandbox === "systemd-run" && !ctx.oomContinue && code === 1));
  return maybeCap
    ? `${text}; if that was the ${ctx.memoryCap} memory cap, ${LARGER_CAP}`
    : text;
}

// The name of signal n, or null for a number no signal has.
function signalName(n: number): string | null {
  const found = Object.entries(constants.signals).find(([, v]) => v === n);
  return found === undefined ? null : found[0];
}
