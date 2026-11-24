// checkTrace, on strace -f lines written by hand: which processes run inside a bubblewrap sandbox,
// which sandbox started an extract, and what inside one is a finding. Then how the runner is
// called, and where ci:local and CI run it.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import YAML from "yaml";
import { checkTrace } from "../../../scripts/hostile-sandbox.mjs";

const F = "/t/fixtures";
const SANDBOXED = [
  '100 execve("/usr/bin/bwrap", ["bwrap", "--unshare-all", "--clearenv", "--die-with-parent"], 0x7ffd /* 3 vars */) = 0',
  "100 clone(child_stack=NULL, flags=CLONE_NEWNS|SIGCHLD) = 101",
  '101 execve("/opt/node/bin/node", ["node", "/r/dist/cli/main.js", "extract"], 0x5 /* 4 vars */) = 0',
  "101 clone3({flags=CLONE_VM|CLONE_VFORK, exit_signal=SIGCHLD} <unfinished ...>",
  "101 <... clone3 resumed> => {parent_tid=[0]}, 88) = 102",
  '102 execve("/e/npm/node_modules/.bin/depcruise", ["depcruise", "--config", "/x/depcruise.json"], 0x6 /* 4 vars */) = 0',
  "101 socket(AF_UNIX, SOCK_STREAM|SOCK_CLOEXEC, 0) = 4",
];

it("a clean sandboxed run passes", () => {
  expect(checkTrace(SANDBOXED, { fixturesDir: F })).toEqual({
    findings: [],
    sandboxRuns: 1,
  });
});

it("an exec of a snapshot or fixture path inside the sandbox is a finding, whatever its result", () => {
  expect(
    checkTrace(
      [
        ...SANDBOXED,
        '102 execve("/w/export/snapshot/tools/run.sh", ["run.sh"], 0x6 /* 4 vars */) = -1 EACCES (Permission denied)',
        '102 execve("/t/fixtures/python-shadow/json.py", ["json.py"], 0x6 /* 4 vars */) = 0',
      ],
      { fixturesDir: F },
    ).findings,
  ).toEqual([
    "exec of a snapshot or fixture path: /w/export/snapshot/tools/run.sh (pid 102)",
    "exec of a snapshot or fixture path: /t/fixtures/python-shadow/json.py (pid 102)",
  ]);
});

it("an AF_INET or AF_INET6 socket or connect inside the sandbox is a finding", () => {
  expect(
    checkTrace(
      [
        ...SANDBOXED,
        "102 socket(AF_INET6, SOCK_STREAM|SOCK_CLOEXEC, IPPROTO_IP) = 9",
        '101 connect(7, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("192.0.2.1")}, 16) = -1 ENETUNREACH (Network is unreachable)',
      ],
      { fixturesDir: F },
    ).findings,
  ).toEqual([
    "network socket: AF_INET6 (pid 102)",
    "network connect: AF_INET (pid 101)",
  ]);
});

it("processes outside the sandbox are not judged", () => {
  expect(
    checkTrace(
      [
        '50 execve("/t/fixtures/smudge-filter/canary.sh", ["canary.sh"], 0x1 /* 2 vars */) = 0',
        '50 connect(3, {sa_family=AF_INET, sin_port=htons(80), sin_addr=inet_addr("192.0.2.2")}, 16) = 0',
      ],
      { fixturesDir: F },
    ),
  ).toEqual({ findings: [], sandboxRuns: 0 });
});

it("a bwrap call without --unshare-all is not a sandboxed run", () => {
  expect(
    checkTrace(
      [
        '60 execve("/usr/bin/bwrap", ["bwrap", "--version"], 0x1 /* 2 vars */) = 0',
      ],
      { fixturesDir: F },
    ),
  ).toEqual({ findings: [], sandboxRuns: 0 });
});

