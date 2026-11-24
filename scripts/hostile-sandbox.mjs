// The hostile suite inside bubblewrap, under strace. Every hostile test that extracts runs its
// extract with --sandbox require, and strace -f records each exec, clone, socket and connect of
// the whole run. checkTrace then judges the processes inside a bubblewrap sandbox, and only those:
// none may exec a file of a snapshot or of the fixtures, or open or reach an internet socket.
// Everything else is outside the sandbox (vitest, export's git, a control that fires its fixture),
// and the suite's own assertions cover it.
//
//   node scripts/hostile-sandbox.mjs [--keep-trace]
//
// The fixtures are made once, under a fresh directory in the system temporary directory, and the
// suite's files use them one after another (HAKUTAKU_HOSTILE_DIR), since they share one canary.
// strace translates the process IDs of bubblewrap's own PID namespace, so that a process inside
// can be told from one outside. Run npm run build first: the extract inside bubblewrap runs
// dist/cli/main.js.
//
// The last line is "hostile-sandbox: clean (<runs> sandboxed runs, <cases> extract cases)" and the
// exit code 0; or one line per finding, then "hostile-sandbox: <n> findings" and the exit code 1;
// or "hostile-sandbox: <reason>" and the exit code 1 where the run itself fails. The directory is
// removed unless --keep-trace is given, which keeps it and names the trace.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const USAGE = "usage: node scripts/hostile-sandbox.mjs [--keep-trace]";

// What strace records. Never -v, which writes whole environments into the trace.
const STRACE = [
  "--seccomp-bpf",
  "-f",
  "-qq",
  "--pidns-translation",
  "-s",
  "4096",
  "-e",
  "trace=execve,execveat,clone,clone3,fork,vfork,socket,connect",
];

const CLONES = new Set(["clone", "clone3", "fork", "vfork"]);
const EXECS = new Set(["execve", "execveat"]);

// A system call's return, as strace ends a line with it: a number, then, where the caller sits in
// another PID namespace than strace, the number strace's own namespace gives the same process.
const RETURNED = /^(-?\d+)(?:\s+\/\*\s*(\d+) in strace's PID NS\s*\*\/)?$/;

// The index, in text, of the parenthesis that closes a call whose arguments are depth brackets
// deep at text's start, or -1 where the text ends first. Quoted strings are skipped whole.
function closeOf(text, depth) {
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === "(" || c === "[" || c === "{") {
      depth++;
    } else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return c === ")" ? i : -1;
    }
  }
  return -1;
}

// What follows a call's closing parenthesis, " = <value>", as the value's text.
function resultOf(text) {
  return /^\s*=\s*(.*?)\s*$/.exec(text)?.[1] ?? null;
}

