#!/usr/bin/env node
// Writes engines.lock.json, the lock hakutaku installs its engines from. A maintainer tool: it
// goes to the network, and it is not shipped in the package.
//
//   node scripts/pin-engines.mjs --scip-typescript <v> --dependency-cruiser <v> --ast-grep <v>
//                                --grimp <v> [--scip-python <v>]
//
// What it refuses:
// - a version published less than 14 days ago (npm's time, PyPI's upload_time of every wheel
//   it pins), or yanked;
// - a package anywhere in the npm tree whose engines.node does not admit hakutaku's Node floor
//   (package.json's engines.node) or the Node running this script;
// - a resolved package that is not on registry.npmjs.org or has no sha512 integrity;
// - grimp with dependencies of its own, since the install runs pip with --no-deps.
//
// The npm tree is resolved with --before 14 days ago, so no dependency is newer than that
// either, against the public registry with empty user and global configs. It is then installed
// with npm ci, and npm audit signatures checks every package's registry signature.
//
// grimp's requirement lists the sha256 of every wheel for Linux x86_64 and aarch64 (manylinux
// and musllinux) and macOS x86_64 and arm64, for each CPython that grimp's requires_python
// allows, as PyPI's JSON gives them. pip checks them at install.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SOAK_MS = 14 * 86_400_000;
const REGISTRY = "https://registry.npmjs.org/";
const ROOT = fileURLToPath(new URL("../", import.meta.url));

// The npm engines: their package, the detail that first needs them, and the package.json bin
// entry hakutaku runs (ast-grep's platform binary is run directly, since npm ci
// --ignore-scripts skips its wrapper's postinstall). scip-python is a devDependency, so the
// base install (--omit=dev) leaves it out.
const NPM_ENGINES = [
  {
    engine: "scip-typescript",
    pkg: "@sourcegraph/scip-typescript",
    minDetail: "standard",
    binName: "scip-typescript",
    dev: false,
  },
  {
    engine: "dependency-cruiser",
    pkg: "dependency-cruiser",
    minDetail: "quick",
    binName: "dependency-cruise",
    dev: false,
  },
  {
    engine: "ast-grep",
    pkg: "@ast-grep/cli",
    minDetail: "quick",
    binName: null,
    dev: false,
  },
  {
    engine: "scip-python",
    pkg: "@sourcegraph/scip-python",
    minDetail: "deep",
    binName: "scip-python",
    dev: true,
  },
];

// ast-grep's platform packages that must be in the lock: every platform hakutaku supports for
// which ast-grep publishes one.
const AST_GREP_PLATFORMS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64-gnu",
  "linux-x64-gnu",
];
const AST_GREP_BIN = "npm/node_modules/@ast-grep/cli-{platform}/ast-grep";

// A wheel's platform tags (dot-separated in its file name) and the platforms it serves. A wheel
// is pinned when one of its tags names one of these, and every one of them must be served.
const WHEEL_PLATFORMS = [
  ["Linux x86_64 manylinux", /^manylinux(?:1|2010|2014|_\d+_\d+)_x86_64$/],
  ["Linux aarch64 manylinux", /^manylinux(?:2014|_\d+_\d+)_aarch64$/],
  ["Linux x86_64 musllinux", /^musllinux_\d+_\d+_x86_64$/],
  ["Linux aarch64 musllinux", /^musllinux_\d+_\d+_aarch64$/],
  ["macOS x86_64", /^macosx_\d+_\d+_(?:x86_64|universal2)$/],
  ["macOS arm64", /^macosx_\d+_\d+_(?:arm64|universal2)$/],
];

function die(message) {
  process.stderr.write(`pin-engines: ${message}\n`);
  process.exit(1);
}

function options() {
  const { values } = parseArgs({
    options: {
      "scip-typescript": { type: "string" },
      "dependency-cruiser": { type: "string" },
      "ast-grep": { type: "string" },
      grimp: { type: "string" },
      "scip-python": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  for (const name of [
    "scip-typescript",
    "dependency-cruiser",
    "ast-grep",
    "grimp",
  ]) {
    if (values[name] === undefined) die(`--${name} <version> is required`);
  }
  for (const [name, value] of Object.entries(values)) {
    if (!/^\d+(\.\d+)*$/.test(value)) {
      die(`--${name} takes an exact release version, not ${value}`);
    }
  }
  return values;
}

// npm's child environment: this process's, without npm's own config variables, so that only
// the flags below configure it.
function npmEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^npm_config_/i.test(key)) env[key] = value;
  }
  return env;
}

