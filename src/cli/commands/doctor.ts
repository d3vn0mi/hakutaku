// hakutaku doctor
// Checks what hakutaku needs on this machine, one line per check: ok, warn or fail, two spaces,
// then the check's name and what it found, with what backs it indented on the lines below:
//   node      22.16 or later;
//   sqlite    FTS5's trigram tokenizer, in a database in memory;
//   python    a python3 on PATH within the range the engine lock gives grimp, else warn: Python
//             imports then come from hakutaku's resolver;
//   engines   the pinned engines in the default engines directory, verified, else warn;
//   sandbox   the sandbox an extract would run in: ok only for bubblewrap with its memory cap,
//             else warn, naming each problem's repair (no sandbox in the words --sandbox require
//             refuses with), with each probe's evidence below;
//   platform  Linux or macOS.
// Every line names the home directory as ~ and has its secrets redacted, so that it can be
// pasted into a report, and is safe for a terminal. Exit codes: 0 when no check fails, 1 when
// one does, 2 a usage error.
import { spawnSync } from "node:child_process";
import { arch, release } from "node:os";
import { parseArgs } from "node:util";
import {
  defaultEnginesDir,
  findOnPath,
  pythonSatisfies,
  readInstalled,
  readLock,
  verifyEngines,
} from "../../engines/index.js";
import {
  detectSandbox,
  evidenceLine,
  NO_PROCESS_ISOLATION,
  noSandboxText,
  type Sandbox,
  type SandboxProblem,
  sandboxProblems,
} from "../../extract/sandbox.js";
import { cleanReason } from "../../redact/index.js";
import { printable } from "../table.js";
import type { CliIO, Command } from "./index.js";

const USAGE = "usage: hakutaku doctor\n";

export interface Check {
  status: "ok" | "warn" | "fail";
  name: string;
  detail: string;
  below: string[]; // printed under the check, indented
}

const check = (
  status: Check["status"],
  name: string,
  detail: string,
  below: string[] = [],
): Check => ({ status, name, detail, below });

// The oldest Node with node:sqlite's FTS5, as [major, minor].
const NODE_FLOOR = [22, 16] as const;

export function nodeCheck(version: string): Check {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const [floorMajor, floorMinor] = NODE_FLOOR;
  return major > floorMajor || (major === floorMajor && minor >= floorMinor)
    ? check("ok", "node", version)
    : check(
        "fail",
        "node",
        `${version}, older than ${floorMajor}.${floorMinor}`,
      );
}

// node:sqlite is imported here, so that a Node without it fails this check rather than doctor.
async function sqliteCheck(): Promise<Check> {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE VIRTUAL TABLE t USING fts5(body, tokenize = 'trigram')");
      db.prepare("INSERT INTO t (body) VALUES (?)").run("observatory");
      const found = db
        .prepare("SELECT COUNT(*) AS n FROM t WHERE t MATCH ?")
        .get("serv") as { n: number | bigint };
      const { version } = db
        .prepare("SELECT sqlite_version() AS version")
        .get() as { version: string };
      return Number(found.n) === 1
        ? check(
            "ok",
            "sqlite",
            `FTS5 trigram works in memory (SQLite ${version})`,
          )
        : check("fail", "sqlite", "FTS5 trigram finds nothing in memory");
    } finally {
      db.close();
    }
  } catch (error) {
    return check(
      "fail",
      "sqlite",
      `FTS5 trigram does not work: ${(error as Error).message}`,
    );
  }
}

// Prints the interpreter's version; -I keeps the environment and the current directory out.
const PYTHON_VERSION =
  'import sys; print("%d.%d.%d" % tuple(sys.version_info[:3]))';

