// The extraction sandbox. On Linux, extract re-runs itself inside bubblewrap or, where
// bubblewrap does not work, inside a systemd-run --user service shown to have no network.
// detectSandbox finds which works, once per process; the argv builders write each command. Every
// path in a command is absolute: the user manager's PATH may lack the running Node, and
// systemd-run -p takes no %h. Neither sandbox lets an engine dump core, and where this systemd
// takes OOMPolicy=continue, an engine the kernel kills at the memory cap stops only itself, so
// the build goes on without it. Each probe keeps its evidence, and a failed one names its repair.
import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { cleanReason } from "../redact/index.js";

export type Sandbox = "bubblewrap" | "systemd-run";

export interface SandboxPaths {
  exportDir: string;
  enginesDir: string;
  workDir: string; // the build's work directory: the one path the sandbox can write
  packageRoot: string;
  nodePrefix: string;
  pythonPrefix: string | null;
  memoryMax: string; // systemd's MemoryMax, such as "3G"
}

// The warning a bubblewrap build records when nothing caps its memory.
export const NO_MEMORY_CAP = "no memory cap: systemd-run is unavailable";

const BWRAP_PROBE = [
  "bwrap",
  "--unshare-all",
  "--die-with-parent",
  "--ro-bind",
  "/",
  "/",
  "true",
];
// Whether systemd-run starts a user service at all: enough for the scope that caps bubblewrap's
// memory.
const SYSTEMD_RUN_PROBE = [
  "systemd-run",
  "--user",
  "--wait",
  "--quiet",
  "--collect",
  "-p",
  "PrivateNetwork=yes",
  "true",
];
// Whether systemd-run can be the sandbox: a check inside the service that it sees no network
// interface but loopback. A user manager that cannot make a network namespace (unprivileged user
// namespaces refused) may still run the service, in the host's network, and exit 0, so
// systemd-run's own exit code proves nothing about the network.
const ONLY_LOOPBACK =
  'process.exit(Object.keys(require("node:os").networkInterfaces()).every((n)=>n==="lo")?0:1)';
const SYSTEMD_RUN_ISOLATION_PROBE = [
  "systemd-run",
  "--user",
  "--wait",
  "--quiet",
  "--collect",
  "-p",
  "PrivateNetwork=yes",
  "--",
  process.execPath,
  "-e",
  ONLY_LOOPBACK,
];
// Whether this systemd takes OOMPolicy=continue: scopes took it only in later versions than
// services did, and an older systemd-run refuses a property it does not know.
const OOM_SCOPE_PROBE = [
  "systemd-run",
  "--user",
  "--scope",
  "--quiet",
  "--collect",
  "-p",
  "OOMPolicy=continue",
  "true",
];
const OOM_SERVICE_PROBE = [
  "systemd-run",
  "--user",
  "--wait",
  "--quiet",
  "--collect",
  "-p",
  "OOMPolicy=continue",
  "true",
];
const PROBE_TIMEOUT_MS = 30_000;
// The most characters of the line a failed probe said that its evidence keeps.
const EXCERPT_CHARS = 300;

// How a probe ended: the error code when its command could not be started, its exit code or
// signal, whether it passed the probe timeout, and the last line it wrote on stderr, cleaned.
export interface ProbeEvidence {
  command: string;
  errno: string | null;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  excerpt: string;
}

type Probe = ProbeEvidence & { ok: boolean };

// What a failed probe means, as the one line that names its repair.
export const SANDBOX_REPAIRS = {
  noBubblewrap: "bubblewrap is not installed",
  userNamespaces: "user namespaces are refused",
  noUserManager: "no user manager can be reached",
  noNetworkCut: "systemd-run cannot cut the network",
} as const;

export type SandboxRepair =
  (typeof SANDBOX_REPAIRS)[keyof typeof SANDBOX_REPAIRS];

export interface SandboxProblem {
  line: SandboxRepair;
  evidence: ProbeEvidence;
}

const probes = new Map<string, Promise<Probe>>();

// Each probe runs at most once per process.
function probeOnce(argv: readonly string[]): Promise<Probe> {
  const key = argv.join("\0");
  let probed = probes.get(key);
  if (probed === undefined) {
    probed = probe(argv);
    probes.set(key, probed);
  }
  return probed;
}

const bwrapProbe = (): Promise<Probe> => probeOnce(BWRAP_PROBE);
const systemdRunProbe = (): Promise<Probe> => probeOnce(SYSTEMD_RUN_PROBE);
const isolationProbe = (): Promise<Probe> =>
  probeOnce(SYSTEMD_RUN_ISOLATION_PROBE);

async function bwrapWorks(): Promise<boolean> {
  return (await bwrapProbe()).ok;
}

async function systemdRunWorks(): Promise<boolean> {
  return (await systemdRunProbe()).ok;
}

async function systemdRunIsolates(): Promise<boolean> {
  return (await isolationProbe()).ok;
}

