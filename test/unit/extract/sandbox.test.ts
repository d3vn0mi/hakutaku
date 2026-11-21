import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  bwrapArgv,
  confinementProbe,
  detectSandbox,
  evidenceLine,
  type SandboxPaths,
  sandboxCommand,
  systemdRunArgv,
} from "../../../src/extract/sandbox.js";
import {
  commandProbe,
  type LiveProbe,
  requireInCI,
} from "../../helpers/live.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// A fresh directory under the OS temp directory, removed after the file's last test.
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-sandbox-"));
  made.push(dir);
  return dir;
};

const paths: SandboxPaths = {
  exportDir: "/srv/observatory/export",
  enginesDir: "/srv/observatory/engines",
  workDir: "/srv/observatory/store/work.tmp-4242",
  packageRoot: "/opt/hakutaku",
  nodePrefix: "/opt/node",
  pythonPrefix: "/opt/python",
  memoryMax: "3G",
};
const inner = [
  "/opt/node/bin/node",
  "/opt/hakutaku/dist/cli/main.js",
  "extract",
];
const BWRAP_PROBE = "bwrap --unshare-all --die-with-parent --ro-bind / / true";
const SYSTEMD_RUN_PROBE =
  "systemd-run --user --wait --quiet --collect -p PrivateNetwork=yes true";
// Whether this systemd takes OOMPolicy=continue, for a scope and for a service.
const OOM_SCOPE_PROBE =
  "systemd-run --user --scope --quiet --collect -p OOMPolicy=continue true";
const OOM_SERVICE_PROBE =
  "systemd-run --user --wait --quiet --collect -p OOMPolicy=continue true";
// What bubblewrap runs inner through: a shell that sets the core limit to 0 first.
const NO_CORE = ["/bin/sh", "-c", 'ulimit -c 0 && exec "$@"', "sh"];
// The properties that give a systemd-run service bubblewrap's file system and no network, before
// its binds: every directory read-only, the home directories, /tmp, /dev and /dev/shm private,
// no new privileges and no set-user-ID or set-group-ID files, the control groups read-only, and
// no socket but a netlink one, so that no unix socket the read-only file system shows can be
// reached.
const CONFINED = [
  "-p",
  "PrivateNetwork=yes",
  "-p",
  "ProtectSystem=strict",
  "-p",
  "ProtectHome=tmpfs",
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
];
// The probe that takes systemd-run as the sandbox, as the stand-ins log it, up to the "--" that
// starts its check: a service confined as a build's is, its one writable directory in a probe
// directory under the home directory.
const ISOLATION_PROBE = expect.stringMatching(
  new RegExp(
    `^systemd-run --user --wait --pipe --quiet --collect ${CONFINED.join(" ")} -p BindReadOnlyPaths="[^"]+" -p BindPaths="[^"]+/\\.hakutaku-probe-\\w+/work" --$`,
  ),
);

// The [source, destination] pair after each occurrence of flag.
const pairsAfter = (a: string[], flag: string): string[][] =>
  a.flatMap((arg, i) => (arg === flag ? [a.slice(i + 1, i + 3)] : []));

// The mounts of the given paths, as [flag, path] pairs in argv order: what follows --tmpfs /tmp.
const userMounts = (a: string[]): string[][] => {
  const from = a.indexOf("--tmpfs") + 2;
  const to = a.indexOf("--setenv");
  const mounts: string[][] = [];
  for (let i = from; i < to; i += 3) mounts.push([a[i] ?? "", a[i + 1] ?? ""]);
  return mounts;
};

it("binds the export and engines read-only and only the work directory writable", () => {
  const a = bwrapArgv(paths, ["node", "main.js"]);
  expect(a).toEqual(
    expect.arrayContaining([
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--clearenv",
    ]),
  );
  expect(pairsAfter(a, "--ro-bind")).toEqual(
    expect.arrayContaining([
      [paths.exportDir, paths.exportDir],
      [paths.enginesDir, paths.enginesDir],
    ]),
  );
  expect(pairsAfter(a, "--bind")).toEqual([[paths.workDir, paths.workDir]]);
  expect(a.slice(-2)).toEqual(["node", "main.js"]);
});

it("sets PrivateNetwork and MemoryMax for systemd-run", () =>
  expect(systemdRunArgv(paths, ["x"])).toEqual(
    expect.arrayContaining(["-p", "PrivateNetwork=yes", "-p", "MemoryMax=3G"]),
  ));

it("finds no sandbox off Linux", async () =>
  expect(await detectSandbox("darwin")).toBeNull());

