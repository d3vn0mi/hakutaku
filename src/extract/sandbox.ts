// The extraction sandbox. On Linux, extract re-runs itself inside bubblewrap or, where
// bubblewrap does not work, inside a systemd-run --user service given bubblewrap's file system:
// an empty root holding only the paths bound into it. The service is shown, from inside, to have
// no network, to reach no unix socket, to write nothing but its work directory, and to read
// neither a file outside its binds nor one through the working directory of a process of this
// machine.
// detectSandbox finds which works, once per process; the argv builders write each command. Every
// path in a command is absolute: the user manager's PATH may lack the running Node, and
// systemd-run -p takes no %h. Neither sandbox lets an engine dump core, and where this systemd
// takes OOMPolicy=continue, an engine the kernel kills at the memory cap stops only itself, so
// the build goes on without it. Each probe keeps its evidence, and a failed one names its repair.
import { type ChildProcess, spawn } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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
// Whether systemd-run starts a user service at all.
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
// Whether systemd-run starts a scope, which caps bubblewrap's memory. A user manager may start a
// service and still refuse a scope, which must move systemd-run itself into a unit of its own.
const SCOPE_PROBE = [
  "systemd-run",
  "--user",
  "--scope",
  "--quiet",
  "--collect",
  "true",
];
// The check the confinement probe runs inside its service: no network interface but loopback
// (else exit NETWORK_SEEN), the file named first written (else exit 11), each file named after
// the fourth written where it can be, which the probe then looks for on this machine; the file
// named third, outside every bind, not read (else exit 13), nor the same file through the
// working directory of a process of this machine, named fourth (else exit 14); and the unix
// socket named second out of reach (else exit 12).
const NETWORK_SEEN = 10;
const CONFINED_CHECK = [
  'const fs = require("node:fs");',
  "const [inside, socket, unbound, throughProc, ...elsewhere] = process.argv.slice(1);",
  'if (!Object.keys(require("node:os").networkInterfaces()).every((n) => n === "lo")) {',
  '  console.error("sees a network interface besides loopback");',
  `  process.exit(${NETWORK_SEEN});`,
  "}",
  "try {",
  '  fs.writeFileSync(inside, "");',
  "} catch (e) {",
  '  console.error("cannot write its bound directory: " + e.code);',
  "  process.exit(11);",
  "}",
  "for (const path of elsewhere) {",
  "  try {",
  '    fs.writeFileSync(path, "");',
  "  } catch {}",
  "}",
  "const reads = (path) => {",
  "  try {",
  "    fs.readFileSync(path);",
  "    return true;",
  "  } catch {",
  "    return false;",
  "  }",
  "};",
  "if (reads(unbound)) {",
  '  console.error("reads a file on this machine outside its bound directory");',
  "  process.exit(13);",
  "}",
  "if (reads(throughProc)) {",
  '  console.error("reads a file through the working directory of a process on this machine");',
  "  process.exit(14);",
  "}",
  'const reached = require("node:net").connect(socket);',
  'reached.on("connect", () => {',
  '  console.error("reaches a unix socket on this machine");',
  "  process.exit(12);",
  "});",
  'reached.on("error", () => {});',
].join("\n");
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
  noConfinement: "systemd-run cannot confine a service's file system",
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
const scopeProbe = (): Promise<Probe> => probeOnce(SCOPE_PROBE);

let isolation: Promise<Probe> | undefined;
const isolationProbe = (): Promise<Probe> => {
  isolation ??= confinedService();
  return isolation;
};

// Whether systemd-run can be the sandbox, as detectSandbox decides it: a service confined as a
// build's is that sees no network, reaches no unix socket, writes nothing but its bound
// directory and reads nothing outside it.
export async function confinementProbe(): Promise<{
  ok: boolean;
  evidence: ProbeEvidence;
}> {
  const probed = await isolationProbe();
  return { ok: probed.ok, evidence: evidenceOf(probed) };
}

