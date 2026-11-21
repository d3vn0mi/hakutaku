// The extraction sandbox. On Linux, extract re-runs itself inside bubblewrap or, where
// bubblewrap does not work, inside a systemd-run --user service shown to have no network.
// detectSandbox finds which works, once per process; the argv builders write each command. Every
// path in a command is absolute: the user manager's PATH may lack the running Node, and
// systemd-run -p takes no %h.
import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

export type Sandbox = "bubblewrap" | "systemd-run";

export interface SandboxPaths {
  exportDir: string;
  enginesDir: string;
  storeDir: string;
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
const PROBE_TIMEOUT_MS = 30_000;

let bwrapProbe: Promise<boolean> | undefined;
let systemdRunProbe: Promise<boolean> | undefined;
let systemdRunIsolationProbe: Promise<boolean> | undefined;

function bwrapWorks(): Promise<boolean> {
  bwrapProbe ??= probe(BWRAP_PROBE);
  return bwrapProbe;
}

function systemdRunWorks(): Promise<boolean> {
  systemdRunProbe ??= probe(SYSTEMD_RUN_PROBE);
  return systemdRunProbe;
}

function systemdRunIsolates(): Promise<boolean> {
  systemdRunIsolationProbe ??= probe(SYSTEMD_RUN_ISOLATION_PROBE);
  return systemdRunIsolationProbe;
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

// Why detectSandbox found none, as one clause naming the cause: a systemd-run that starts a
// service, but one that still sees the host's network, is told apart from one that does not
// start at all. Off Linux it names the platform and probes nothing.
export async function noSandboxReason(
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (platform !== "linux") return `no sandbox on ${platform}`;
  return (await systemdRunWorks())
    ? "no sandbox: bubblewrap does not work and systemd-run cannot cut the network"
    : "no sandbox: bubblewrap and systemd-run are unavailable";
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
    return { argv: systemdRunArgv(p, inner), warnings: [] };
  }
  if (await systemdRunWorks()) {
    return { argv: [...scopePrefix(p), ...bwrapArgv(p, inner)], warnings: [] };
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

// bubblewrap: no namespace shared, no environment kept, and nothing of the file system but the
// system directories, Node, hakutaku, the pinned Python, the export and the engines, all
// read-only, and the store's directory, the one writable path.
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
    ["--bind", absolute(p, "storeDir")],
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
    ...inner,
  ];
}

// systemd-run alone: a transient user service with no network, the memory cap and a low
// priority, which hakutaku waits for, its output piped through.
export function systemdRunArgv(p: SandboxPaths, inner: string[]): string[] {
  return [
    "systemd-run",
    "--user",
    "--wait",
    "--pipe",
    "--quiet",
    "--collect",
    "-p",
    "PrivateNetwork=yes",
    ...memoryCap(p),
    "-p",
    "Nice=19",
    "--",
    ...inner,
  ];
}

// The scope bubblewrap runs in to have the memory cap. --collect unloads it even when the cap
// ended it.
function scopePrefix(p: SandboxPaths): string[] {
  return [
    "systemd-run",
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    ...memoryCap(p),
    "--",
  ];
}

// MemorySwapMax=0 makes a build that reaches the cap fail at once, instead of swapping and
// crawling on.
function memoryCap(p: SandboxPaths): string[] {
  return ["-p", `MemoryMax=${p.memoryMax}`, "-p", "MemorySwapMax=0"];
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

// Whether argv runs and exits 0 within the probe timeout. The probe keeps this process's
// environment, which systemd-run needs to reach the user manager.
function probe(argv: readonly string[]): Promise<boolean> {
  const [command = "", ...args] = argv;
  return new Promise((done) => {
    const child = spawn(command, args, { stdio: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), PROBE_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(timer);
      done(false);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      done(code === 0);
    });
  });
}