it("writes the whole bubblewrap command, each path bound at its own path", () => {
  const bind = (flag: string, path: string) => [flag, path, path];
  expect(bwrapArgv(paths, inner)).toEqual([
    "bwrap",
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    ...bind("--ro-bind", "/usr"),
    ...bind("--ro-bind-try", "/bin"),
    ...bind("--ro-bind-try", "/lib"),
    ...bind("--ro-bind-try", "/lib64"),
    ...bind("--ro-bind-try", "/sbin"),
    ...bind("--ro-bind-try", "/etc/ld.so.cache"),
    ...bind("--ro-bind-try", "/etc/alternatives"),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    ...bind("--ro-bind", "/opt/node"),
    ...bind("--ro-bind", "/opt/hakutaku"),
    ...bind("--ro-bind", "/opt/python"),
    ...bind("--ro-bind", "/srv/observatory/export"),
    ...bind("--ro-bind", "/srv/observatory/engines"),
    ...bind("--bind", "/srv/observatory/store/work.tmp-4242"),
    "--setenv",
    "HOME",
    "/tmp",
    "--setenv",
    "LANG",
    "C.UTF-8",
    ...NO_CORE,
    ...inner,
  ]);
});

it("binds no Python prefix when there is none", () =>
  expect(
    userMounts(bwrapArgv({ ...paths, pythonPrefix: null }, inner)),
  ).toEqual([
    ["--ro-bind", "/opt/node"],
    ["--ro-bind", "/opt/hakutaku"],
    ["--ro-bind", "/srv/observatory/export"],
    ["--ro-bind", "/srv/observatory/engines"],
    ["--bind", "/srv/observatory/store/work.tmp-4242"],
  ]));

it("binds a directory before the directories inside it, so the writable work directory cannot cover a read-only one", () =>
  expect(
    userMounts(
      bwrapArgv(
        {
          ...paths,
          workDir: "/srv/observatory",
          exportDir: "/srv/observatory/export",
          enginesDir: "/srv/observatory/engines",
          pythonPrefix: null,
        },
        inner,
      ),
    ),
  ).toEqual([
    ["--ro-bind", "/opt/node"],
    ["--ro-bind", "/opt/hakutaku"],
    ["--bind", "/srv/observatory"],
    ["--ro-bind", "/srv/observatory/export"],
    ["--ro-bind", "/srv/observatory/engines"],
  ]));

it("binds each path in its normal form", () =>
  expect(
    pairsAfter(
      bwrapArgv(
        {
          ...paths,
          enginesDir: "/srv/observatory/engines/",
          workDir: "/srv/observatory/x/../work",
        },
        inner,
      ),
      "--bind",
    ),
  ).toEqual([["/srv/observatory/work", "/srv/observatory/work"]]));

it.each([
  "exportDir",
  "enginesDir",
  "workDir",
  "packageRoot",
  "nodePrefix",
  "pythonPrefix",
])("refuses a %s that is not an absolute path", (field) =>
  expect(() => bwrapArgv({ ...paths, [field]: "observatory" }, inner)).toThrow(
    `sandbox: ${field} is not an absolute path: "observatory"`,
  ),
);

it("writes the whole systemd-run command: bubblewrap's file system, only the work directory writable, no swap beyond the memory cap and no core dumps", () => {
  const head = [
    "systemd-run",
    "--user",
    "--wait",
    "--pipe",
    "--quiet",
    "--collect",
    ...CONFINED,
    "-p",
    'BindReadOnlyPaths="/opt/node"',
    "-p",
    'BindReadOnlyPaths="/opt/hakutaku"',
    "-p",
    'BindReadOnlyPaths="/opt/python"',
    "-p",
    'BindReadOnlyPaths="/srv/observatory/export"',
    "-p",
    'BindReadOnlyPaths="/srv/observatory/engines"',
    "-p",
    'BindPaths="/srv/observatory/store/work.tmp-4242"',
    "-p",
    "MemoryMax=15G",
    "-p",
    "MemorySwapMax=0",
  ];
  const tail = ["-p", "LimitCORE=0", "-p", "Nice=19", "--", ...inner];
  expect(systemdRunArgv({ ...paths, memoryMax: "15G" }, inner)).toEqual([
    ...head,
    ...tail,
  ]);
  // where this systemd takes it, an engine the kernel kills at the cap stops only itself
  expect(
    systemdRunArgv({ ...paths, memoryMax: "15G" }, inner, {
      oomContinue: true,
    }),
  ).toEqual([...head, "-p", "OOMPolicy=continue", ...tail]);
});