// The confinement probe: a service with systemd-run's sandbox properties, whose one writable
// path is a directory in a probe directory of the home directory. Beside that directory, this
// process writes a file in a directory the service is not given, and starts a sleeping process
// there, through whose working directory it reads the file itself. Inside, the service must see
// no network interface but loopback, write its bound directory, read that file neither directly
// nor through /proc/<pid>/cwd of the sleeping process, and not reach the unix socket this process
// listens on in its bound directory; on this machine, only its file there may have landed, not
// the one it writes beside that directory, nor the one in /dev/shm, and nothing may have reached
// the socket. A user manager that cannot make the namespaces these need (unprivileged user
// namespaces refused) may still run the service, in the host's network and file system, and exit
// 0, so neither systemd-run's exit code nor the service's own view proves anything alone. The
// sleeping process is killed by its pid, and the probe directory and the /dev/shm file are
// removed, after.
async function confinedService(): Promise<Probe> {
  const failed = (errno: string | null, excerpt: string): Probe => ({
    ok: false,
    command: "systemd-run",
    errno,
    exitCode: null,
    signal: null,
    timedOut: false,
    excerpt,
  });
  let root: string;
  try {
    root = mkdtempSync(join(homedir(), ".hakutaku-probe-"));
  } catch (error) {
    return failed(
      (error as NodeJS.ErrnoException).code ?? "unknown error",
      "cannot make a probe directory in the home directory",
    );
  }
  const bound = join(root, "work");
  const inside = join(bound, "inside");
  const socket = join(bound, "socket");
  const unbound = join(root, "unbound");
  const canary = join(unbound, "canary");
  const beside = join(root, "beside");
  const shm = join("/dev/shm", basename(root));
  let listening: { server: Server; reached: () => number } | undefined;
  let sleeper: ChildProcess | undefined;
  try {
    mkdirSync(bound);
    mkdirSync(unbound);
    writeFileSync(canary, "");
    try {
      listening = await listenAt(socket);
    } catch (error) {
      return failed(
        (error as NodeJS.ErrnoException).code ?? "unknown error",
        "cannot listen on a probe socket in the home directory",
      );
    }
    const started = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60000)"],
      { cwd: unbound, stdio: "ignore" },
    );
    sleeper = started;
    if (started.pid === undefined) {
      // without a pid the spawn failed, and says why on its error event
      const error = await new Promise<NodeJS.ErrnoException>((done) =>
        started.once("error", done),
      );
      return failed(
        error.code ?? "unknown error",
        "cannot start a process to look at through /proc",
      );
    }
    // the service's failed read of it proves something only where this process reads it
    const throughProc = `/proc/${started.pid}/cwd/${basename(canary)}`;
    try {
      readFileSync(throughProc);
    } catch (error) {
      return failed(
        (error as NodeJS.ErrnoException).code ?? "unknown error",
        "cannot read a file through /proc on this machine",
      );
    }
    let argv: string[];
    try {
      argv = [
        "systemd-run",
        "--user",
        "--wait",
        "--pipe",
        "--quiet",
        "--collect",
        ...confinement(
          [["nodePrefix", dirname(dirname(process.execPath))]],
          ["probe directory", bound],
        ),
        "--",
        process.execPath,
        "-e",
        CONFINED_CHECK,
        inside,
        socket,
        canary,
        throughProc,
        beside,
        shm,
      ];
    } catch (error) {
      return failed(null, cleanReason((error as Error).message));
    }
    const probed = await probe(argv);
    if (!probed.ok) return probed;
    if (!exists(inside)) {
      return {
        ...probed,
        ok: false,
        excerpt: "its bound directory is not this machine's",
      };
    }
    if (exists(beside) || exists(shm)) {
      return {
        ...probed,
        ok: false,
        excerpt: "it wrote outside its bound directory",
      };
    }
    if (listening.reached() > 0) {
      return {
        ...probed,
        ok: false,
        excerpt: "it reached a unix socket on this machine",
      };
    }
    return probed;
  } finally {
    if (sleeper?.pid !== undefined) sleeper.kill("SIGKILL");
    if (listening !== undefined) {
      const { server } = listening;
      await new Promise((done) => server.close(done));
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(shm, { force: true });
  }
}

