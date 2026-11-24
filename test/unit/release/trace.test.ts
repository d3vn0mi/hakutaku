// checkTrace, on strace -f lines written by hand: which processes run inside a bubblewrap sandbox,
// which sandbox started an extract, and what inside one is a finding. Then how the runner is
// called, and where ci:local and CI run it.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

it("an extract under a bwrap without --unshare-all is neither judged nor a sandboxed run", () => {
  expect(
    checkTrace(
      [
        '70 execve("/usr/bin/bwrap", ["bwrap", "--ro-bind", "/", "/", "--die-with-parent", "/bin/sh"], 0x1 /* 2 vars */) = 0',
        "70 clone(child_stack=NULL, flags=CLONE_NEWNS|SIGCHLD) = 71",
        '71 execve("/opt/node/bin/node", ["node", "/r/dist/cli/main.js", "extract"], 0x5 /* 4 vars */) = 0',
        "71 clone(child_stack=NULL, flags=SIGCHLD) = 72",
        '72 execve("/w/export/snapshot/tools/run.sh", ["run.sh"], 0x6 /* 4 vars */) = 0',
        "72 socket(AF_INET, SOCK_STREAM|SOCK_CLOEXEC, IPPROTO_IP) = 3",
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

// Stand-ins for strace and bwrap, first on PATH. The strace records its arguments and the two
// settings it was given, writes the trace STAND_IN_TRACE holds where -o names, and exits with
// STAND_IN_STATUS; -V exits 0. The bwrap answers --version, unless STAND_IN_BWRAP is broken.
const STAND_IN_STRACE = [
  "#!/bin/sh",
  'if [ "$1" = "-V" ]; then exit 0; fi',
  'for a in "$@"; do printf \'%s\\n\' "$a"; done > "$STAND_IN_RECORD"',
  'printf \'sandbox=%s\\n\' "$HAKUTAKU_HOSTILE_SANDBOX" >> "$STAND_IN_RECORD"',
  'printf \'dir=%s\\n\' "$HAKUTAKU_HOSTILE_DIR" >> "$STAND_IN_RECORD"',
  'if [ -d "$HAKUTAKU_HOSTILE_DIR/canary" ]; then echo canary >> "$STAND_IN_RECORD"; fi',
  'while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then cp "$STAND_IN_TRACE" "$2"; fi; shift; done',
  'exit "$STAND_IN_STATUS"',
  "",
].join("\n");
const STAND_IN_BWRAP = [
  "#!/bin/sh",
  'if [ "$STAND_IN_BWRAP" = "broken" ]; then exit 1; fi',
  "exit 0",
  "",
].join("\n");

// count sandboxes under which hakutaku's extract started, each with pids of its own
function extractRoots(count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const pid = 1000 + 10 * i;
    return [
      `${pid} execve("/usr/bin/bwrap", ["bwrap", "--unshare-all", "--die-with-parent"], 0x1 /* 2 vars */) = 0`,
      `${pid} clone(child_stack=NULL, flags=CLONE_NEWNS|CLONE_NEWPID|SIGCHLD) = ${pid + 1}`,
      `${pid + 1} execve("/opt/node/bin/node", ["node", "/r/dist/cli/main.js", "extract"], 0x5 /* 2 vars */) = 0`,
    ];
  }).flat();
}

it("hostile-sandbox.mjs runs the suite under strace with every extract at require, and needs one sandboxed run per extract case", () => {
  const cases = (
    JSON.parse(readFileSync("fixtures/hostile/cases.json", "utf8")) as Array<{
      stage: string;
      detail?: string;
    }>
  ).filter((c) => c.stage === "extract" && c.detail !== "deep").length;
  expect(cases).toBeGreaterThan(0);
  const root = mkdtempSync(join(tmpdir(), "hakutaku-trace-runner-"));
  try {
    const bin = join(root, "bin");
    const temp = join(root, "temp");
    mkdirSync(bin);
    mkdirSync(temp);
    writeFileSync(join(bin, "strace"), STAND_IN_STRACE, { mode: 0o755 });
    writeFileSync(join(bin, "bwrap"), STAND_IN_BWRAP, { mode: 0o755 });
    const record = join(root, "record.txt");
    const traceFile = join(root, "trace.txt");
    const runner = (
      lines: string[],
      opts: { status?: number; bwrap?: string; args?: string[] } = {},
    ) => {
      writeFileSync(traceFile, `${lines.join("\n")}\n`);
      rmSync(record, { force: true });
      const r = spawnSync(
        process.execPath,
        ["scripts/hostile-sandbox.mjs", ...(opts.args ?? [])],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            TMPDIR: temp,
            STAND_IN_RECORD: record,
            STAND_IN_TRACE: traceFile,
            STAND_IN_STATUS: String(opts.status ?? 0),
            STAND_IN_BWRAP: opts.bwrap ?? "",
          },
        },
      );
      return { status: r.status, last: r.stdout.trimEnd().split("\n") };
    };

    // as many sandboxed runs as extract cases: clean, and the run's directory removed
    const clean = runner(extractRoots(cases));
    expect(clean.last.at(-1)).toBe(
      `hostile-sandbox: clean (${cases} sandboxed runs, ${cases} extract cases)`,
    );
    expect(clean.status).toBe(0);
    expect(readdirSync(temp)).toEqual([]);
    const recorded = readFileSync(record, "utf8").split("\n");
    const trace = recorded[recorded.indexOf("-o") + 1] ?? "";
    expect(recorded).toEqual([
      "--seccomp-bpf",
      "-f",
      "-qq",
      "--pidns-translation",
      "-s",
      "4096",
      "-e",
      "trace=execve,execveat,clone,clone3,fork,vfork,socket,connect",
      "-o",
      trace,
      "--",
      process.execPath,
      "node_modules/vitest/vitest.mjs",
      "run",
      "test/hostile",
      "--testTimeout=600000",
      "--no-file-parallelism",
      "sandbox=require",
      `dir=${join(dirname(trace), "fixtures")}`,
      "canary",
      "",
    ]);
    expect(dirname(dirname(trace))).toBe(temp);

    // one sandboxed run fewer: a finding, though the trace holds no other
    const few = runner(extractRoots(cases - 1));
    expect(few.last.slice(-2)).toEqual([
      `too few sandboxed runs: ${cases - 1}, fewer than the ${cases} extract cases`,
      "hostile-sandbox: 1 findings",
    ]);
    expect(few.status).toBe(1);

    // a finding inside a sandbox fails the run, with enough runs
    const breach = runner([
      ...extractRoots(cases),
      '1001 execve("/w/export/snapshot/tools/run.sh", ["run.sh"], 0x6 /* 4 vars */) = 0',
    ]);
    expect(breach.last.slice(-2)).toEqual([
      "exec of a snapshot or fixture path: /w/export/snapshot/tools/run.sh (pid 1001)",
      "hostile-sandbox: 1 findings",
    ]);
    expect(breach.status).toBe(1);

    // the suite failing under strace fails the run, whatever the trace holds
    const failed = runner(extractRoots(cases), { status: 3 });
    expect(failed.last.at(-1)).toBe(
      "hostile-sandbox: the hostile suite failed under strace: exit code 3",
    );
    expect(failed.status).toBe(1);

    // a bwrap that does not run stops the runner before it makes anything
    const broken = runner(extractRoots(cases), { bwrap: "broken" });
    expect(broken.last).toEqual(["hostile-sandbox: bwrap is not installed"]);
    expect(broken.status).toBe(1);
    expect(readdirSync(temp)).toEqual([]);

    // --keep-trace keeps the directory and names the trace
    const kept = runner(extractRoots(cases), { args: ["--keep-trace"] });
    const keptRecord = readFileSync(record, "utf8").split("\n");
    const keptTrace = keptRecord[keptRecord.indexOf("-o") + 1] ?? "";
    expect(dirname(dirname(keptTrace))).toBe(temp);
    expect(kept.last.slice(-2)).toEqual([
      `hostile-sandbox: the trace is kept at ${keptTrace}`,
      `hostile-sandbox: clean (${cases} sandboxed runs, ${cases} extract cases)`,
    ]);
    expect(readFileSync(keptTrace, "utf8")).toBe(
      readFileSync(traceFile, "utf8"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

// The runner's minimum counts the extract cases alone, so an export or query case that kept its
// own sandbox would still pass it: every sandbox a hostile test names is hostileSandbox()'s.
it("every extract of the hostile suite takes its sandbox from hostileSandbox()", () => {
  const dir = "test/hostile";
  const sites = readdirSync(dir)
    .filter((name) => name.endsWith(".test.ts"))
    .flatMap((name) =>
      readFileSync(join(dir, name), "utf8")
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .flatMap((line) => [
          ...line.matchAll(
            /(?:\bsandbox:|"--sandbox",)\s*(\w+\(\)|"[^"]*"|'[^']*'|[\w.]+)/g,
          ),
        ])
        .map((m) => `${name}: ${m[1] ?? ""}`),
    );
  expect(sites.length).toBeGreaterThanOrEqual(5);
  for (const site of sites) expect(site).toMatch(/: hostileSandbox\(\)$/);
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