// systemd-run splits a bind at a space or a colon outside quotes, so each path is quoted, and a
// path holding what a quote cannot carry is refused rather than bound wrong.
it("quotes each path systemd-run binds, and refuses one a quote cannot carry", () => {
  const argv = systemdRunArgv(
    {
      ...paths,
      pythonPrefix: null,
      exportDir: "/srv/sky charts:2026/export",
      workDir: "/srv/sky charts:2026/store/work.tmp-4242",
    },
    inner,
  );
  expect(argv).toContain('BindReadOnlyPaths="/srv/sky charts:2026/export"');
  expect(argv).toContain(
    'BindPaths="/srv/sky charts:2026/store/work.tmp-4242"',
  );
  expect(argv).not.toContain('BindReadOnlyPaths="/opt/python"');
  for (const workDir of [
    '/srv/sky"/work',
    "/srv/sky\\/work",
    "/srv/sky\n/work",
  ]) {
    expect(() => systemdRunArgv({ ...paths, workDir }, inner)).toThrow(
      `sandbox: workDir cannot be bound by systemd-run: ${JSON.stringify(workDir)}`,
    );
  }
  expect(() =>
    systemdRunArgv({ ...paths, exportDir: "export" }, inner),
  ).toThrow('sandbox: exportDir is not an absolute path: "export"');
});

// Stand-ins for bwrap and systemd-run on a PATH holding nothing else. Each appends its name and
// arguments to the log, up to a "--" that starts the command it would run, writes what it is
// given to say on stderr, then exits with its code; a tool given no code is not on the PATH.
// systemd-run fails a probe of OOMPolicy when told to, and one that exits 0 writes the file the
// confinement check names first, as a confined service does. HOME is a fresh directory, which
// holds the confinement probe's directory.
function fakeTools(
  codes: Partial<Record<"bwrap" | "systemd-run", number>>,
  opts: {
    said?: Partial<Record<"bwrap" | "systemd-run", string>>;
    noOomPolicy?: boolean;
  } = {},
): string {
  const bin = tmp();
  const log = join(bin, "log");
  writeFileSync(log, "");
  for (const [name, code] of Object.entries(codes)) {
    const file = join(bin, name);
    const said = opts.said?.[name as "bwrap" | "systemd-run"];
    writeFileSync(
      file,
      [
        "#!/bin/sh",
        `line="${name}"`,
        'for a in "$@"; do line="$line $a"; [ "$a" = "--" ] && break; done',
        `echo "$line" >> "${log}"`,
        ...(opts.noOomPolicy === true
          ? [
              'case "$*" in *OOMPolicy=*) echo "Unknown assignment: OOMPolicy=continue" >&2; exit 1;; esac',
            ]
          : []),
        ...(said === undefined
          ? []
          : [`printf '%s\\n' ${JSON.stringify(said)} >&2`]),
        ...(code === 0
          ? [
              'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done',
              '[ "$#" -ge 5 ] && : > "$5"',
            ]
          : []),
        `exit ${code}`,
        "",
      ].join("\n"),
    );
    chmodSync(file, 0o755);
  }
  vi.stubEnv("PATH", bin);
  vi.stubEnv("HOME", tmp());
  return log;
}

const logged = (log: string): string[] =>
  readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "");

// A fresh copy of the module, whose probes have not run yet in this process.
async function freshSandbox(): Promise<
  typeof import("../../../src/extract/sandbox.js")
> {
  vi.resetModules();
  return await import("../../../src/extract/sandbox.js");
}

it("runs no probe off Linux", async () => {
  const log = fakeTools({ bwrap: 0, "systemd-run": 0 });
  const s = await freshSandbox();
  expect(await s.detectSandbox("darwin")).toBeNull();
  expect(logged(log)).toEqual([]);
});

it("probes bubblewrap first, and only once per process", async () => {
  const log = fakeTools({ bwrap: 0, "systemd-run": 0 });
  const s = await freshSandbox();
  expect(await s.detectSandbox("linux")).toBe("bubblewrap");
  expect(await s.detectSandbox("linux")).toBe("bubblewrap");
  expect(logged(log)).toEqual([BWRAP_PROBE]);
});

it("falls back to systemd-run when bubblewrap fails, probing each once", async () => {
  const log = fakeTools({ bwrap: 1, "systemd-run": 0 });
  const s = await freshSandbox();
  expect(await s.detectSandbox("linux")).toBe("systemd-run");
  expect(await s.detectSandbox("linux")).toBe("systemd-run");
  expect(logged(log)).toEqual([BWRAP_PROBE, ISOLATION_PROBE]);
});

