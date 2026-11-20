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

it("writes the whole systemd-run command, with no swap beyond the memory cap", () =>
  expect(systemdRunArgv({ ...paths, memoryMax: "15G" }, inner)).toEqual([
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
    "-p",
    "Nice=19",
    "--",
    ...inner,
  ]));

// Stand-ins for bwrap and systemd-run on a PATH holding nothing else. Each appends its name and
// arguments to the log, then exits with its code; a tool given no code is not on the PATH.
function fakeTools(
  codes: Partial<Record<"bwrap" | "systemd-run", number>>,
): string {
  const bin = tmp();
  const log = join(bin, "log");
  writeFileSync(log, "");
  for (const [name, code] of Object.entries(codes)) {
    const file = join(bin, name);
    writeFileSync(
      file,
      `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit ${code}\n`,
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

it("runs bubblewrap under a systemd-run scope with the memory cap when systemd-run works", async () => {
  const log = fakeTools({ bwrap: 0, "systemd-run": 0 });
  const s = await freshSandbox();
  expect(await s.detectSandbox("linux")).toBe("bubblewrap");
  const scoped = {
    argv: [
      "systemd-run",
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      "-p",
      "MemoryMax=3G",
      "-p",
      "MemorySwapMax=0",
      "--",
      ...s.bwrapArgv(paths, inner),
    ],
    warnings: [],
  };
  expect(await s.sandboxCommand("bubblewrap", paths, inner)).toEqual(scoped);
  expect(await s.sandboxCommand("bubblewrap", paths, inner)).toEqual(scoped);
  expect(logged(log)).toEqual([BWRAP_PROBE, SYSTEMD_RUN_PROBE]);
});

it("runs bubblewrap without a memory cap, and warns, when systemd-run does not work", async () => {
  fakeTools({ bwrap: 0, "systemd-run": 1 });
  const s = await freshSandbox();
  expect(await s.sandboxCommand("bubblewrap", paths, inner)).toEqual({
    argv: s.bwrapArgv(paths, inner),
    warnings: ["no memory cap: systemd-run is unavailable"],
  });
});

it("runs systemd-run alone when it is the sandbox", async () => {
  const log = fakeTools({ bwrap: 1, "systemd-run": 0 });
  const s = await freshSandbox();
  expect(await s.detectSandbox("linux")).toBe("systemd-run");
  expect(await s.sandboxCommand("systemd-run", paths, inner)).toEqual({
    argv: s.systemdRunArgv(paths, inner),
    warnings: [],
  });
  expect(logged(log)).toEqual([
    BWRAP_PROBE,
    SYSTEMD_RUN_ISOLATION_PROBE.join(" "),
  ]);
});

// The live runs below need the real tools, so they run only where each works.
const works = (argv: string[]): boolean =>
  process.platform === "linux" &&
  spawnSync(argv[0] ?? "", argv.slice(1), { stdio: "ignore", timeout: 30_000 })
    .status === 0;
const bwrapWorks = works(BWRAP_PROBE.split(" "));
const systemdRunWorks = works(SYSTEMD_RUN_PROBE.split(" "));
const systemdRunIsolates = works(SYSTEMD_RUN_ISOLATION_PROBE);

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
