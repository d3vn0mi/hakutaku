// The engine lock, engines.lock.json, which sits at the package root and ships in the package.
// scripts/pin-engines.mjs writes it; nothing here changes it.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Detail, EngineName } from "../model/index.js";

export interface EngineEntry {
  version: string;
  minDetail: Detail;
  bin: string; // relative to the engines directory; it may hold {platform}
}

export interface EngineLock {
  lockVersion: 1;
  npm: {
    // Written to <dir>/npm/package.json. devDependencies holds scip-python alone, so the base
    // install's --omit=dev leaves it out.
    packageJson: {
      name: "hakutaku-engines";
      private: true;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    packageLock: object; // npm's lockfile v3, with every integrity hash
  };
  pip: {
    requirements: string; // "name==version --hash=sha256:<hex> ..." for every wheel, one line per package
    python: string; // the CPython range the wheels serve, as a PEP 440 specifier
  };
  // scip-python is absent when deep detail does not ship
  engines: Record<Exclude<EngineName, "scip-python">, EngineEntry> & {
    "scip-python"?: EngineEntry;
  };
}

// The engines in hakutaku's order: verify reports, and list prints, in this order.
export const ENGINE_ORDER: readonly EngineName[] = Object.freeze([
  "scip-typescript",
  "dependency-cruiser",
  "ast-grep",
  "grimp",
  "scip-python",
]);

const DETAILS: readonly string[] = ["quick", "standard", "deep"];

// The lock sits two directories above this module, both in src/engines/ and in dist/engines/.
const LOCK_URL = new URL("../../engines.lock.json", import.meta.url);

let cached: { lock: EngineLock; hash: string } | undefined;

// The lock, read and checked once per process, and frozen all the way down. hash is the sha256
// of the file's bytes, which names the engines directory.
export function readLock(): { lock: EngineLock; hash: string } {
  if (cached === undefined) {
    const bytes = readFileSync(LOCK_URL);
    const lock: unknown = JSON.parse(bytes.toString("utf8"));
    checkLock(lock);
    cached = Object.freeze({
      lock: deepFreeze(lock),
      hash: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return cached;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) && Object.values(value).every((v) => typeof v === "string")
  );
}

// A bin is a relative path inside the engines directory: no leading "/", and no empty, "." or
// ".." segment.
function isInsidePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value.split("/").every((s) => s !== "" && s !== "." && s !== "..")
  );
}

function checkLock(value: unknown): asserts value is EngineLock {
  const fail = (why: string): never => {
    throw new Error(`engines.lock.json is not valid: ${why}`);
  };
  if (!isRecord(value)) return fail("not an object");
  if (value.lockVersion !== 1) fail("lockVersion is not 1");
  const npm = value.npm;
  if (!isRecord(npm)) return fail("npm is not an object");
  const packageJson = npm.packageJson;
  if (
    !isRecord(packageJson) ||
    packageJson.name !== "hakutaku-engines" ||
    packageJson.private !== true ||
    !isStringMap(packageJson.dependencies) ||
    !isStringMap(packageJson.devDependencies)
  ) {
    fail("npm.packageJson is not the engines' package.json");
  }
  if (!isRecord(npm.packageLock)) fail("npm.packageLock is not an object");
  const pip = value.pip;
  if (
    !isRecord(pip) ||
    typeof pip.requirements !== "string" ||
    typeof pip.python !== "string"
  ) {
    fail("pip does not hold requirements and python");
  }
  const engines = value.engines;
  if (!isRecord(engines)) return fail("engines is not an object");
  for (const name of Object.keys(engines)) {
    if (!(ENGINE_ORDER as readonly string[]).includes(name)) {
      fail(`unknown engine ${name}`);
    }
  }
  for (const name of ENGINE_ORDER) {
    const entry = engines[name];
    if (entry === undefined && name === "scip-python") continue;
    if (
      !isRecord(entry) ||
      typeof entry.version !== "string" ||
      entry.version === "" ||
      typeof entry.minDetail !== "string" ||
      !DETAILS.includes(entry.minDetail) ||
      !isInsidePath(entry.bin)
    ) {
      fail(`engines.${name} is not a version, a detail and a bin`);
    }
  }
}
