// The install smoke: hakutaku maps the observatory sample at quick detail, then answers one
// question about it, run from the repository's dist/ or, with --from-pack, from the package that
// npm pack makes, installed into an empty project as a user installs it. Run npm run build first.
//
//   node scripts/release/smoke.mjs [--from-pack] [--engines-dir <path>]
//
// Everything happens under a fresh directory in the system temporary directory, outside the
// repository, so that the installed package finds no src/, no fixtures/ and none of the
// repository's node_modules. Each child process gets exactly this environment: PATH, inherited;
// HOME, XDG_DATA_HOME, XDG_CONFIG_HOME and XDG_CACHE_HOME, each a directory under the fresh one;
// npm's cache there too; and LANG=C.UTF-8. Nothing else of the caller's reaches a child: no npmrc,
// no NODE_ENV, none of hakutaku's registered repos.
//
// With --from-pack, the installed package must hold none of the repository's own folders, and no
// devDependency may sit beside it; a line names the command that then maps and answers.
//
// With --engines-dir, map uses the engines installed in that directory. Without it, map's --yes
// installs them under the fresh directory, which needs the network.
//
// The last line is "smoke: ok (<from-pack | from-repo>, quick, <ms> ms)" and the exit code 0, once
// the fresh directory is removed; or "smoke: failed: <reason>" and the exit code 1, with the
// directory kept and named in that line, and the output of the step that failed on stderr.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const CLI = join(REPO, "dist", "cli", "main.js");
const USAGE =
  "usage: node scripts/release/smoke.mjs [--from-pack] [--engines-dir <path>]";

// The question, and what its answer must hold besides the commit the store was built from: the
// file's ID and kind, and the viewer's link, which is the answer's last key.
const TARGET = "web/src/orbits/kepler.ts";
const EXPECTED = {
  id: `observatory:${TARGET}`,
  kind: "file",
  view: "#web~src~orbits~kepler.ts",
};
const LAST_KEY = "view";

// A child's limit: an engine install with a cold cache takes minutes, a quick build of the sample
// seconds; a child that hangs ends the smoke rather than the whole job.
const CHILD_TIMEOUT_MS = 600_000;

// A failure the smoke words itself; anything else thrown is a fault of the script.
class SmokeFailure extends Error {}

const oneLine = (text) => text.replace(/\s*\n\s*/g, " ").trim();

// Removes the tree at dir. hakutaku seals the directories of an export read-only, so each
// directory first gets its owner's read, write and search back; no link is followed.
function removeAll(dir) {
  const stack = [dir];
  for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
    chmodSync(at, (lstatSync(at).mode & 0o7777) | 0o700);
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(join(at, entry.name));
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

// The environment of every child, under root.
function childEnv(root) {
  return {
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    HOME: join(root, "home"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    npm_config_cache: join(root, "npm-cache"),
    LANG: "C.UTF-8",
  };
}

// Runs one step's child, with no shell, and answers its stdout. A child that does not exit 0
// fails the smoke: everything it printed goes to stderr, and the reason names the step and how
// the child ended. No one line of that output stands for it: a crash of Node ends with Node's
// version, and npm's last line is where its log is.
function run(step, argv, cwd, env) {
  const [command, ...args] = argv;
  const r = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: CHILD_TIMEOUT_MS,
  });
  if (r.error === undefined && r.status === 0) return r.stdout;
  process.stderr.write(
    `smoke: what ${step} printed:\n${r.stdout ?? ""}${r.stderr ?? ""}\n`,
  );
  const ended =
    r.error?.code === "ETIMEDOUT"
      ? `timed out after ${CHILD_TIMEOUT_MS / 1000} s`
      : r.error !== undefined
        ? (r.error.code ?? r.error.message)
        : r.signal !== null
          ? `stopped by ${r.signal}`
          : `exit code ${r.status}`;
  throw new SmokeFailure(`${step}: ${ended}, its output on stderr`);
}

// The tarball npm pack wrote into dir, named by its --json report.
function packedTarball(report, dir) {
  let parsed;
  try {
    parsed = JSON.parse(report);
  } catch {
    throw new SmokeFailure("npm pack printed no JSON report");
  }
  const filename = Array.isArray(parsed) ? parsed[0]?.filename : undefined;
  if (typeof filename !== "string" || !/^[^/\\]+\.tgz$/.test(filename)) {
    throw new SmokeFailure("npm pack's report names no tarball");
  }
  return join(dir, filename);
}

// Throws unless npm installed hakutaku into app with none of the repository's own folders in it,
// and with none of the repository's devDependencies beside it or inside it.
function checkInstalled(app) {
  const pkg = join(app, "node_modules", "hakutaku");
  if (!existsSync(join(pkg, "package.json"))) {
    throw new SmokeFailure(
      "npm install put no hakutaku into the empty project",
    );
  }
  for (const dir of ["src", "fixtures", "test", "scripts"]) {
    if (existsSync(join(pkg, dir))) {
      throw new SmokeFailure(`the installed package holds ${dir}/`);
    }
  }
  const dev = Object.keys(
    JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"))
      .devDependencies ?? {},
  );
  const present = dev.filter(
    (name) =>
      existsSync(join(app, "node_modules", name)) ||
      existsSync(join(pkg, "node_modules", name)),
  );
  if (present.length > 0) {
    throw new SmokeFailure(
      `npm installed devDependencies with the package: ${present.join(", ")}`,
    );
  }
}