function npm(cwd, args, flags) {
  const r = spawnSync("npm", [...args, ...flags], {
    cwd,
    env: npmEnv(),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error !== undefined) die(`cannot run npm: ${r.error.message}`);
  if (r.status !== 0) {
    die(`npm ${args.join(" ")} exited with code ${r.status}:\n${r.stderr}`);
  }
  return r.stdout;
}

function checkSoaked(what, published, cutoff) {
  if (published === undefined || Number.isNaN(Date.parse(published))) {
    die(`${what} has no publish time`);
  }
  if (Date.parse(published) > cutoff) {
    die(`${what} was published ${published}, less than 14 days ago`);
  }
}

// PEP 440 specifiers over plain release numbers (">=3.10", "<4,!=3.11.*"), all of which must
// hold. Enough for a requires_python.
function satisfies(version, spec) {
  const parts = (v) => v.split(".").map(Number);
  const cmp = (a, b) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] ?? 0) - (b[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
  const v = parts(version);
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .every((clause) => {
      const m = /^(~=|===|==|!=|<=|>=|<|>)\s*(\d+(?:\.\d+)*)(\.\*)?$/.exec(
        clause,
      );
      if (m === null) die(`cannot read the requires_python clause ${clause}`);
      const [, op, number, star] = m;
      const w = parts(number);
      if (star !== undefined) {
        const prefix = cmp(v.slice(0, w.length), w) === 0;
        if (op === "==") return prefix;
        if (op === "!=") return !prefix;
        die(`cannot read the requires_python clause ${clause}`);
      }
      const c = cmp(v, w);
      switch (op) {
        case ">=":
          return c >= 0;
        case ">":
          return c > 0;
        case "<=":
          return c <= 0;
        case "<":
          return c < 0;
        case "==":
        case "===":
          return c === 0;
        case "!=":
          return c !== 0;
        default:
          // ~=X.Y means >=X.Y and ==X.*
          return c >= 0 && cmp(v.slice(0, w.length - 1), w.slice(0, -1)) === 0;
      }
    });
}

// The platform of the Node running this script, named as hakutaku's enginePlatform names it.
function thisPlatform() {
  const { platform, arch } = process;
  if (platform === "darwin") return `darwin-${arch}`;
  const report = process.report.getReport();
  const libc =
    typeof report.header.glibcVersionRuntime === "string" ? "gnu" : "musl";
  return `${platform}-${arch}-${libc}`;
}

async function pinGrimp(version, cutoff) {
  const response = await fetch(`https://pypi.org/pypi/grimp/${version}/json`);
  if (!response.ok)
    die(`PyPI answered ${response.status} for grimp ${version}`);
  const release = await response.json();
  if (release.info.yanked) die(`grimp ${version} is yanked`);
  const requires = release.info.requires_dist ?? [];
  if (requires.length > 0) {
    die(`grimp ${version} requires ${requires.join(", ")}; pin them too`);
  }
  const python = release.info.requires_python;
  if (typeof python !== "string" || python === "") {
    die(`grimp ${version} states no requires_python`);
  }
  const served = new Set();
  const hashes = new Set();
  for (const file of release.urls) {
    const m = /^grimp-[^-]+-cp(\d)(\d+)-[^-]+-([^-]+)\.whl$/.exec(
      file.filename,
    );
    if (m === null) continue;
    if (!satisfies(`${m[1]}.${m[2]}`, python)) continue;
    const tags = m[3].split(".");
    const platforms = WHEEL_PLATFORMS.filter(([, re]) =>
      tags.some((t) => re.test(t)),
    ).map(([name]) => name);
    if (platforms.length === 0) continue;
    if (file.yanked) die(`${file.filename} is yanked`);
    checkSoaked(file.filename, file.upload_time_iso_8601, cutoff);
    const digest = file.digests?.sha256;
    if (!/^[0-9a-f]{64}$/.test(digest ?? "")) {
      die(`${file.filename} has no sha256 digest`);
    }
    for (const p of platforms) served.add(p);
    hashes.add(digest);
  }
  for (const [name] of WHEEL_PLATFORMS) {
    if (!served.has(name)) die(`grimp ${version} has no wheel for ${name}`);
  }
  const line = [
    `grimp==${version}`,
    ...[...hashes].sort().map((h) => `--hash=sha256:${h}`),
  ].join(" ");
  console.log(
    `grimp ${version}: ${hashes.size} wheels, requires_python ${python}`,
  );
  return { requirements: `${line}\n`, python };
}

function checkTree(packageLock, dir) {
  if (packageLock.lockfileVersion !== 3) {
    die(`npm wrote lockfileVersion ${packageLock.lockfileVersion}, not 3`);
  }
  const require = createRequire(join(dir, "package.json"));
  let semver;
  try {
    semver = require("semver");
  } catch {
    die("cannot load semver from the resolved tree to check engines.node");
  }
  const rootPackage = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  );
  const floor = semver.minVersion(rootPackage.engines.node)?.version;
  if (floor === undefined) die("package.json's engines.node has no floor");
  const nodes = [...new Set([floor, process.versions.node])];
  for (const [path, entry] of Object.entries(packageLock.packages)) {
    if (path === "") continue;
    if (!entry.resolved?.startsWith(REGISTRY)) {
      die(`${path} resolves to ${entry.resolved}, not ${REGISTRY}`);
    }
    if (!entry.integrity?.startsWith("sha512-")) {
      die(`${path} has no sha512 integrity`);
    }
    const range = entry.engines?.node;
    if (typeof range !== "string") continue;
    if (semver.validRange(range) === null) {
      console.log(`note: ${path} states engines.node ${range}, not a range`);
      continue;
    }
    for (const node of nodes) {
      if (!semver.satisfies(node, range)) {
        die(`${path} needs Node ${range}, which excludes Node ${node}`);
      }
    }
  }
  for (const platform of AST_GREP_PLATFORMS) {
    if (
      packageLock.packages[`node_modules/@ast-grep/cli-${platform}`] ===
      undefined
    ) {
      die(`the lock has no @ast-grep/cli-${platform}`);
    }
  }
  if (/\/(?:home|Users)\/[A-Za-z0-9._-]+/.test(JSON.stringify(packageLock))) {
    die("the npm lock holds a home-directory path");
  }
  console.log(`engines.node admits Node ${nodes.join(" and ")} everywhere`);
}