// The sandbox this machine has: bubblewrap, else a systemd-run service with no network, each
// probed at most once per process, and only on Linux.
export async function detectSandbox(
  platform: NodeJS.Platform = process.platform,
): Promise<Sandbox | null> {
  if (platform !== "linux") return null;
  if (await bwrapWorks()) return "bubblewrap";
  if (await systemdRunIsolates()) return "systemd-run";
  return null;
}

// What keeps this machine's sandbox from its strongest form, each problem with the line that
// names its repair and the evidence of the probe that found it: bubblewrap not installed, or
// refused the user namespaces it needs; systemd-run unable to reach a user manager, which also
// leaves bubblewrap without a memory cap; and, where bubblewrap does not work, a systemd-run
// service that still sees the host's network. None off Linux, where nothing is probed.
export async function sandboxProblems(
  platform: NodeJS.Platform = process.platform,
): Promise<SandboxProblem[]> {
  if (platform !== "linux") return [];
  const problems: SandboxProblem[] = [];
  const bwrap = await bwrapProbe();
  if (!bwrap.ok) {
    problems.push({
      line:
        bwrap.errno === "ENOENT"
          ? SANDBOX_REPAIRS.noBubblewrap
          : SANDBOX_REPAIRS.userNamespaces,
      evidence: evidenceOf(bwrap),
    });
  }
  const systemdRun = await systemdRunProbe();
  if (!systemdRun.ok) {
    problems.push({
      line: SANDBOX_REPAIRS.noUserManager,
      evidence: evidenceOf(systemdRun),
    });
  } else if (!bwrap.ok) {
    const isolation = await isolationProbe();
    if (!isolation.ok) {
      problems.push({
        line: SANDBOX_REPAIRS.noNetworkCut,
        evidence: evidenceOf(isolation),
      });
    }
  }
  return problems;
}

// A probe's evidence as one line: its command, how it ended, then what it said.
export function evidenceLine(e: ProbeEvidence): string {
  const ended =
    e.errno !== null
      ? `could not start: ${e.errno}`
      : e.timedOut
        ? `timed out after ${PROBE_TIMEOUT_MS / 1000} s`
        : e.signal !== null
          ? `stopped by ${e.signal}`
          : `exit code ${e.exitCode}`;
  return `${e.command}: ${ended}${e.excerpt === "" ? "" : `: ${e.excerpt}`}`;
}

// Why detectSandbox found none, as the repair line of each problem. Off Linux it names the
// platform and probes nothing.
export async function noSandboxReason(
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (platform !== "linux") return `no sandbox on ${platform}`;
  const problems = await sandboxProblems(platform);
  return problems.length === 0
    ? "no sandbox"
    : `no sandbox: ${problems.map((p) => p.line).join("; ")}`;
}

// The evidence behind noSandboxReason, one line per problem, which --sandbox require prints
// below its refusal.
export async function noSandboxEvidence(
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  return (await sandboxProblems(platform)).map((p) => evidenceLine(p.evidence));
}

function evidenceOf({ ok: _, ...evidence }: Probe): ProbeEvidence {
  return evidence;
}

// Whether a sandbox detectSandbox found caps memory: systemd-run always does, and bubblewrap
// does inside the systemd-run scope that sandboxCommand puts it in when systemd-run works.
export async function capsMemory(sandbox: Sandbox): Promise<boolean> {
  return sandbox === "systemd-run" || (await systemdRunWorks());
}

// The command that runs inner in a sandbox detectSandbox found, and the warnings it
// brings. bubblewrap caps no memory, so it runs inside a systemd-run scope that does whenever
// systemd-run works too.
export async function sandboxCommand(
  sandbox: Sandbox,
  p: SandboxPaths,
  inner: string[],
): Promise<{ argv: string[]; warnings: string[] }> {
  if (sandbox === "systemd-run") {
    const oomContinue = (await probeOnce(OOM_SERVICE_PROBE)).ok;
    return { argv: systemdRunArgv(p, inner, { oomContinue }), warnings: [] };
  }
  if (await systemdRunWorks()) {
    const oomContinue = (await probeOnce(OOM_SCOPE_PROBE)).ok;
    return {
      argv: [...scopePrefix(p, oomContinue), ...bwrapArgv(p, inner)],
      warnings: [],
    };
  }
  return { argv: bwrapArgv(p, inner), warnings: [NO_MEMORY_CAP] };
}

// What a dynamically linked program needs, read-only. Each but /usr may be missing, or be a link
// into /usr, which the bind follows.
const SYSTEM_BINDS: ReadonlyArray<readonly [string, string]> = [
  ["--ro-bind", "/usr"],
  ["--ro-bind-try", "/bin"],
  ["--ro-bind-try", "/lib"],
  ["--ro-bind-try", "/lib64"],
  ["--ro-bind-try", "/sbin"],
  ["--ro-bind-try", "/etc/ld.so.cache"],
  ["--ro-bind-try", "/etc/alternatives"],
];

// The shell bubblewrap runs inner through, which sets the core limit, soft and hard, to 0 first:
// a scope takes no LimitCORE, and the shell is on every system bubblewrap binds.
const NO_CORE = ["/bin/sh", "-c", 'ulimit -c 0 && exec "$@"', "sh"];

