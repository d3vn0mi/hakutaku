import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import {
  defaultEnginesDir,
  ENGINE_ORDER,
  readLock,
} from "../../../src/engines/index.js";

const saved = { ...process.env };
afterEach(() => {
  for (const key of ["XDG_DATA_HOME", "HOME"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

it("hashes the lock file's bytes", () =>
  expect(readLock().hash).toBe(
    createHash("sha256")
      .update(readFileSync("engines.lock.json"))
      .digest("hex"),
  ));

it("names the engines directory by the lock hash", () => {
  process.env.XDG_DATA_HOME = "/d";
  expect(defaultEnginesDir()).toBe(
    `/d/hakutaku/engines/${readLock().hash.slice(0, 16)}/`,
  );
});

it("names the engines directory under the home directory without XDG_DATA_HOME", () => {
  delete process.env.XDG_DATA_HOME;
  process.env.HOME = "/observatory";
  expect(defaultEnginesDir()).toBe(
    `/observatory/.local/share/hakutaku/engines/${readLock().hash.slice(0, 16)}/`,
  );
});

it("pins every engine at its minimum detail, scip-typescript at standard and scip-python at deep", () => {
  const { engines } = readLock().lock;
  expect(Object.keys(engines)).toEqual([...ENGINE_ORDER]);
  expect(
    Object.fromEntries(
      Object.entries(engines).map(([name, e]) => [name, e.minDetail]),
    ),
  ).toEqual({
    "scip-typescript": "standard",
    "dependency-cruiser": "quick",
    "ast-grep": "quick",
    grimp: "quick",
    "scip-python": "deep",
  });
});

it("runs grimp from python/, ast-grep's platform binary, and every other bin inside npm/", () => {
  const { engines } = readLock().lock;
  expect(engines.grimp.bin).toBe("python");
  expect(engines["ast-grep"].bin).toBe(
    "npm/node_modules/@ast-grep/cli-{platform}/ast-grep",
  );
  for (const name of [
    "scip-typescript",
    "dependency-cruiser",
    "scip-python",
  ] as const) {
    expect(engines[name]?.bin).toMatch(/^npm\/node_modules\/[^{}]+\.(?:m?js)$/);
  }
});

it("holds scip-python alone in devDependencies, and every other npm engine at its pin", () => {
  const { lock } = readLock();
  const { packageJson } = lock.npm;
  expect(packageJson.name).toBe("hakutaku-engines");
  expect(packageJson.private).toBe(true);
  expect(packageJson.devDependencies).toEqual({
    "@sourcegraph/scip-python": lock.engines["scip-python"]?.version,
  });
  expect(packageJson.dependencies).toEqual({
    "@ast-grep/cli": lock.engines["ast-grep"].version,
    "@sourcegraph/scip-typescript": lock.engines["scip-typescript"].version,
    "dependency-cruiser": lock.engines["dependency-cruiser"].version,
  });
});

it("resolves every npm package from the public registry, with a sha512 integrity", () => {
  const packageLock = readLock().lock.npm.packageLock as {
    lockfileVersion: number;
    packages: Record<string, { resolved?: string; integrity?: string }>;
  };
  expect(packageLock.lockfileVersion).toBe(3);
  const bad = Object.entries(packageLock.packages)
    .filter(([path]) => path !== "")
    .filter(
      ([, p]) =>
        !p.resolved?.startsWith("https://registry.npmjs.org/") ||
        !p.integrity?.startsWith("sha512-"),
    )
    .map(([path]) => path);
  expect(bad).toEqual([]);
  for (const platform of [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64-gnu",
    "linux-x64-gnu",
  ]) {
    expect(
      packageLock.packages[`node_modules/@ast-grep/cli-${platform}`],
    ).toBeDefined();
  }
});

it("pins grimp with one hashed requirement line, and the Python range grimp allows", () => {
  const { lock } = readLock();
  expect(lock.pip.requirements).toMatch(
    new RegExp(
      `^grimp==${lock.engines.grimp.version.replaceAll(".", "\\.")}( --hash=sha256:[0-9a-f]{64})+\\n$`,
    ),
  );
  expect(lock.pip.python).toMatch(/^>=3\.\d+$/);
});

it("reads the lock once, and hands out a frozen copy", () => {
  const first = readLock();
  expect(readLock()).toBe(first);
  expect(Object.isFrozen(first.lock)).toBe(true);
  expect(Object.isFrozen(first.lock.engines.grimp)).toBe(true);
  expect(Object.isFrozen(first.lock.npm.packageJson.dependencies)).toBe(true);
});