// Throws unless the answer holds the expected ID, kind and link, the store was built from head,
// and the link is the answer's last key.
function checkAnswer(printed, head) {
  let answer;
  try {
    answer = JSON.parse(printed);
  } catch {
    throw new SmokeFailure("hakutaku query printed no JSON");
  }
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
    throw new SmokeFailure("hakutaku query's answer is not an object");
  }
  const expected = { ...EXPECTED, builtCommit: head.slice(0, 12) };
  for (const [key, value] of Object.entries(expected)) {
    if (answer[key] !== value) {
      throw new SmokeFailure(
        `the answer's ${key} is ${JSON.stringify(answer[key])}, not ${JSON.stringify(value)}`,
      );
    }
  }
  const last = Object.keys(answer).at(-1);
  if (last !== LAST_KEY) {
    throw new SmokeFailure(
      `the answer's last key is ${JSON.stringify(last)}, not ${JSON.stringify(LAST_KEY)}`,
    );
  }
}

function smoke({ fromPack, enginesDir }, root) {
  const env = childEnv(root);
  for (const dir of ["home", "data", "config", "cache"]) {
    mkdirSync(join(root, dir));
  }

  // The sample, as a git repository, and the commit its main branch ends at.
  const head = run(
    "make.mjs",
    [
      process.execPath,
      join(REPO, "fixtures", "observatory", "make.mjs"),
      join(root, "sample"),
    ],
    REPO,
    env,
  ).trim();
  if (!/^[0-9a-f]{40}$/.test(head)) {
    throw new SmokeFailure(
      `make.mjs printed ${JSON.stringify(head)}, not a commit`,
    );
  }
  console.log(`smoke: the sample observatory, at ${head}`);

  // hakutaku, and the directory it runs in.
  let hakutaku;
  let cwd;
  if (fromPack) {
    const pack = join(root, "pack");
    mkdirSync(pack);
    const tarball = packedTarball(
      run(
        "npm pack",
        [
          "npm",
          "pack",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          pack,
        ],
        REPO,
        env,
      ),
      pack,
    );
    const app = join(root, "app");
    mkdirSync(app);
    writeFileSync(
      join(app, "package.json"),
      '{"name":"hakutaku-smoke","private":true}\n',
    );
    run(
      "npm install",
      [
        "npm",
        "install",
        "--no-audit",
        "--no-fund",
        "--ignore-scripts",
        tarball,
      ],
      app,
      env,
    );
    checkInstalled(app);
    hakutaku = [join(app, "node_modules", ".bin", "hakutaku")];
    cwd = app;
    console.log(`smoke: ${basename(tarball)}, installed into an empty project`);
  } else {
    hakutaku = [process.execPath, CLI];
    cwd = root;
  }
  console.log(`smoke: hakutaku is ${hakutaku.at(-1)}`);

  run(
    "hakutaku map",
    [
      ...hakutaku,
      "map",
      join(root, "sample", "observatory"),
      "--detail",
      "quick",
      "--sandbox",
      "none",
      "--yes",
      ...(enginesDir === undefined ? [] : ["--engines-dir", enginesDir]),
    ],
    cwd,
    env,
  );
  console.log("smoke: mapped at quick detail");

  checkAnswer(
    run(
      "hakutaku query",
      [
        ...hakutaku,
        "query",
        "code_explain",
        "observatory",
        "--args",
        JSON.stringify({ target: TARGET }),
      ],
      cwd,
      env,
    ),
    head,
  );
  console.log(`smoke: code_explain answered for ${TARGET}`);
}

function main(argv) {
  const started = Date.now();
  let options;
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        "from-pack": { type: "boolean" },
        "engines-dir": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values["engines-dir"] === "") throw new Error("--engines-dir is empty");
    options = {
      fromPack: values["from-pack"] === true,
      enginesDir:
        values["engines-dir"] === undefined
          ? undefined
          : resolve(values["engines-dir"]),
    };
  } catch (error) {
    console.error(USAGE);
    console.log(`smoke: failed: ${oneLine(error.message)}`);
    return 1;
  }
  if (!existsSync(CLI)) {
    console.log("smoke: failed: no dist/cli/main.js; run npm run build first");
    return 1;
  }
  const root = mkdtempSync(join(tmpdir(), "hakutaku-smoke-"));
  try {
    smoke(options, root);
  } catch (error) {
    if (!(error instanceof SmokeFailure)) console.error(error);
    const reason = error instanceof Error ? error.message : String(error);
    console.log(`smoke: failed: ${oneLine(reason)} (kept ${root})`);
    return 1;
  }
  try {
    removeAll(root);
  } catch (error) {
    console.log(
      `smoke: failed: cannot remove ${root}: ${error.code ?? oneLine(error.message)}`,
    );
    return 1;
  }
  const mode = options.fromPack ? "from-pack" : "from-repo";
  console.log(`smoke: ok (${mode}, quick, ${Date.now() - started} ms)`);
  return 0;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main(process.argv.slice(2));
}