// One line of strace -f, as its pid and a system call: whole, unfinished (its arguments, no
// result yet) or resumed (its result). Any other line, such as a signal's, is null.
function parseLine(line) {
  const at = /^(\d+)\s+(.*)$/.exec(line);
  if (at === null) return null;
  const pid = Number(at[1]);
  const resumed = /^<\.\.\. (\w+) resumed>(.*)$/.exec(at[2]);
  if (resumed !== null) {
    const end = closeOf(resumed[2], 1);
    return {
      pid,
      name: resumed[1],
      kind: "resumed",
      args: null,
      result: end === -1 ? null : resultOf(resumed[2].slice(end + 1)),
    };
  }
  const call = /^(\w+)\((.*)$/.exec(at[2]);
  if (call === null) return null;
  const end = closeOf(call[2], 1);
  if (end === -1) {
    const unfinished = /^(.*?)\s*<unfinished \.\.\.>$/.exec(call[2]);
    if (unfinished === null) return null;
    return {
      pid,
      name: call[1],
      kind: "unfinished",
      args: unfinished[1],
      result: null,
    };
  }
  return {
    pid,
    name: call[1],
    kind: "whole",
    args: call[2].slice(0, end),
    result: resultOf(call[2].slice(end + 1)),
  };
}

// The calls of a trace, in the order of their first line: an unfinished call and the line that
// resumes it make one call, with the arguments of the one and the result of the other.
function callsOf(lines) {
  const calls = [];
  const open = new Map();
  for (const line of lines) {
    const p = parseLine(line);
    if (p === null) continue;
    if (p.kind === "resumed") {
      const call = open.get(p.pid);
      open.delete(p.pid);
      if (call?.name === p.name) {
        call.result = p.result;
      } else {
        calls.push({ pid: p.pid, name: p.name, args: null, result: p.result });
      }
      continue;
    }
    const call = { pid: p.pid, name: p.name, args: p.args, result: p.result };
    calls.push(call);
    if (p.kind === "unfinished") open.set(p.pid, call);
  }
  return calls;
}

// The pid a clone, fork or vfork returned, in strace's own PID namespace, or null when it failed.
function childOf(result) {
  const m = RETURNED.exec(result ?? "");
  if (m === null) return null;
  const pid = Number(m[2] ?? m[1]);
  return pid > 0 ? pid : null;
}

const BYTE_ESCAPES = new Map([
  ["a", 0x07],
  ["b", 0x08],
  ["t", 0x09],
  ["n", 0x0a],
  ["v", 0x0b],
  ["f", 0x0c],
  ["r", 0x0d],
  ["e", 0x1b],
]);

// A string as strace quotes it, read back into its bytes, as UTF-8 text: strace writes a quote, a
// backslash and each byte it cannot print as an escape.
function unquote(quoted) {
  const bytes = [];
  for (let i = 0; i < quoted.length; ) {
    if (quoted[i] !== "\\") {
      const c = String.fromCodePoint(quoted.codePointAt(i) ?? 0);
      bytes.push(...Buffer.from(c, "utf8"));
      i += c.length;
      continue;
    }
    const rest = quoted.slice(i + 1, i + 4);
    const octal = /^[0-7]{1,3}/.exec(rest)?.[0];
    const hex = /^x([0-9A-Fa-f]{2})/.exec(rest)?.[1];
    if (octal !== undefined) {
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      i += 1 + octal.length;
    } else if (hex !== undefined) {
      bytes.push(Number.parseInt(hex, 16));
      i += 4;
    } else {
      const c = quoted[i + 1] ?? "";
      bytes.push(BYTE_ESCAPES.get(c) ?? c.charCodeAt(0));
      i += 2;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

// The quoted strings of a call's arguments, in order: each as strace wrote it, and as its text.
// For execve they are the file, then each argument; for execveat, whose first argument is a
// directory's file descriptor, the same.
function stringsOf(args) {
  return [...args.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => ({
    written: m[1],
    text: unquote(m[1]),
  }));
}

// An exec of bubblewrap with --unshare-all, which starts a sandbox.
function startsSandbox(call) {
  if (call.name !== "execve" || call.args === null) return false;
  const [file, ...argv] = stringsOf(call.args);
  return (
    file?.text.endsWith("/bwrap") === true &&
    argv.slice(1).some((a) => a.text === "--unshare-all")
  );
}

// An exec that started hakutaku's extract: an argument naming the CLI, then "extract".
function startedExtract(call) {
  if (!EXECS.has(call.name) || call.args === null) return false;
  if (!/^0(?:\s|$)/.test(call.result ?? "")) return false;
  const argv = stringsOf(call.args)
    .slice(1)
    .map((a) => a.text);
  return argv.some(
    (a, i) => a.endsWith("/dist/cli/main.js") && argv[i + 1] === "extract",
  );
}

// The family a socket or connect call names, when it is an internet one.
function internetFamily(call) {
  const family =
    call.name === "socket"
      ? /^\s*(AF_INET6?)(?!\w)/.exec(call.args)
      : /^[^,]*,\s*\{sa_family=(AF_INET6?)(?!\w)/.exec(call.args);
  return family?.[1] ?? null;
}

// The trace of strace -f, judged. A sandbox root is a process that execs bwrap with --unshare-all,
// and a clone, fork or vfork makes its returned pid a child of the caller, a thread included.
// Only the processes under a root, the root included, are judged: within them, an exec of a file
// whose path holds /snapshot/ or lies under the fixtures, whatever its result, and an AF_INET or
// AF_INET6 socket or connect, are each a finding, in the order of the trace. sandboxRuns counts
// the roots under which hakutaku's extract started, in a process below the root.
export function checkTrace(lines, { fixturesDir }) {
  const fixtures = `${fixturesDir.replace(/\/+$/, "")}/`;
  const calls = callsOf(lines);
  const parent = new Map();
  const roots = new Set();
  for (const call of calls) {
    if (CLONES.has(call.name)) {
      const child = childOf(call.result);
      if (child !== null) parent.set(child, call.pid);
    }
    if (startsSandbox(call)) roots.add(call.pid);
  }
  // the nearest root at or above a pid, or null
  const rootOfPid = new Map();
  const rootOf = (pid) => {
    const path = [];
    let found = null;
    for (let at = pid; at !== undefined; at = parent.get(at)) {
      if (rootOfPid.has(at)) {
        found = rootOfPid.get(at);
        break;
      }
      if (roots.has(at)) {
        found = at;
        break;
      }
      if (path.includes(at)) break;
      path.push(at);
    }
    for (const at of path) rootOfPid.set(at, found);
    return found;
  };
  const findings = [];
  const ran = new Set();
  for (const call of calls) {
    const root = rootOf(call.pid);
    if (root === null || call.args === null) continue;
    if (EXECS.has(call.name)) {
      const file = stringsOf(call.args)[0];
      if (
        file !== undefined &&
        (file.text.includes("/snapshot/") || file.text.startsWith(fixtures))
      ) {
        findings.push(
          `exec of a snapshot or fixture path: ${file.written} (pid ${call.pid})`,
        );
      }
      if (call.pid !== root && startedExtract(call)) ran.add(root);
    } else if (call.name === "socket" || call.name === "connect") {
      const family = internetFamily(call);
      if (family !== null) {
        findings.push(`network ${call.name}: ${family} (pid ${call.pid})`);
      }
    }
  }
  return { findings, sandboxRuns: ran.size };
}

// How a child ended, for a failure line.
function ended(r) {
  if (r.error !== undefined)
    return `could not start: ${r.error.code ?? r.error.message}`;
  return r.signal !== null ? `stopped by ${r.signal}` : `exit code ${r.status}`;
}

// The extract cases a sandboxed run must cover at least: those of cases.json at the extract stage,
// but for the deep ones, which run only where the deep engines are installed.
function extractCases() {
  const cases = JSON.parse(
    readFileSync(join(REPO, "fixtures", "hostile", "cases.json"), "utf8"),
  );
  return cases.filter((c) => c.stage === "extract" && c.detail !== "deep")
    .length;
}

function main(argv) {
  let keep = false;
  for (const arg of argv) {
    if (arg !== "--keep-trace") {
      console.error(USAGE);
      return 2;
    }
    keep = true;
  }
  const fail = (reason) => {
    console.log(`hostile-sandbox: ${reason}`);
    return 1;
  };
  for (const [tool, args] of [
    ["strace", ["-V"]],
    ["bwrap", ["--version"]],
  ]) {
    const r = spawnSync(tool, args, { stdio: "ignore" });
    if (r.error !== undefined || r.status !== 0) {
      return fail(`${tool} is not installed`);
    }
  }
  const cases = extractCases();
  const tmp = mkdtempSync(join(tmpdir(), "hakutaku-sandbox-"));
  let verdict;
  try {
    verdict = traced(tmp, cases);
  } finally {
    if (keep) {
      console.log(
        `hostile-sandbox: the trace is kept at ${join(tmp, "trace.txt")}`,
      );
    } else {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  console.log(`hostile-sandbox: ${verdict.line}`);
  return verdict.code;
}

// The run under tmp: the fixtures made, the suite run under strace, and the trace judged.
function traced(tmp, cases) {
  const fixturesDir = join(tmp, "fixtures");
  const made = spawnSync(
    process.execPath,
    [join(REPO, "fixtures", "hostile", "make.mjs"), fixturesDir],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  if (made.error !== undefined || made.status !== 0) {
    return { line: `make.mjs failed: ${ended(made)}`, code: 1 };
  }
  const trace = join(tmp, "trace.txt");
  const run = spawnSync(
    "strace",
    [
      ...STRACE,
      "-o",
      trace,
      "--",
      process.execPath,
      "node_modules/vitest/vitest.mjs",
      "run",
      "test/hostile",
      "--testTimeout=600000",
      "--no-file-parallelism",
    ],
    {
      cwd: REPO,
      stdio: "inherit",
      env: {
        ...process.env,
        HAKUTAKU_HOSTILE_SANDBOX: "require",
        HAKUTAKU_HOSTILE_DIR: fixturesDir,
      },
    },
  );
  if (run.error !== undefined || run.status !== 0) {
    return {
      line: `the hostile suite failed under strace: ${ended(run)}`,
      code: 1,
    };
  }
  let lines;
  try {
    lines = readFileSync(trace, "utf8").split("\n");
  } catch (error) {
    return {
      line: `cannot read the trace: ${error.code ?? error.message}`,
      code: 1,
    };
  }
  const { findings, sandboxRuns } = checkTrace(lines, { fixturesDir });
  const problems = [...findings];
  if (sandboxRuns < cases) {
    problems.push(
      `too few sandboxed runs: ${sandboxRuns}, fewer than the ${cases} extract cases`,
    );
  }
  if (problems.length > 0) {
    for (const problem of problems) console.log(problem);
    return { line: `${problems.length} findings`, code: 1 };
  }
  return {
    line: `clean (${sandboxRuns} sandboxed runs, ${cases} extract cases)`,
    code: 0,
  };
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main(process.argv.slice(2));
}