// bubblewrap's own PID namespace, as strace prints it with --pidns-translation: a clone made inside
// it returns the child's number there, and strace adds the number the child's own lines carry. A
// child's lines may come before its parent's clone returns.
const NAMESPACED = [
  '200 execve("/usr/bin/bwrap", ["/usr/bin/bwrap", "--unshare-all", "--die-with-parent", "--clearenv", "/bin/sh", "-c", "ulimit -c 0 && exec \\"$@\\"", "sh", "/opt/node/bin/node", "/r/dist/cli/main.js", "extract"], 0x7ffd /* 3 vars */) = 0',
  "200 clone(child_stack=NULL, flags=CLONE_NEWNS|CLONE_NEWUSER|CLONE_NEWPID|CLONE_NEWNET|SIGCHLD) = 201",
  "201 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD, child_tidptr=0x7f) = 2 /* 202 in strace's PID NS */",
  '202 execve("/bin/sh", ["/bin/sh", "-c", "ulimit -c 0 && exec \\"$@\\"", "sh", "/opt/node/bin/node", "/r/dist/cli/main.js", "extract"], 0x7ffe /* 2 vars */) = 0',
  '202 execve("/opt/node/bin/node", ["/opt/node/bin/node", "/r/dist/cli/main.js", "extract"], 0x5 /* 2 vars */) = 0',
  "202 clone3({flags=CLONE_VM|CLONE_THREAD, exit_signal=0} => {parent_tid=[3 /* 203 in strace's PID NS */]}, 88) = 3 /* 203 in strace's PID NS */",
  "202 vfork( <unfinished ...>",
  '204 execve("/w/export/snapshot/bin/python", ["python"], 0x6 /* 2 vars */ <unfinished ...>',
  "202 <... vfork resumed>)            = 4 /* 204 in strace's PID NS */",
  "204 <... execve resumed>)           = 0",
  "203 connect(5, {sa_family=AF_INET6, sin6_port=htons(53)}, 28) = -1 ENETUNREACH (Network is unreachable)",
];

it("follows bubblewrap's PID namespace by the numbers strace translates its children to, a thread's included", () => {
  expect(checkTrace(NAMESPACED, { fixturesDir: F })).toEqual({
    findings: [
      "exec of a snapshot or fixture path: /w/export/snapshot/bin/python (pid 204)",
      "network connect: AF_INET6 (pid 203)",
    ],
    sandboxRuns: 1,
  });
});

