// Engines directories for the unit tests, made from the lock with no network: an installed.json,
// and stand-in bins that print the versions the lock pins. Each directory sits under the OS temp
// directory and is removed after the last test of the file that made it.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll } from "vitest";
import {
  ENGINE_ORDER,
  readLock,
  resolveBin,
} from "../../../src/engines/index.js";
import { removeTree } from "../../../src/export/index.js";
import type { EngineName } from "../../../src/model/index.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) removeTree(dir);
});

export function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-engines-"));
  made.push(dir);
  return dir;
}

// Writes an installed.json into dir: the lock's hash, a fixed time, no deep install and no
// Python, then patch.
export function installedDir(
  patch: Record<string, unknown>,
  dir: string = tmp(),
): string {
  const record = {
    lockHash: readLock().hash,
    installedAt: "2026-11-20T00:00:00.000Z",
    deep: false,
    python: null,
    ...patch,
  };
  writeFileSync(
    join(dir, "installed.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return dir;
}

// A /bin/sh script at path, made executable.
export function writeScript(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

export interface FakeInstall {
  python?: boolean; // grimp and a stand-in interpreter; true by default
  deep?: boolean; // scip-python too; false by default
  versions?: Partial<Record<EngineName, string>>; // what an engine reports instead of its pin
  fail?: EngineName; // this engine exits 1 and prints nothing
}

// A complete install in a fresh directory. A Node engine's bin prints its version, and
// ast-grep's prints "ast-grep <version>", as the real ones do. With python, grimp is a package
// under python/, and installed.json names a stand-in interpreter, outside the directory, that
// prints grimp's version whatever it is asked.
export function fakeInstall(opts: FakeInstall = {}): string {
  const { lock } = readLock();
  const withPython = opts.python ?? true;
  const deep = opts.deep ?? false;
  const dir = tmp();
  let python: string | null = null;
  mkdirSync(join(dir, "npm"), { recursive: true });
  mkdirSync(join(dir, "python"), { recursive: true });
  for (const name of ENGINE_ORDER) {
    const entry = lock.engines[name];
    if (entry === undefined) continue;
    if (name === "scip-python" && !deep) continue;
    const version = opts.versions?.[name] ?? entry.version;
    const fails = opts.fail === name;
    if (name === "grimp") {
      if (!withPython) continue;
      mkdirSync(join(dir, "python", "grimp"), { recursive: true });
      writeFileSync(join(dir, "python", "grimp", "__init__.py"), "");
      python = writeScript(
        join(dir, "..", `${dir.split("/").pop()}-python`, "python3"),
        fails ? "exit 1" : `echo ${version}`,
      );
      made.push(dirname(python));
      continue;
    }
    const bin = resolveBin(dir, entry.bin);
    if (/\.(?:c|m)?js$/.test(bin)) {
      mkdirSync(dirname(bin), { recursive: true });
      writeFileSync(
        bin,
        fails
          ? "process.exit(1);\n"
          : `console.log(${JSON.stringify(version)});\n`,
      );
    } else {
      writeScript(bin, fails ? "exit 1" : `echo "${name} ${version}"`);
    }
  }
  installedDir({ deep, python }, dir);
  return dir;
}