function npmBin(dir, pkg, binName) {
  const manifest = JSON.parse(
    readFileSync(join(dir, "node_modules", pkg, "package.json"), "utf8"),
  );
  const bins =
    typeof manifest.bin === "string"
      ? { [manifest.name.replace(/^@[^/]+\//, "")]: manifest.bin }
      : (manifest.bin ?? {});
  const bin = bins[binName];
  if (typeof bin !== "string") die(`${pkg} has no bin ${binName}`);
  return `npm/node_modules/${pkg}/${bin.replace(/^\.\//, "")}`;
}

function reportVersion(label, command, args) {
  const r = spawnSync(command, args, { encoding: "utf8", timeout: 120_000 });
  const out = (r.stdout ?? "").trim().split("\n")[0];
  if (r.status !== 0) die(`${label} --version exited with code ${r.status}`);
  console.log(`${label} --version: ${out}`);
}

async function main() {
  const versions = options();
  const cutoff = Date.now() - SOAK_MS;
  const engines = NPM_ENGINES.filter((e) => versions[e.engine] !== undefined);

  const work = mkdtempSync(join(tmpdir(), "hakutaku-pin-"));
  try {
    // Two empty files: npm refuses to load one file as both.
    const user = join(work, "user.npmrc");
    const global = join(work, "global.npmrc");
    writeFileSync(user, "");
    writeFileSync(global, "");
    const flags = [
      `--registry=${REGISTRY}`,
      `--userconfig=${user}`,
      `--globalconfig=${global}`,
    ];

    for (const e of engines) {
      const time = JSON.parse(
        npm(work, ["view", e.pkg, "time", "--json"], flags),
      );
      checkSoaked(
        `${e.pkg}@${versions[e.engine]}`,
        time[versions[e.engine]],
        cutoff,
      );
    }
    const pip = await pinGrimp(versions.grimp, cutoff);

    const sorted = (list) =>
      Object.fromEntries(
        list
          .map((e) => [e.pkg, versions[e.engine]])
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    const packageJson = {
      name: "hakutaku-engines",
      private: true,
      dependencies: sorted(engines.filter((e) => !e.dev)),
      devDependencies: sorted(engines.filter((e) => e.dev)),
    };
    const dir = join(work, "npm");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );
    const quiet = ["--ignore-scripts", "--no-audit", "--no-fund"];
    npm(
      dir,
      [
        "install",
        "--package-lock-only",
        ...quiet,
        `--before=${new Date(cutoff).toISOString()}`,
      ],
      flags,
    );
    npm(dir, ["ci", ...quiet], flags);
    process.stdout.write(npm(dir, ["audit", "signatures"], flags));
    const packageLock = JSON.parse(
      readFileSync(join(dir, "package-lock.json"), "utf8"),
    );
    checkTree(packageLock, dir);

    const found = new Map([
      ["grimp", { version: versions.grimp, minDetail: "quick", bin: "python" }],
    ]);
    for (const e of engines) {
      let bin;
      if (e.binName === null) {
        const own = AST_GREP_BIN.replace("{platform}", thisPlatform());
        const path = join(work, own);
        if (!existsSync(path) || !statSync(path).isFile()) {
          die(`ast-grep's binary is not at ${own}`);
        }
        reportVersion(e.engine, path, ["--version"]);
        bin = AST_GREP_BIN;
      } else {
        bin = npmBin(dir, e.pkg, e.binName);
        reportVersion(e.engine, process.execPath, [
          join(work, bin),
          "--version",
        ]);
      }
      found.set(e.engine, {
        version: versions[e.engine],
        minDetail: e.minDetail,
        bin,
      });
    }
    // The engines in hakutaku's order; scip-python only when it was given.
    const order = [
      "scip-typescript",
      "dependency-cruiser",
      "ast-grep",
      "grimp",
      "scip-python",
    ];
    const lock = {
      lockVersion: 1,
      npm: { packageJson, packageLock },
      pip,
      engines: Object.fromEntries(
        order.filter((n) => found.has(n)).map((n) => [n, found.get(n)]),
      ),
    };
    const text = `${JSON.stringify(lock, null, 2)}\n`;
    writeFileSync(join(ROOT, "engines.lock.json"), text);
    const hash = createHash("sha256").update(text).digest("hex");
    console.log(`wrote engines.lock.json, sha256 ${hash}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

await main();