it("without strace's translation, the processes a namespace numbers are not judged, and its extract counts no run", () => {
  const untranslated = NAMESPACED.map((line) =>
    line.replace(/ \/\* \d+ in strace's PID NS \*\//g, ""),
  );
  expect(checkTrace(untranslated, { fixturesDir: F })).toEqual({
    findings: [],
    sandboxRuns: 0,
  });
});

it("a sandbox root is a process that execs a bwrap with --unshare-all: systemd-run naming bwrap is none, and failed execs before it count once", () => {
  const scope =
    '300 execve("/usr/bin/systemd-run", ["systemd-run", "--user", "--scope", "--", "bwrap", "--unshare-all", "/bin/true"], 0x1 /* 2 vars */) = 0';
  const extract = [
    "300 clone(child_stack=NULL, flags=CLONE_NEWNS|CLONE_NEWPID|SIGCHLD) = 301",
    "301 clone(child_stack=NULL, flags=SIGCHLD) = 2 /* 302 in strace's PID NS */",
    '302 execve("/opt/node/bin/node", ["/opt/node/bin/node", "/r/dist/cli/main.js", "extract"], 0x5 /* 2 vars */) = 0',
    "302 socket(AF_INET, SOCK_DGRAM|SOCK_CLOEXEC, IPPROTO_IP) = 6",
  ];
  expect(checkTrace([scope, ...extract], { fixturesDir: F })).toEqual({
    findings: [],
    sandboxRuns: 0,
  });
  expect(
    checkTrace(
      [
        scope,
        '300 execve("/x/bin/bwrap", ["/x/bin/bwrap", "--setenv", "PS1", "\\"$ ", "--unshare-all", "/bin/true"], 0x1 /* 2 vars */) = -1 ENOENT (No such file or directory)',
        '300 execve("/usr/bin/bwrap", ["/usr/bin/bwrap", "--setenv", "PS1", "\\"$ ", "--unshare-all", "/bin/true"], 0x1 /* 2 vars */) = 0',
        ...extract,
      ],
      { fixturesDir: F },
    ),
  ).toEqual({
    findings: ["network socket: AF_INET (pid 302)"],
    sandboxRuns: 1,
  });
});

it("a sandbox under which no extract starts is judged, but is no sandboxed run: bubblewrap's probe, or an extract whose exec failed", () => {
  const probe = [
    '400 execve("/usr/bin/bwrap", ["bwrap", "--unshare-all", "--die-with-parent", "--ro-bind", "/", "/", "true"], 0x1 /* 2 vars */) = 0',
    "400 clone(child_stack=NULL, flags=CLONE_NEWNS|CLONE_NEWPID|SIGCHLD) = 401",
    "401 clone(child_stack=NULL, flags=SIGCHLD) = 2 /* 402 in strace's PID NS */",
    '402 execve("/usr/bin/true", ["true"], 0x1 /* 2 vars */) = 0',
    "402 socket(AF_INET, SOCK_DGRAM|SOCK_CLOEXEC, IPPROTO_IP) = 3",
  ];
  expect(checkTrace(probe, { fixturesDir: F })).toEqual({
    findings: ["network socket: AF_INET (pid 402)"],
    sandboxRuns: 0,
  });
  expect(
    checkTrace(
      [
        ...SANDBOXED.slice(0, 2),
        '101 execve("/opt/node/bin/node", ["node", "/r/dist/cli/main.js", "extract"], 0x5 /* 4 vars */) = -1 ENOENT (No such file or directory)',
      ],
      { fixturesDir: F },
    ),
  ).toEqual({ findings: [], sandboxRuns: 0 });
  // an extract's exec whose result comes on the line that resumes it
  const resumed = (result: string) => [
    ...SANDBOXED.slice(0, 2),
    '101 execve("/opt/node/bin/node", ["node", "/r/dist/cli/main.js", "extract"], 0x5 /* 4 vars */ <unfinished ...>',
    "100 socket(AF_UNIX, SOCK_STREAM|SOCK_CLOEXEC, 0) = 3",
    `101 <... execve resumed>) = ${result}`,
  ];
  expect(checkTrace(resumed("0"), { fixturesDir: F }).sandboxRuns).toBe(1);
  expect(
    checkTrace(resumed("-1 ENOENT (No such file or directory)"), {
      fixturesDir: F,
    }).sandboxRuns,
  ).toBe(0);
});

it("reads execveat's file from its second argument, decodes strace's escapes to match a file, and names the file as strace wrote it", () => {
  // a fixtures directory whose name holds a byte that strace writes as an escape
  const fixtures = `/t/caf${String.fromCodePoint(0xe9)}/fixtures`;
  expect(
    checkTrace(
      [
        ...SANDBOXED,
        '102 execveat(AT_FDCWD, "/t/caf\\303\\251/fixtures/separator-names/a\\342\\200\\250b.sh", ["a.sh"], 0x6 /* 4 vars */, 0) = -1 ENOENT (No such file or directory)',
        '102 execve("/t/caf\\303\\251/fixtures-other/run.sh", ["run.sh"], 0x6 /* 4 vars */) = 0',
        '102 execve("/t/fixtures/run.sh", ["run.sh"], 0x6 /* 4 vars */) = 0',
      ],
      { fixturesDir: fixtures },
    ).findings,
  ).toEqual([
    "exec of a snapshot or fixture path: /t/caf\\303\\251/fixtures/separator-names/a\\342\\200\\250b.sh (pid 102)",
  ]);
});

it("signal, exit and other lines that are no system call make no child, no root and no finding", () => {
  expect(
    checkTrace(
      [
        ...SANDBOXED,
        "101 --- SIGCHLD {si_signo=SIGCHLD, si_code=CLD_EXITED, si_pid=5 /* 500 in strace's PID NS */, si_status=0} ---",
        "102 +++ exited with 0 +++",
        "strace: Process 501 attached",
        '500 execve("/t/fixtures/sgconfig/run.sh", ["run.sh"], 0x6 /* 4 vars */) = 0',
        '101 connect(4, {sa_family=AF_UNIX, sun_path="/run/x.sock"}, 13) = 0',
        "101 socket(AF_NETLINK, SOCK_RAW|SOCK_CLOEXEC, NETLINK_ROUTE) = 5",
      ],
      { fixturesDir: F },
    ),
  ).toEqual({ findings: [], sandboxRuns: 1 });
});

it("hostile-sandbox.mjs takes only --keep-trace, and fails naming a tool it cannot run", () => {
  const run = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
    spawnSync(process.execPath, ["scripts/hostile-sandbox.mjs", ...args], {
      encoding: "utf8",
      env,
    });
  const usage = run(["--keep"]);
  expect(usage.status).toBe(2);
  expect(usage.stdout).toBe("");
  expect(usage.stderr).toBe(
    "usage: node scripts/hostile-sandbox.mjs [--keep-trace]\n",
  );
  // with no strace on PATH, the runner stops before it makes anything
  const empty = mkdtempSync(join(tmpdir(), "hakutaku-trace-path-"));
  try {
    const missing = run([], { PATH: empty });
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe("hostile-sandbox: strace is not installed\n");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

it("ci:local and CI's hostile fixtures step run the suite, then the suite under the sandbox", () => {
  const { scripts } = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  expect(scripts["test:sandbox"]).toBe("node scripts/hostile-sandbox.mjs");
  expect(scripts["ci:local"]).toContain(
    "npm run test:hostile && npm run test:sandbox && npm run test:mcp",
  );
  const ci = YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
    jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
  };
  const step = ci.jobs.linux?.steps.find((s) => s.name === "hostile fixtures");
  const run = (step?.run ?? "").split("\n").map((line) => line.trim());
  expect(run[0]).toBe("npm run test:hostile");
  expect(run.filter((line) => line.startsWith("npm "))).toEqual([
    "npm run test:hostile",
    "npm run test:sandbox",
  ]);
  expect(run.indexOf("npm run test:sandbox")).toBeGreaterThan(
    run.findIndex((line) =>
      line.includes("kernel.apparmor_restrict_unprivileged_userns=0"),
    ),
  );
});
