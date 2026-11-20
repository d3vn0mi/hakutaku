import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  listEngines,
  readInstalled,
  readLock,
  resolveBin,
  verifyEngines,
} from "../../../src/engines/index.js";
import { fakeInstall, installedDir, tmp, writeScript } from "./fake.js";

const pin = (name: keyof ReturnType<typeof readLock>["lock"]["engines"]) =>
  readLock().lock.engines[name]?.version;
const bin = (
  dir: string,
  name: "scip-typescript" | "ast-grep" | "scip-python",
) => resolveBin(dir, readLock().lock.engines[name]?.bin ?? "");

// A python3 on this machine's PATH, for the test that runs a real interpreter.
const python3 = (() => {
  try {
    return execFileSync(
      "python3",
      ["-c", "import sys; print(sys.executable)"],
      {
        encoding: "utf8",
      },
    ).trim();
  } catch {
    return null;
  }
})();

it("reports a missing install, another lock and a missing bin", () => {
  expect(verifyEngines(tmp()).problems).toEqual(["not installed"]);
  expect(
    verifyEngines(installedDir({ lockHash: "0".repeat(64) })).problems,
  ).toEqual(["installed for another lock"]);
  expect(
    verifyEngines(installedDir({}), { runVersions: false }).problems[0],
  ).toMatch(/^scip-typescript missing at /);
});

it("reports not installed for a directory that does not exist", () =>
  expect(verifyEngines(join(tmp(), "nowhere"))).toEqual({
    ok: false,
    problems: ["not installed"],
  }));

it("reports every missing bin, in the engines' order, at its absolute path", () => {
  const dir = installedDir({ python: "/opt/observatory/python3" });
  expect(verifyEngines(dir, { runVersions: false }).problems).toEqual([
    `scip-typescript missing at ${bin(dir, "scip-typescript")}`,
    `dependency-cruiser missing at ${resolveBin(dir, readLock().lock.engines["dependency-cruiser"].bin)}`,
    `ast-grep missing at ${bin(dir, "ast-grep")}`,
    `grimp missing at ${join(dir, "python")}`,
  ]);
});

it.each([
  ["is not JSON", "{ lockHash"],
  ["is not an object", "[]"],
  ["has no lock hash", JSON.stringify({ deep: false, python: null })],
])("reports an installed.json that %s as not valid", (_, text) => {
  const dir = tmp();
  writeFileSync(join(dir, "installed.json"), text);
  expect(verifyEngines(dir).problems).toEqual(["installed.json is not valid"]);
});

it("reports a valid-looking record with a bad field as not valid, once its lock matches", () => {
  for (const patch of [
    { deep: "no" },
    { python: 3 },
    { python: "python3" },
    { installedAt: 7 },
  ]) {
    expect(
      verifyEngines(installedDir(patch)).problems,
      JSON.stringify(patch),
    ).toEqual(["installed.json is not valid"]);
  }
});

it("answers without blocking when installed.json is a FIFO or a directory", () => {
  const fifo = tmp();
  execFileSync("mkfifo", [join(fifo, "installed.json")]);
  expect(verifyEngines(fifo).problems).toEqual(["installed.json is not valid"]);
  const folder = tmp();
  mkdirSync(join(folder, "installed.json"));
  expect(verifyEngines(folder).problems).toEqual([
    "installed.json is not valid",
  ]);
});

it("verifies a complete install by running every engine for its version", () => {
  expect(verifyEngines(fakeInstall())).toEqual({ ok: true, problems: [] });
});

it("reports an engine that answers another version, and one that does not answer", () => {
  const dir = fakeInstall({
    versions: { "dependency-cruiser": "16.0.0", grimp: "3.0" },
    fail: "ast-grep",
  });
  expect(verifyEngines(dir).problems).toEqual([
    `dependency-cruiser reports 16.0.0, expected ${pin("dependency-cruiser")}`,
    `ast-grep reports nothing (exit code 1), expected ${pin("ast-grep")}`,
    `grimp reports 3.0, expected ${pin("grimp")}`,
  ]);
  expect(verifyEngines(dir, { runVersions: false })).toEqual({
    ok: true,
    problems: [],
  });
});

it("reports a bin that cannot run", () => {
  const dir = fakeInstall();
  chmodSync(bin(dir, "ast-grep"), 0o644);
  expect(verifyEngines(dir).problems).toEqual([
    `ast-grep reports nothing (cannot run it: EACCES), expected ${pin("ast-grep")}`,
  ]);
});