// A unix socket listening at path, and how many connections have reached it.
function listenAt(
  path: string,
): Promise<{ server: Server; reached: () => number }> {
  let reached = 0;
  const server = createServer((connection) => {
    reached += 1;
    connection.destroy();
  });
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(path, () => done({ server, reached: () => reached }));
  });
}

// Whether anything is at path, a link included, which is not followed.
function exists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

async function bwrapWorks(): Promise<boolean> {
  return (await bwrapProbe()).ok;
}

async function scopesWork(): Promise<boolean> {
  return (await scopeProbe()).ok;
}

async function systemdRunIsolates(): Promise<boolean> {
  return (await isolationProbe()).ok;
}

// The sandbox this machine has: bubblewrap, else a systemd-run service with no network and
// bubblewrap's file system, each probed at most once per process, and only on Linux.
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
// service that still sees the host's network, or that reaches a unix socket, writes outside its
// bound directory or reads outside it. None off Linux, where nothing is probed.
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
        line:
          isolation.exitCode === NETWORK_SEEN
            ? SANDBOX_REPAIRS.noNetworkCut
            : SANDBOX_REPAIRS.noConfinement,
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
// does inside the systemd-run scope that sandboxCommand puts it in where systemd-run starts a
// scope.
export async function capsMemory(sandbox: Sandbox): Promise<boolean> {
  return sandbox === "systemd-run" || (await scopesWork());
}

// The command that runs inner in a sandbox detectSandbox found, and the warnings it
// brings. bubblewrap caps no memory, so it runs inside a systemd-run scope that does wherever
// systemd-run starts a scope.
export async function sandboxCommand(
  sandbox: Sandbox,
  p: SandboxPaths,
  inner: string[],
): Promise<{ argv: string[]; warnings: string[] }> {
  if (sandbox === "systemd-run") {
    const oomContinue = (await probeOnce(OOM_SERVICE_PROBE)).ok;
    return { argv: systemdRunArgv(p, inner, { oomContinue }), warnings: [] };
  }
  if (await scopesWork()) {
    const oomContinue = (await probeOnce(OOM_SCOPE_PROBE)).ok;
    return {
      argv: [...scopePrefix(p, oomContinue), ...bwrapArgv(p, inner)],
      warnings: [],
    };
  }
  return { argv: bwrapArgv(p, inner), warnings: [NO_MEMORY_CAP] };
}

// What a dynamically linked program needs, read-only, in both sandboxes. Each but /usr may be
// missing, or be a link into /usr, which the bind follows.
const SYSTEM_BINDS: ReadonlyArray<readonly [string, string]> = [
  ["--ro-bind", "/usr"],
  ["--ro-bind-try", "/bin"],
  ["--ro-bind-try", "/lib"],
  ["--ro-bind-try", "/lib64"],
  ["--ro-bind-try", "/sbin"],
  ["--ro-bind-try", "/etc/ld.so.cache"],
  ["--ro-bind-try", "/etc/alternatives"],
];

// The host name bubblewrap gives its own UTS namespace, so that uname(2) inside never names this
// machine.
const HOSTNAME = "sandbox";

// The shell bubblewrap runs inner through, which sets the core limit, soft and hard, to 0 first:
// a scope takes no LimitCORE, and the shell is on every system bubblewrap binds.
const NO_CORE = ["/bin/sh", "-c", 'ulimit -c 0 && exec "$@"', "sh"];

// bubblewrap: no namespace shared, a host name of its own, no environment kept, and nothing of
// the file system but the system directories, Node, hakutaku, the pinned Python, the export and
// the engines, all read-only, and the build's work directory, the one writable path. inner runs
// with no core dumps.
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
    "--hostname",
    HOSTNAME,
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