// A systemd-run stand-in that runs what follows "--" in place of a service, and exits 0 when
// nothing does: in the host's network and file system, as a user manager that cannot make
// namespaces runs a service; through bubblewrap with no network but the host's file system
// writable; through bubblewrap with no network and only the directory BindPaths names writable,
// but a unix socket there still reachable, as a user manager that drops the address-family
// filter; or as that, with the probe's socket out of reach, as a confined service. HOME is a
// fresh directory.
function standInSystemdRun(
  service: "host" | "network cut" | "sockets open" | "confined",
): void {
  const bin = tmp();
  const file = join(bin, "systemd-run");
  const bwrap = BWRAP_PATH ?? "bwrap";
  // the probe's socket, named after the file its check must write, covered by a file that is none
  const noSocket = '--ro-bind /dev/null "$5"';
  const run =
    service === "host"
      ? 'exec "$@"'
      : service === "network cut"
        ? `exec ${bwrap} --unshare-net --die-with-parent --bind / / --dev /dev ${noSocket} -- "$@"`
        : `exec ${bwrap} --unshare-all --die-with-parent --ro-bind / / --dev /dev --bind "$bound" "$bound"${service === "confined" ? ` ${noSocket}` : ""} -- "$@"`;
  writeFileSync(
    file,
    [
      "#!/bin/sh",
      'bound=""',
      'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template
      '  case "$1" in BindPaths=*) bound="${1#BindPaths=\\"}"; bound="${bound%\\"}";; esac',
      "  shift",
      "done",
      '[ "$#" -gt 0 ] || exit 0',
      "shift",
      run,
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
  vi.stubEnv("PATH", bin);
  vi.stubEnv("HOME", tmp());
}
const hostNetworkSystemdRun = (): void => standInSystemdRun("host");

// Where bwrap is, for the stand-ins that run a service through it with PATH holding no bwrap.
const BWRAP_PATH = (() => {
  const r = spawnSync("/bin/sh", ["-c", "command -v bwrap"], {
    encoding: "utf8",
  });
  return r.status === 0 ? r.stdout.trim() : null;
})();
// The tests of a service in the host's network need a host network that differs from loopback.
const hostInterfaces = Object.keys(networkInterfaces());
const hostNetwork: LiveProbe = {
  name: "a network interface besides loopback",
  ok: hostInterfaces.some((name) => name !== "lo"),
  evidence: `this host has ${hostInterfaces.join(", ") || "none"}`,
};

it("does not take systemd-run as the sandbox when its service sees the host's network", async (ctx) => {
  requireInCI(ctx, hostNetwork);
  hostNetworkSystemdRun();
  const s = await freshSandbox();
  expect(await s.detectSandbox("linux")).toBeNull();
});

it.each<[string, Partial<Record<"bwrap" | "systemd-run", number>>]>([
  ["both fail", { bwrap: 1, "systemd-run": 1 }],
  ["neither is installed", {}],
])("finds no sandbox on Linux when %s", async (_, codes) => {
  fakeTools(codes);
  const s = await freshSandbox();
  expect(await s.detectSandbox("linux")).toBeNull();
});

it.each<[string, Partial<Record<"bwrap" | "systemd-run", number>>, string]>([
  [
    "both fail",
    { bwrap: 1, "systemd-run": 1 },
    "no sandbox: user namespaces are refused; no user manager can be reached",
  ],
  [
    "neither is installed",
    {},
    "no sandbox: bubblewrap is not installed; no user manager can be reached",
  ],
])("names the repair of each tool when %s", async (_, codes, reason) => {
  fakeTools(codes);
  const s = await freshSandbox();
  expect(await s.detectSandbox("linux")).toBeNull();
  expect(await s.noSandboxReason("linux")).toBe(reason);
});

it("keeps each failed probe's evidence: its error code, its exit, and the last line it said, cleaned", async () => {
  // assembled here, never written whole
  const secret = ["gh", "p_", "Q7x2M4p9K3l8N5r6".repeat(3)].join("");
  fakeTools(
    { bwrap: 1, "systemd-run": 1 },
    {
      said: {
        bwrap: "bwrap: setting up uid map: Permission denied",
        "systemd-run": `Failed to connect to bus at /srv/astronomer/bus: token=${secret}`,
      },
    },
  );
  vi.stubEnv("HOME", "/srv/astronomer");
  const s = await freshSandbox();
  const problems = await s.sandboxProblems("linux");
  expect(problems.map((p) => p.line)).toEqual([
    "user namespaces are refused",
    "no user manager can be reached",
  ]);
  expect(problems.map((p) => s.evidenceLine(p.evidence))).toEqual([
    "bwrap: exit code 1: bwrap: setting up uid map: Permission denied",
    "systemd-run: exit code 1: Failed to connect to bus at ~/bus: token=«redacted:github-token»",
  ]);
  expect(problems[0]?.evidence).toMatchObject({
    command: "bwrap",
    errno: null,
    exitCode: 1,
    signal: null,
    timedOut: false,
  });
  // a tool that is not installed could not start, which its error code says
  fakeTools({});
  const none = await freshSandbox();
  expect(
    (await none.sandboxProblems("linux")).map((p) =>
      none.evidenceLine(p.evidence),
    ),
  ).toEqual([
    "bwrap: could not start: ENOENT",
    "systemd-run: could not start: ENOENT",
  ]);
});

it("finds no problem where bubblewrap and systemd-run both work, and none off Linux", async () => {
  const log = fakeTools({ bwrap: 0, "systemd-run": 0 });
  const s = await freshSandbox();
  expect(await s.sandboxProblems("linux")).toEqual([]);
  // the network check matters only where bubblewrap does not work
  expect(logged(log)).toEqual([BWRAP_PROBE, SYSTEMD_RUN_PROBE]);
  expect(await s.sandboxProblems("darwin")).toEqual([]);
});

it("says systemd-run cannot cut the network when its service runs in the host's network", async (ctx) => {
  requireInCI(ctx, hostNetwork);
  hostNetworkSystemdRun();
  const s = await freshSandbox();
  expect(await s.detectSandbox("linux")).toBeNull();
  expect(await s.noSandboxReason("linux")).toBe(
    "no sandbox: bubblewrap is not installed; systemd-run cannot cut the network",
  );
  expect(
    (await s.sandboxProblems("linux")).map((p) => [
      p.line,
      s.evidenceLine(p.evidence),
    ]),
  ).toEqual([
    ["bubblewrap is not installed", "bwrap: could not start: ENOENT"],
    [
      "systemd-run cannot cut the network",
      "systemd-run: exit code 10: sees a network interface besides loopback",
    ],
  ]);
});

// The service's own view cannot tell a private file system from the host's, so the probe looks
// on the host for what the service wrote.
it("says systemd-run cannot confine a service's file system when its service writes outside its bound directory", async (ctx) => {
  requireInCI(ctx, bwrap);
  standInSystemdRun("network cut");
  const s = await freshSandbox();
  expect(await s.detectSandbox("linux")).toBeNull();
  expect(
    (await s.sandboxProblems("linux")).map((p) => [
      p.line,
      s.evidenceLine(p.evidence),
    ]),
  ).toEqual([
    ["bubblewrap is not installed", "bwrap: could not start: ENOENT"],
    [
      "systemd-run cannot confine a service's file system",
      "systemd-run: exit code 0: it wrote outside its bound directory",
    ],
  ]);
  // nothing of the probe is left in the home directory
  expect(readdirSync(process.env.HOME ?? "")).toEqual([]);
});

// A read-only file system still lets a unix socket in it be reached, so the probe listens on one
// in the service's bound directory, which the service must not reach.
it("says systemd-run cannot confine a service's file system when its service reaches a unix socket on this machine", async (ctx) => {
  requireInCI(ctx, bwrap);
  standInSystemdRun("sockets open");
  const s = await freshSandbox();
  expect(await s.detectSandbox("linux")).toBeNull();
  expect(
    (await s.sandboxProblems("linux")).map((p) => [
      p.line,
      s.evidenceLine(p.evidence),
    ]),
  ).toEqual([
    ["bubblewrap is not installed", "bwrap: could not start: ENOENT"],
    [
      "systemd-run cannot confine a service's file system",
      "systemd-run: exit code 12: reaches a unix socket on this machine",
    ],
  ]);
  expect(readdirSync(process.env.HOME ?? "")).toEqual([]);
});

it("takes systemd-run as the sandbox when its service has no network and writes only its bound directory", async (ctx) => {
  requireInCI(ctx, bwrap);
  standInSystemdRun("confined");
  const s = await freshSandbox();
  expect(await s.detectSandbox("linux")).toBe("systemd-run");
  expect(await s.sandboxProblems("linux")).toEqual([
    {
      line: "bubblewrap is not installed",
      evidence: expect.objectContaining({ errno: "ENOENT" }),
    },
  ]);
  expect(readdirSync(process.env.HOME ?? "")).toEqual([]);
});

it("names the platform off Linux, running no probe", async () => {
  const log = fakeTools({ bwrap: 0, "systemd-run": 0 });
  const s = await freshSandbox();
  expect(await s.noSandboxReason("darwin")).toBe("no sandbox on darwin");
  expect(logged(log)).toEqual([]);
});

const SCOPE = [
  "systemd-run",
  "--user",
  "--scope",
  "--quiet",
  "--collect",
  "-p",
  "MemoryMax=3G",
  "-p",
  "MemorySwapMax=0",
];

it("runs bubblewrap under a systemd-run scope with the memory cap, where one engine at the cap stops only itself", async () => {
  const log = fakeTools({ bwrap: 0, "systemd-run": 0 });
  const s = await freshSandbox();
  expect(await s.detectSandbox("linux")).toBe("bubblewrap");
  const scoped = {
    argv: [
      ...SCOPE,
      "-p",
      "OOMPolicy=continue",
      "--",
      ...s.bwrapArgv(paths, inner),
    ],
    warnings: [],
  };
  expect(await s.sandboxCommand("bubblewrap", paths, inner)).toEqual(scoped);
  expect(await s.sandboxCommand("bubblewrap", paths, inner)).toEqual(scoped);
  expect(logged(log)).toEqual([
    BWRAP_PROBE,
    SYSTEMD_RUN_PROBE,
    OOM_SCOPE_PROBE,
  ]);
});

it("leaves OOMPolicy out of the scope where this systemd does not take it", async () => {
  fakeTools({ bwrap: 0, "systemd-run": 0 }, { noOomPolicy: true });
  const s = await freshSandbox();
  expect(await s.sandboxCommand("bubblewrap", paths, inner)).toEqual({
    argv: [...SCOPE, "--", ...s.bwrapArgv(paths, inner)],
    warnings: [],
  });
});

it("says a sandbox caps memory when systemd-run is the sandbox, or caps bubblewrap's scope", async () => {
  const works = fakeTools({ bwrap: 0, "systemd-run": 0 });
  const s = await freshSandbox();
  expect(await s.capsMemory("systemd-run")).toBe(true);
  expect(logged(works)).toEqual([]);
  expect(await s.capsMemory("bubblewrap")).toBe(true);
  expect(logged(works)).toEqual([SYSTEMD_RUN_PROBE]);
  fakeTools({ bwrap: 0, "systemd-run": 1 });
  const without = await freshSandbox();
  expect(await without.capsMemory("bubblewrap")).toBe(false);
});

it("runs bubblewrap without a memory cap, and warns, when systemd-run does not work", async () => {
  fakeTools({ bwrap: 0, "systemd-run": 1 });
  const s = await freshSandbox();
  expect(await s.sandboxCommand("bubblewrap", paths, inner)).toEqual({
    argv: s.bwrapArgv(paths, inner),
    warnings: ["no memory cap: systemd-run is unavailable"],
  });
});

it("runs systemd-run alone when it is the sandbox, with OOMPolicy where its services take it", async () => {
  const log = fakeTools({ bwrap: 1, "systemd-run": 0 });
  const s = await freshSandbox();
  expect(await s.detectSandbox("linux")).toBe("systemd-run");
  expect(await s.sandboxCommand("systemd-run", paths, inner)).toEqual({
    argv: s.systemdRunArgv(paths, inner, { oomContinue: true }),
    warnings: [],
  });
  expect(logged(log)).toEqual([
    BWRAP_PROBE,
    ISOLATION_PROBE,
    OOM_SERVICE_PROBE,
  ]);
  fakeTools({ bwrap: 1, "systemd-run": 0 }, { noOomPolicy: true });
  const old = await freshSandbox();
  expect(await old.sandboxCommand("systemd-run", paths, inner)).toEqual({
    argv: old.systemdRunArgv(paths, inner),
    warnings: [],
  });
});

// The live runs below need the real tools: each runs where its probes pass, is skipped where one
// fails, and fails in CI where one fails.
const bwrap = commandProbe("bubblewrap", BWRAP_PROBE.split(" "));
const userManager = commandProbe(
  "a systemd user manager",
  SYSTEMD_RUN_PROBE.split(" "),
);
// The probe detectSandbox takes systemd-run on, run here as it is: a service with no network that
// writes only its bound directory.
const confined = await confinementProbe();
const confiningManager: LiveProbe = {
  name: "a systemd user manager that confines a service's network and file system",
  ok: confined.ok,
  evidence: evidenceLine(confined.evidence),
};
const oomScope = commandProbe(
  "OOMPolicy on a systemd-run scope",
  OOM_SCOPE_PROBE.split(" "),
);

// A sandbox's directories under the OS temp directory, a file in the export, a directory
// outside every bind, and the store's directory, which holds the work directory and is not
// bound itself.
function liveLayout(): { p: SandboxPaths; outside: string; storeDir: string } {
  const root = tmp();
  const storeDir = join(root, "store");
  const p: SandboxPaths = {
    exportDir: join(root, "export"),
    enginesDir: join(root, "engines"),
    workDir: join(storeDir, "work.tmp-1"),
    packageRoot: join(root, "package"),
    nodePrefix: dirname(dirname(process.execPath)),
    pythonPrefix: null,
    memoryMax: "3G",
  };
  const outside = join(root, "outside");
  for (const d of [
    p.exportDir,
    p.enginesDir,
    p.workDir,
    p.packageRoot,
    outside,
  ])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(p.exportDir, "export.json"), "{}\n");
  return { p, outside, storeDir };
}

// A script that reports what it can see and write. It also writes beside the work directory,
// in the store's directory, which only the host can say did not happen there.
const report = (p: SandboxPaths, outside: string): string => `
const fs = require("node:fs");
const os = require("node:os");
const write = (dir) => { try { fs.writeFileSync(dir + "/probe", "x"); return "written"; } catch (e) { return e.code; } };
write(${JSON.stringify(dirname(p.workDir))});
console.log(JSON.stringify({
  env: Object.keys(process.env).sort(),
  home: process.env.HOME,
  read: fs.readFileSync(${JSON.stringify(join(p.exportDir, "export.json"))}, "utf8"),
  export: write(${JSON.stringify(p.exportDir)}),
  engines: write(${JSON.stringify(p.enginesDir)}),
  package: write(${JSON.stringify(p.packageRoot)}),
  work: write(${JSON.stringify(p.workDir)}),
  outside: fs.existsSync(${JSON.stringify(outside)}),
  network: Object.keys(os.networkInterfaces()).sort(),
  core: /^Max core file size +(\\S+) +(\\S+)/m.exec(fs.readFileSync("/proc/self/limits", "utf8")).slice(1).join(" "),
}));`;

const SEEN_IN_BUBBLEWRAP = {
  env: ["HOME", "LANG", "PWD"], // bubblewrap sets PWD itself
  home: "/tmp",
  read: "{}\n",
  export: "EROFS",
  engines: "EROFS",
  package: "EROFS",
  work: "written",
  outside: false,
  network: ["lo"],
  core: "0 0", // soft and hard: no core dumps, nor a way to turn them back on
};

// What the host sees after the script: its file in the work directory, and none beside it.
const writtenOnHost = (p: SandboxPaths, storeDir: string) => ({
  work: existsSync(join(p.workDir, "probe")),
  beside: existsSync(join(storeDir, "probe")),
});

const runArgv = (argv: string[]) => {
  const r = spawnSync(argv[0] ?? "", argv.slice(1), {
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
};

it("runs a command in bubblewrap that reads the export, writes only the work directory and has no network", (ctx) => {
  requireInCI(ctx, bwrap);
  const { p, outside, storeDir } = liveLayout();
  const r = runArgv(bwrapArgv(p, [process.execPath, "-e", report(p, outside)]));
  expect(r.err).toBe("");
  expect(r.status).toBe(0);
  expect(JSON.parse(r.out)).toEqual(SEEN_IN_BUBBLEWRAP);
  expect(writtenOnHost(p, storeDir)).toEqual({ work: true, beside: false });
});

it("runs bubblewrap inside a systemd-run scope", async (ctx) => {
  requireInCI(ctx, bwrap, userManager);
  const { p, outside, storeDir } = liveLayout();
  const { argv, warnings } = await sandboxCommand("bubblewrap", p, [
    process.execPath,
    "-e",
    report(p, outside),
  ]);
  expect(argv[0]).toBe("systemd-run");
  expect(warnings).toEqual([]);
  const r = runArgv(argv);
  expect(r.status).toBe(0);
  expect(JSON.parse(r.out)).toEqual(SEEN_IN_BUBBLEWRAP);
  expect(writtenOnHost(p, storeDir)).toEqual({ work: true, beside: false });
});

// systemd-run has no view of its own of what it confines: the script reports what it can read
// and write, and the host says where its writes landed.
it("runs a command under systemd-run that reads the export, writes only the work directory and has no network", (ctx) => {
  requireInCI(ctx, confiningManager);
  const { p, outside, storeDir } = liveLayout();
  const r = runArgv(
    systemdRunArgv(p, [process.execPath, "-e", report(p, outside)]),
  );
  expect(r.status).toBe(0);
  expect(JSON.parse(r.out)).toMatchObject({
    read: "{}\n",
    export: "EROFS",
    engines: "EROFS",
    package: "EROFS",
    work: "written",
    outside: false,
    network: ["lo"],
    core: "0 0",
  });
  expect(writtenOnHost(p, storeDir)).toEqual({ work: true, beside: false });
});

it("runs a command under systemd-run with no network, nice 19 and the memory cap", (ctx) => {
  requireInCI(ctx, confiningManager);
  const { p } = liveLayout();
  const script = `
const fs = require("node:fs");
const os = require("node:os");
const cgroup = fs.readFileSync("/proc/self/cgroup", "utf8").trim().split("::")[1];
const read = (name) => { const f = "/sys/fs/cgroup" + cgroup + "/" + name; return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : null; };
console.log(JSON.stringify({ nice: os.getPriority(), network: Object.keys(os.networkInterfaces()).sort(), memoryMax: read("memory.max"), swapMax: read("memory.swap.max") }));`;
  const r = runArgv(systemdRunArgv(p, [process.execPath, "-e", script]));
  expect(r.status).toBe(0);
  const seen = JSON.parse(r.out);
  expect(seen).toMatchObject({
    nice: 19,
    network: ["lo"],
    memoryMax: String(3 * 1024 ** 3),
  });
  expect(["0", null]).toContain(seen.swapMax); // null where swap is not accounted
});

it("runs systemd-run's service with no core dumps", (ctx) => {
  requireInCI(ctx, confiningManager);
  const { p } = liveLayout();
  const script =
    'console.log(/^Max core file size +(\\S+) +(\\S+)/m.exec(require("node:fs").readFileSync("/proc/self/limits", "utf8")).slice(1).join(" "))';
  const r = runArgv(systemdRunArgv(p, [process.execPath, "-e", script]));
  expect(r.status).toBe(0);
  expect(r.out.trim()).toBe("0 0");
});

// A unix socket is reached through a read-only file system too, as one under /run is, and the
// service's own control group would let it lift its memory cap. The socket listens in the
// engines directory, which the service sees read-only, and this process counts what reached it.
it("keeps a systemd-run service from every unix socket on this machine, and from its own memory cap", async (ctx) => {
  requireInCI(ctx, confiningManager);
  const { p } = liveLayout();
  const socket = join(p.enginesDir, "socket");
  let reached = 0;
  const server = createServer((c) => {
    reached += 1;
    c.destroy();
  });
  await new Promise<void>((done) => server.listen(socket, done));
  try {
    // the control: the socket listens, and this process reaches it
    await new Promise<void>((done, fail) =>
      createConnection(socket, () => done()).once("error", fail),
    );
    while (reached === 0) await new Promise((r) => setTimeout(r, 10));
    const script = `
const fs = require("node:fs");
const cgroup = fs.readFileSync("/proc/self/cgroup", "utf8").trim().split("::")[1];
let cap;
try { fs.writeFileSync("/sys/fs/cgroup" + cgroup + "/memory.max", "max"); cap = "lifted"; } catch (e) { cap = e.code; }
const s = require("node:net").connect(${JSON.stringify(socket)});
s.on("connect", () => { console.log(JSON.stringify({ cap, socket: "reached" })); process.exit(0); });
s.on("error", (e) => console.log(JSON.stringify({ cap, socket: e.code })));`;
    const argv = systemdRunArgv(p, [process.execPath, "-e", script]);
    const out = await new Promise<string>((done) => {
      const child = spawn(argv[0] ?? "", argv.slice(1), {
        stdio: ["ignore", "pipe", "inherit"],
      });
      let text = "";
      child.stdout.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
      });
      child.once("close", () => done(text));
    });
    expect(JSON.parse(out)).toEqual({ cap: "EROFS", socket: "EAFNOSUPPORT" });
    expect(reached).toBe(1);
  } finally {
    await new Promise((done) => server.close(done));
  }
}, 60_000);

// A process that starts a child which fills 400 MiB, then says how the child ended.
const FILLS_PAST_THE_CAP = `
const { spawnSync } = require("node:child_process");
const r = spawnSync(process.execPath, ["-e", "const a = []; for (let i = 0; i < 25; i++) a.push(Buffer.alloc(16 * 1024 * 1024, 1));"], { stdio: "inherit" });
console.log(JSON.stringify({ status: r.status, signal: r.signal }));`;

it("keeps a capped sandbox running when the kernel kills one of its processes at the cap, which it stops without OOMPolicy", async (ctx) => {
  requireInCI(ctx, bwrap, userManager, oomScope);
  const { p } = liveLayout();
  const capped = { ...p, memoryMax: "200M" };
  const { argv } = await sandboxCommand("bubblewrap", capped, [
    process.execPath,
    "-e",
    FILLS_PAST_THE_CAP,
  ]);
  const at = argv.indexOf("OOMPolicy=continue");
  expect(argv[at - 1]).toBe("-p");
  const kept = runArgv(argv);
  expect(kept.status).toBe(0);
  expect(JSON.parse(kept.out)).toEqual({ status: null, signal: "SIGKILL" });
  // the control: the same scope without it stops the whole sandbox, which never reports
  const stopped = runArgv([...argv.slice(0, at - 1), ...argv.slice(at + 1)]);
  expect(stopped.status).not.toBe(0);
  expect(stopped.out).toBe("");
});
