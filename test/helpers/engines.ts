// Engines directories for builds that lose an engine. Each is a fresh directory under the OS temp
// directory, made of links to the installed engines directory (`hakutaku engines install`), and
// removed after the last test of the file that made it.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
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
  const entry = readLock().lock.engines[engine];
  if (entry === undefined) throw new Error(`the lock has no ${engine}`);
  const installed = resolve(defaultEnginesDir());
  const bin = relative(installed, resolveBin(installed, entry.bin)).split(sep);
  if (engine === "grimp") {
    return mirror([...bin, "grimp", "__init__.py"], (at) =>
      writeFileSync(at, "raise SystemExit(1)\n"),
    );
  }
  return mirror(bin, (at) => {
    if (/\.[cm]?js$/.test(at)) {
      writeFileSync(at, "process.exit(1);\n");
    } else {
      writeFileSync(at, "#!/bin/sh\nexit 1\n");
      chmodSync(at, 0o755);
    }
  });
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