// systemd-run alone: a transient user service with no network, bubblewrap's file system (the
// system directories, Node, hakutaku, the pinned Python, the export and the engines read-only,
// and the work directory the one writable path, in an otherwise empty root), the memory cap, no
// core dumps and a low priority, which hakutaku waits for, its output piped through. oomContinue
// says this systemd's services take OOMPolicy=continue.
export function systemdRunArgv(
  p: SandboxPaths,
  inner: string[],
  opts: { oomContinue?: boolean } = {},
): string[] {
  const readOnly: Array<[string, string]> = [
    ["nodePrefix", absolute(p, "nodePrefix")],
    ["packageRoot", absolute(p, "packageRoot")],
  ];
  if (p.pythonPrefix !== null) {
    readOnly.push(["pythonPrefix", absolute(p, "pythonPrefix")]);
  }
  readOnly.push(
    ["exportDir", absolute(p, "exportDir")],
    ["enginesDir", absolute(p, "enginesDir")],
  );
  return [
    "systemd-run",
    "--user",
    "--wait",
    "--pipe",
    "--quiet",
    "--collect",
    ...confinement(readOnly, ["workDir", absolute(p, "workDir")]),
    ...memoryCap(p, opts.oomContinue === true),
    "-p",
    "LimitCORE=0",
    "-p",
    "Nice=19",
    "--",
    ...inner,
  ];
}

// What gives a systemd-run service bubblewrap's file system and no network, where the user
// manager can apply it: an empty root, which holds no file of this machine but what is bound in
// it, beside the API file systems (/proc, /sys, /dev and an empty /run) and a private /tmp; /dev
// private, /dev/shm private too (a private /dev keeps the host's), no new privileges and no
// set-user-ID or set-group-ID files; the control groups read-only, since the service's own would
// let it lift its memory cap, and the user's other services' would let it stop them; and no
// socket but a netlink one, which lists the network interfaces, since a unix socket in a bound
// directory can still be reached through a read-only bind. Then bubblewrap's system directories,
// read-only, the '-' prefix skipping each that is missing, as --ro-bind-try does; the read-only
// binds of the fields; and the one writable bind. Each pair is the field a path comes from, which
// a refusal names, and the path.
function confinement(
  readOnly: ReadonlyArray<readonly [string, string]>,
  writable: readonly [string, string],
): string[] {
  return [
    "-p",
    "PrivateNetwork=yes",
    "-p",
    "TemporaryFileSystem=/",
    "-p",
    "MountAPIVFS=yes",
    "-p",
    "PrivateTmp=yes",
    "-p",
    "PrivateDevices=yes",
    "-p",
    "TemporaryFileSystem=/dev/shm",
    "-p",
    "NoNewPrivileges=yes",
    "-p",
    "RestrictSUIDSGID=yes",
    "-p",
    "ProtectControlGroups=yes",
    "-p",
    "RestrictAddressFamilies=AF_NETLINK",
    ...SYSTEM_BINDS.flatMap(([flag, path]) => [
      "-p",
      `BindReadOnlyPaths=${flag === "--ro-bind-try" ? "-" : ""}${path}`,
    ]),
    ...readOnly.flatMap(([field, path]) => [
      "-p",
      `BindReadOnlyPaths=${quoted(field, path)}`,
    ]),
    "-p",
    `BindPaths=${quoted(...writable)}`,
  ];
}

// A path as a bind property reads it: in double quotes, which keep a space or a colon in it as
// part of the path. A path holding a quote, a backslash or a control character is refused, since
// a quote cannot carry it.
function quoted(field: string, path: string): string {
  const unquotable = [...path].some((c) => {
    const code = c.charCodeAt(0);
    return c === '"' || c === "\\" || code < 0x20 || code === 0x7f;
  });
  if (unquotable) {
    throw new Error(
      `sandbox: ${field} cannot be bound by systemd-run: ${JSON.stringify(path)}`,
    );
  }
  return `"${path}"`;
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
