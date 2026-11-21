// Engines directories for builds that lose an engine. Each is a fresh directory under the OS temp
// directory, made of links to the installed engines directory (`hakutaku engines install`), and
// removed after the last test of the file that made it; sandboxEnginesDir's is made of real
// files instead.
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { afterAll } from "vitest";
import {
  defaultEnginesDir,
  readLock,
  resolveBin,
} from "../../src/engines/index.js";
import type { EngineName } from "../../src/model/index.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-engines-"));
  made.push(dir);
  return dir;
}

// Links each entry of `from` into `to`, but the one named `except`.
function linkEntries(from: string, to: string, except: string): void {
  for (const name of readdirSync(from)) {
    if (name !== except) symlinkSync(join(from, name), join(to, name));
  }
}

// The installed engines directory, as links, except along the path `parts`: each directory on
// it is a real one holding links to its other entries, and the last part is what `write` makes.
function mirror(parts: string[], write: (at: string) => void): string {
  const root = freshDir();
  let from = resolve(defaultEnginesDir());
  let to = root;
  parts.forEach((part, i) => {
    linkEntries(from, to, part);
    from = join(from, part);
    to = join(to, part);
    if (i < parts.length - 1) mkdirSync(to);
  });
  write(to);
  return root;
}

// An engines directory whose `engine` exits 1 as soon as it runs: a Node bin is a script that
// exits 1, a native bin a shell script that does, and grimp a package whose import exits 1.
// installed.json and every other engine are the installed ones.
export function brokenEnginesDir(engine: EngineName): string {
  if (engine === "grimp") {
    return mirror([...binParts(engine), "grimp", "__init__.py"], (at) =>
      writeFileSync(at, "raise SystemExit(1)\n"),
    );
  }
  return standInEnginesDir(engine, {
    node: "process.exit(1);\n",
    sh: "#!/bin/sh\nexit 1\n",
  });
}

// An engines directory whose `engine`, a Node or a native bin, is the stand-in given for its
// kind: a Node script, or a shell script. installed.json and every other engine are the
// installed ones.
export function standInEnginesDir(
  engine: Exclude<EngineName, "grimp">,
  script: { node?: string; sh?: string },
): string {
  return mirror(binParts(engine), (at) => {
    const node = /\.[cm]?js$/.test(at);
    const text = node ? script.node : script.sh;
    if (text === undefined) {
      throw new Error(`no ${node ? "Node" : "shell"} stand-in for ${engine}`);
    }
    writeFileSync(at, text);
    if (!node) chmodSync(at, 0o755);
  });
}

// The path of an engine's bin inside the installed engines directory, as its parts.
function binParts(engine: EngineName): string[] {
  const entry = readLock().lock.engines[engine];
  if (entry === undefined) throw new Error(`the lock has no ${engine}`);
  const installed = resolve(defaultEnginesDir());
  return relative(installed, resolveBin(installed, entry.bin)).split(sep);
}

// An engines directory as installed without a Python: installed.json's python is null, so
// grimp is not run.
export function enginesDirWithoutPython(): string {
  const installed = resolve(defaultEnginesDir());
  return mirror(["installed.json"], (at) => {
    const record = JSON.parse(
      readFileSync(join(installed, "installed.json"), "utf8"),
    );
    writeFileSync(
      at,
      `${JSON.stringify({ ...record, python: null }, null, 2)}\n`,
    );
  });
}

// An engines directory for a build at quick detail inside a sandbox, made of real files and no
// link: the sandbox shows the engines directory alone, so a link out of it cannot be followed
// there. It holds installed.json without a Python, a copy of the installed ast-grep,
// dependency-cruiser as the Node script given, and scip-typescript as an empty file, which
// quick detail never runs.
export function sandboxEnginesDir(depcruise: string): string {
  const installed = resolve(defaultEnginesDir());
  const dir = freshDir();
  const record = JSON.parse(
    readFileSync(join(installed, "installed.json"), "utf8"),
  );
  writeFileSync(
    join(dir, "installed.json"),
    `${JSON.stringify({ ...record, python: null }, null, 2)}\n`,
  );
  const at = (engine: EngineName): string => {
    const bin = join(dir, ...binParts(engine));
    mkdirSync(dirname(bin), { recursive: true });
    return bin;
  };
  const astGrep = at("ast-grep");
  copyFileSync(join(installed, ...binParts("ast-grep")), astGrep);
  chmodSync(astGrep, 0o755);
  writeFileSync(at("dependency-cruiser"), depcruise);
  writeFileSync(at("scip-typescript"), "");
  return dir;
}