it("skips grimp when the install has no Python", () => {
  expect(verifyEngines(fakeInstall({ python: false }))).toEqual({
    ok: true,
    problems: [],
  });
});

it("runs grimp's version check isolated, with -I -S and python/ as its one path", () => {
  const dir = fakeInstall();
  const args = join(tmp(), "args");
  const python = writeScript(
    join(tmp(), "python3"),
    `printf '%s\\n' "$@" > "${args}"; echo ${pin("grimp")}`,
  );
  installedDir({ python }, dir);
  expect(verifyEngines(dir)).toEqual({ ok: true, problems: [] });
  const argv = readFileSync(args, "utf8").split("\n").slice(0, -1);
  expect(argv).toHaveLength(5);
  expect(argv.slice(0, 3)).toEqual(["-I", "-S", "-c"]);
  expect(argv[4]).toBe(join(dir, "python"));
});

it("reports grimp missing when the pinned interpreter is gone", () => {
  const dir = fakeInstall();
  const python = readInstalled(dir)?.python ?? "";
  unlinkSync(python);
  expect(verifyEngines(dir, { runVersions: false }).problems).toEqual([
    `grimp missing at ${python}`,
  ]);
});

it("checks scip-python only with deep", () => {
  const base = fakeInstall();
  expect(verifyEngines(base).ok).toBe(true);
  expect(verifyEngines(base, { deep: true }).problems).toEqual([
    `scip-python missing at ${bin(base, "scip-python")}`,
  ]);
  expect(verifyEngines(fakeInstall({ deep: true }), { deep: true })).toEqual({
    ok: true,
    problems: [],
  });
});

it.skipIf(python3 === null)(
  "reads grimp's version from python/ with the pinned interpreter",
  () => {
    const dir = fakeInstall();
    const info = join(dir, "python", `grimp-${pin("grimp")}.dist-info`);
    mkdirSync(info);
    writeFileSync(
      join(info, "METADATA"),
      `Metadata-Version: 2.1\nName: grimp\nVersion: ${pin("grimp")}\n`,
    );
    installedDir({ python: realpathSync(python3 ?? "") }, dir);
    expect(verifyEngines(dir)).toEqual({ ok: true, problems: [] });
    rmSync(info, { recursive: true });
    expect(verifyEngines(dir).problems).toEqual([
      `grimp reports nothing (exit code 1), expected ${pin("grimp")}`,
    ]);
  },
);

it("reads installed.json, or answers null when it is missing or not valid", () => {
  const dir = fakeInstall({ python: false });
  expect(readInstalled(dir)).toEqual({
    lockHash: readLock().hash,
    installedAt: "2026-11-20T00:00:00.000Z",
    deep: false,
    python: null,
  });
  expect(readInstalled(tmp())).toBeNull();
  expect(readInstalled(installedDir({ deep: 1 }))).toBeNull();
});

it("lists every engine with its version, minimum detail and whether it is installed", () => {
  const rows = (dir: string) =>
    listEngines(dir).map((r) => [
      r.engine,
      r.version,
      r.minDetail,
      r.installed,
    ]);
  const { engines } = readLock().lock;
  const want = (installed: boolean[]) =>
    Object.entries(engines).map(([name, e], i) => [
      name,
      e.version,
      e.minDetail,
      installed[i],
    ]);
  expect(rows(tmp())).toEqual(want([false, false, false, false, false]));
  expect(rows(fakeInstall())).toEqual(want([true, true, true, true, false]));
  expect(rows(fakeInstall({ python: false, deep: true }))).toEqual(
    want([true, true, true, false, true]),
  );
  expect(
    rows(installedDir({ lockHash: "0".repeat(64) }, fakeInstall())),
  ).toEqual(want([false, false, false, false, false]));
});

it("runs each engine from the engines directory, with no environment of its own", () => {
  const dir = fakeInstall();
  writeScript(
    bin(dir, "ast-grep"),
    `[ "$(pwd -P)" = "${realpathSync(dir)}" ] && [ -z "$HOME" ] && [ -z "$OBSERVATORY" ] && echo "ast-grep ${pin("ast-grep")}"`,
  );
  process.env.OBSERVATORY = "1";
  try {
    expect(verifyEngines(dir)).toEqual({ ok: true, problems: [] });
  } finally {
    delete process.env.OBSERVATORY;
  }
});
