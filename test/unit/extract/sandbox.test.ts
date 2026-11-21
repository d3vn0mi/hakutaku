import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  bwrapArgv,
  detectSandbox,
  type SandboxPaths,
  sandboxCommand,
  systemdRunArgv,
} from "../../../src/extract/sandbox.js";

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
  storeDir: "/srv/observatory/store",
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
// The probe that takes systemd-run as the sandbox: a check inside the service that it sees no
// network interface but loopback. No element holds a space, so the log line splits back.
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

it("binds the export and engines read-only and only the store writable", () => {
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
  expect(pairsAfter(a, "--bind")).toEqual([[paths.storeDir, paths.storeDir]]);
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
    ...bind("--bind", "/srv/observatory/store"),
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
    ["--bind", "/srv/observatory/store"],
  ]));

it("binds a directory before the directories inside it, so the writable store cannot cover a read-only one", () =>
  expect(
    userMounts(
      bwrapArgv(
        {
          ...paths,
          storeDir: "/srv/observatory",
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
          storeDir: "/srv/observatory/x/../store",
        },
        inner,
      ),
      "--bind",
    ),
  ).toEqual([["/srv/observatory/store", "/srv/observatory/store"]]));

it.each([
  "exportDir",
  "enginesDir",
  "storeDir",
  "packageRoot",
  "nodePrefix",
  "pythonPrefix",
])("refuses a %s that is not an absolute path", (field) =>
  expect(() => bwrapArgv({ ...paths, [field]: "observatory" }, inner)).toThrow(
    `sandbox: ${field} is not an absolute path: "observatory"`,
  ),
);

it("writes the whole systemd-run command, with no swap beyond the memory cap and no core dumps", () => {
  const head = [
    "systemd-run",
    "--user",
    "--wait",
    "--pipe",
    "--quiet",
    "--collect",
    "-p",
    "PrivateNetwork=yes",
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

// Stand-ins for bwrap and systemd-run on a PATH holding nothing else. Each appends its name and
// arguments to the log, writes what it is given to say on stderr, then exits with its code; a
// tool given no code is not on the PATH. systemd-run fails a probe of OOMPolicy when told to.
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
        `echo "${name} $*" >> "${log}"`,
        ...(opts.noOomPolicy === true
          ? [
              'case "$*" in *OOMPolicy=*) echo "Unknown assignment: OOMPolicy=continue" >&2; exit 1;; esac',
            ]
          : []),
        ...(said === undefined
          ? []
          : [`printf '%s\\n' ${JSON.stringify(said)} >&2`]),
        `exit ${code}`,
        "",
      ].join("\n"),
    );
    chmodSync(file, 0o755);
  }
  vi.stubEnv("PATH", bin);
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
  expect(logged(log)).toEqual([
    BWRAP_PROBE,
    SYSTEMD_RUN_ISOLATION_PROBE.join(" "),
  ]);
});

// A systemd-run stand-in whose service shares the host's network, as a user manager that cannot
// make a network namespace runs it: it runs what follows "--" right here, and exits 0 otherwise.
function hostNetworkSystemdRun(): void {
  const bin = tmp();
  const file = join(bin, "systemd-run");
  writeFileSync(
    file,
    '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\n[ "$#" -gt 0 ] || exit 0\nshift\nexec "$@"\n',
  );
  chmodSync(file, 0o755);
  vi.stubEnv("PATH", bin);
}
const hostHasNetwork = Object.keys(networkInterfaces()).some(
  (name) => name !== "lo",
);

it.runIf(hostHasNetwork)(
  "does not take systemd-run as the sandbox when its service sees the host's network",
  async () => {
    hostNetworkSystemdRun();
    const s = await freshSandbox();
    expect(await s.detectSandbox("linux")).toBeNull();
  },
);

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
  vi.stubEnv("HOME", "/srv/astronomer");
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

it.runIf(hostHasNetwork)(
  "says systemd-run cannot cut the network when its service runs in the host's network",
  async () => {
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
      ["systemd-run cannot cut the network", "systemd-run: exit code 1"],
    ]);
  },
);

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
    SYSTEMD_RUN_ISOLATION_PROBE.join(" "),
    OOM_SERVICE_PROBE,
  ]);
  fakeTools({ bwrap: 1, "systemd-run": 0 }, { noOomPolicy: true });
  const old = await freshSandbox();
  expect(await old.sandboxCommand("systemd-run", paths, inner)).toEqual({
    argv: old.systemdRunArgv(paths, inner),
    warnings: [],
  });
});

// The live runs below need the real tools, so they run only where each works.
const works = (argv: string[]): boolean =>
  process.platform === "linux" &&
  spawnSync(argv[0] ?? "", argv.slice(1), { stdio: "ignore", timeout: 30_000 })
    .status === 0;