// bubblewrap: no namespace shared, no environment kept, and nothing of the file system but the
// system directories, Node, hakutaku, the pinned Python, the export and the engines, all
// read-only, and the build's work directory, the one writable path. inner runs with no core
// dumps.
export function bwrapArgv(p: SandboxPaths, inner: string[]): string[] {
  const binds: Array<[string, string]> = [
    ["--ro-bind", absolute(p, "nodePrefix")],
    ["--ro-bind", absolute(p, "packageRoot")],
  ];
  if (p.pythonPrefix !== null) {
    binds.push(["--ro-bind", absolute(p, "pythonPrefix")]);
  }
  binds.push(
    ["--ro-bind", absolute(p, "exportDir")],
    ["--ro-bind", absolute(p, "enginesDir")],
    ["--bind", absolute(p, "workDir")],
  );
  // A mount hides whatever an earlier one put inside it, so each directory is bound before the
  // directories inside it; the sort is stable, so other binds keep their order.
  binds.sort((a, b) => depth(a[1]) - depth(b[1]));
  return [
    "bwrap",
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    ...atOwnPaths(SYSTEM_BINDS),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    ...atOwnPaths(binds),
    "--setenv",
    "HOME",
    "/tmp",
    "--setenv",
    "LANG",
    "C.UTF-8",
    ...NO_CORE,
    ...inner,
  ];
}

// systemd-run alone: a transient user service with no network, the memory cap, no core dumps
// and a low priority, which hakutaku waits for, its output piped through. oomContinue says this
// systemd's services take OOMPolicy=continue.
export function systemdRunArgv(
  p: SandboxPaths,
  inner: string[],
  opts: { oomContinue?: boolean } = {},
): string[] {
  return [
    "systemd-run",
    "--user",
    "--wait",
    "--pipe",
    "--quiet",
    "--collect",
    "-p",
    "PrivateNetwork=yes",
    ...memoryCap(p, opts.oomContinue === true),
    "-p",
    "LimitCORE=0",
    "-p",
    "Nice=19",
    "--",
    ...inner,
  ];
}

// The scope bubblewrap runs in to have the memory cap. --collect unloads it even when the cap
// ended it.
function scopePrefix(p: SandboxPaths, oomContinue: boolean): string[] {
  return [
    "systemd-run",
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    ...memoryCap(p, oomContinue),
    "--",
  ];
}

// MemorySwapMax=0 makes a build that reaches the cap fail at once, instead of swapping and
// crawling on. OOMPolicy=continue keeps the unit running when the kernel kills one of its
// processes at the cap, where the default stops every other one: the killed engine then
// degrades its tier, and the build goes on.
function memoryCap(p: SandboxPaths, oomContinue: boolean): string[] {
  return [
    "-p",
    `MemoryMax=${p.memoryMax}`,
    "-p",
    "MemorySwapMax=0",
    ...(oomContinue ? ["-p", "OOMPolicy=continue"] : []),
  ];
}

function absolute(
  p: SandboxPaths,
  field: Exclude<keyof SandboxPaths, "memoryMax">,
): string {
  const path = p[field];
  if (path === null || !isAbsolute(path)) {
    throw new Error(
      `sandbox: ${field} is not an absolute path: ${JSON.stringify(path)}`,
    );
  }
  return resolve(path);
}

// Each [flag, path] as the mount of path at its own path.
function atOwnPaths(binds: ReadonlyArray<readonly [string, string]>): string[] {
  return binds.flatMap(([flag, path]) => [flag, path, path]);
}

function depth(path: string): number {
  return path.split("/").filter((part) => part !== "").length;
}

// Whether argv runs and exits 0 within the probe timeout, and its evidence. The probe keeps
// this process's environment, which systemd-run needs to reach the user manager.
function probe(argv: readonly string[]): Promise<Probe> {
  const [command = "", ...args] = argv;
  return new Promise((done) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const end = (p: Omit<Probe, "command" | "timedOut" | "excerpt">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ command, ...p, timedOut, excerpt: lastLine(stderr) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PROBE_TIMEOUT_MS);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4096);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      // without a pid the spawn failed; any other error is a failed kill, and close still comes
      if (child.pid !== undefined) return;
      end({
        ok: false,
        errno: error.code ?? "unknown error",
        exitCode: null,
        signal: null,
      });
    });
    child.once("close", (code, signal) =>
      end({
        ok: code === 0 && !timedOut,
        errno: null,
        exitCode: code,
        signal,
      }),
    );
  });
}

// The last line a probe wrote on stderr, cleaned, and cut to EXCERPT_CHARS.
function lastLine(stderr: string): string {
  const line =
    stderr
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .pop() ?? "";
  const cleaned = cleanReason(line);
  return [...cleaned].length <= EXCERPT_CHARS
    ? cleaned
    : `${[...cleaned].slice(0, EXCERPT_CHARS).join("")}...`;
}