function pythonCheck(env: NodeJS.ProcessEnv): Check {
  const range = readLock().lock.pip.python;
  const fallback = "Python imports will come from hakutaku's resolver";
  const python3 = findOnPath("python3", env.PATH);
  if (python3 === null) {
    return check("warn", "python", `no python3 on PATH; ${fallback}`);
  }
  const ran = spawnSync(python3, ["-I", "-c", PYTHON_VERSION], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  const version = ran.status === 0 ? ran.stdout.trim() : "";
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    return check(
      "warn",
      "python",
      `python3 at ${python3} did not report its version; ${fallback}`,
    );
  }
  return pythonSatisfies(version, range)
    ? check("ok", "python", `Python ${version} at ${python3}, within ${range}`)
    : check(
        "warn",
        "python",
        `Python ${version} at ${python3}, outside ${range}; ${fallback}`,
      );
}

function enginesCheck(): Check {
  const dir = defaultEnginesDir();
  const verified = verifyEngines(dir);
  if (!verified.ok) {
    return check(
      "warn",
      "engines",
      `${verified.problems.join("; ")}; run hakutaku engines install`,
    );
  }
  const grimp = readInstalled(dir)?.python === null ? ", without grimp" : "";
  return check("ok", "engines", `installed in ${dir}${grimp}`);
}

// The sandbox found and the problems the probes found, as one check: bubblewrap with no problem
// passes; bubblewrap without its memory cap, systemd-run, whose service shares this machine's
// processes, and no sandbox each warn, naming every problem's repair, with its evidence below.
export function sandboxCheck(
  platform: NodeJS.Platform,
  found: Sandbox | null,
  problems: readonly SandboxProblem[],
): Check {
  const lines = problems.map((p) => p.line);
  const below = problems.map((p) => evidenceLine(p.evidence));
  if (found === null) {
    return check("warn", "sandbox", noSandboxText(platform, problems), below);
  }
  if (found === "systemd-run") {
    return check(
      "warn",
      "sandbox",
      `systemd-run: ${[...lines, NO_PROCESS_ISOLATION].join("; ")}`,
      below,
    );
  }
  return problems.length === 0
    ? check("ok", "sandbox", "bubblewrap", below)
    : check(
        "warn",
        "sandbox",
        `bubblewrap, with no memory cap: ${lines.join("; ")}`,
        below,
      );
}

function platformCheck(platform: NodeJS.Platform): Check {
  return platform === "linux" || platform === "darwin"
    ? check("ok", "platform", `${platform} ${release()} ${arch()}`)
    : check(
        "fail",
        "platform",
        `${platform}: hakutaku runs on Linux and macOS`,
      );
}

// Each check as its line, then what is below it, indented; the home directory named ~, secrets
// redacted, and then each line made safe for a terminal, since a check can quote a path from PATH
// or the environment, an engine's output or an error.
export function checkLines(checks: readonly Check[]): string[] {
  return checks.flatMap((c) => [
    printable(cleanReason(`${c.status}  ${c.name}: ${c.detail}`)),
    ...c.below.map((line) => `  ${printable(cleanReason(line))}`),
  ]);
}

async function run(argv: string[], io: CliIO): Promise<number> {
  try {
    parseArgs({
      args: argv,
      options: {},
      allowPositionals: false,
      strict: true,
    });
  } catch (error) {
    io.stderr(
      `hakutaku doctor: ${printable((error as Error).message)}\n${USAGE}`,
    );
    return 2;
  }
  const checks = [
    nodeCheck(process.versions.node),
    await sqliteCheck(),
    pythonCheck(io.env),
    enginesCheck(),
    sandboxCheck(
      process.platform,
      await detectSandbox(),
      await sandboxProblems(),
    ),
    platformCheck(process.platform),
  ];
  io.stdout(
    checkLines(checks)
      .map((line) => `${line}\n`)
      .join(""),
  );
  return checks.some((c) => c.status === "fail") ? 1 : 0;
}

export const doctorCommand: Command = {
  name: "doctor",
  summary: "check Node, SQLite, Python, the engines and the sandbox",
  run,
};