const bwrapWorks = works(BWRAP_PROBE.split(" "));
const systemdRunWorks = works(SYSTEMD_RUN_PROBE.split(" "));
const systemdRunIsolates = works(SYSTEMD_RUN_ISOLATION_PROBE);
const oomScopeWorks = works(OOM_SCOPE_PROBE.split(" "));

// The isolation probe's check, on its own: it passes in a fresh network namespace and fails in the
// host's, so a probe that passes proves the service had no network.
it.runIf(bwrapWorks && hostHasNetwork)(
  "checks for loopback only: true in a new network namespace, false in the host's",
  () => {
    const check = [process.execPath, "-e", ONLY_LOOPBACK];
    const inNamespace = spawnSync(
      "bwrap",
      ["--unshare-all", "--die-with-parent", "--ro-bind", "/", "/", ...check],
      { stdio: "ignore", timeout: 30_000 },
    );
    expect(inNamespace.status).toBe(0);
    const [node = "", ...args] = check;
    const onHost = spawnSync(node, args, { stdio: "ignore", timeout: 30_000 });
    expect(onHost.status).toBe(1);
  },
);

// A sandbox's directories under the OS temp directory, a file in the export, and a directory
// outside every bind.
function liveLayout(): { p: SandboxPaths; outside: string } {
  const root = tmp();
  const p: SandboxPaths = {
    exportDir: join(root, "export"),
    enginesDir: join(root, "engines"),
    storeDir: join(root, "store"),
    packageRoot: join(root, "package"),
    nodePrefix: dirname(dirname(process.execPath)),
    pythonPrefix: null,
    memoryMax: "3G",
  };
  const outside = join(root, "outside");
  for (const d of [
    p.exportDir,
    p.enginesDir,
    p.storeDir,
    p.packageRoot,
    outside,
  ])
    mkdirSync(d);
  writeFileSync(join(p.exportDir, "export.json"), "{}\n");
  return { p, outside };
}

// A script that reports what it can see and write.
const report = (p: SandboxPaths, outside: string): string => `
const fs = require("node:fs");
const os = require("node:os");
const write = (dir) => { try { fs.writeFileSync(dir + "/probe", "x"); return "written"; } catch (e) { return e.code; } };
console.log(JSON.stringify({
  env: Object.keys(process.env).sort(),
  home: process.env.HOME,
  read: fs.readFileSync(${JSON.stringify(join(p.exportDir, "export.json"))}, "utf8"),
  export: write(${JSON.stringify(p.exportDir)}),
  engines: write(${JSON.stringify(p.enginesDir)}),
  package: write(${JSON.stringify(p.packageRoot)}),
  store: write(${JSON.stringify(p.storeDir)}),
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
  store: "written",
  outside: false,
  network: ["lo"],
  core: "0 0", // soft and hard: no core dumps, nor a way to turn them back on
};

const runArgv = (argv: string[]) => {
  const r = spawnSync(argv[0] ?? "", argv.slice(1), {
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
};

it.runIf(bwrapWorks)(
  "runs a command in bubblewrap that reads the export, writes only the store and has no network",
  () => {
    const { p, outside } = liveLayout();
    const r = runArgv(
      bwrapArgv(p, [process.execPath, "-e", report(p, outside)]),
    );
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.out)).toEqual(SEEN_IN_BUBBLEWRAP);
  },
);

it.runIf(bwrapWorks && systemdRunWorks)(
  "runs bubblewrap inside a systemd-run scope",
  async () => {
    const { p, outside } = liveLayout();
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
  },
);

it.runIf(systemdRunIsolates)(
  "runs a command under systemd-run with no network, nice 19 and the memory cap",
  () => {
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
  },
);

it.runIf(systemdRunWorks)(
  "runs systemd-run's service with no core dumps",
  () => {
    const { p } = liveLayout();
    const script =
      'console.log(/^Max core file size +(\\S+) +(\\S+)/m.exec(require("node:fs").readFileSync("/proc/self/limits", "utf8")).slice(1).join(" "))';
    const r = runArgv(systemdRunArgv(p, [process.execPath, "-e", script]));
    expect(r.status).toBe(0);
    expect(r.out.trim()).toBe("0 0");
  },
);

// A process that starts a child which fills 400 MiB, then says how the child ended.
const FILLS_PAST_THE_CAP = `
const { spawnSync } = require("node:child_process");
const r = spawnSync(process.execPath, ["-e", "const a = []; for (let i = 0; i < 25; i++) a.push(Buffer.alloc(16 * 1024 * 1024, 1));"], { stdio: "inherit" });
console.log(JSON.stringify({ status: r.status, signal: r.signal }));`;

it.runIf(bwrapWorks && systemdRunWorks && oomScopeWorks)(
  "keeps a capped sandbox running when the kernel kills one of its processes at the cap, which it stops without OOMPolicy",
  async () => {
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
  },
);
