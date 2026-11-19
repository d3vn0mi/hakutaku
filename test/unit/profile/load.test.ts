import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import {
  DEFAULT_PROFILE,
  loadProfile,
  loadRules,
  type Profile,
  ProfileError,
  profileHash,
  type Rules,
} from "../../../src/profile/index.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A fresh directory under the OS temp directory, removed after the file's last test.
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-profile-"));
  made.push(dir);
  return dir;
};

const writeTmp = (name: string, data: string | Uint8Array): string => {
  const path = join(tmp(), name);
  writeFileSync(path, data);
  return path;
};

// The ProfileError that f throws; any other outcome fails the test.
const refusal = (f: () => unknown): ProfileError => {
  try {
    f();
  } catch (error) {
    if (error instanceof ProfileError) return error;
    throw error;
  }
  throw new Error("expected a ProfileError, and nothing was thrown");
};

const without = (value: object, key: string): object =>
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

const D = DEFAULT_PROFILE;
const REL =
  'must be repo-relative, with no leading or trailing "/" and no empty, "." or ".." segment';
const ROOT = `must be "." or ${REL.slice("must be ".length)}`;
const SEVERITY = 'must be "error", "warn" or "info"';

it("loads a valid profile and hashes its bytes", () => {
  const file = writeTmp(
    "profile.json",
    JSON.stringify({
      ...DEFAULT_PROFILE,
      python: { roots: ["sim/src"], singleFileModules: [] },
    }),
  );
  expect(loadProfile(file).python.roots).toEqual(["sim/src"]);
  expect(profileHash(readFileSync(file))).toBe(
    createHash("sha256").update(readFileSync(file)).digest("hex"),
  );
  // the whole profile, and the digest of known bytes
  expect(loadProfile(file)).toStrictEqual({
    ...DEFAULT_PROFILE,
    python: { roots: ["sim/src"], singleFileModules: [] },
  });
  expect(profileHash(new TextEncoder().encode("abc"))).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

it.each<[object, string]>([
  [
    { python: { roots: "sim/src" } },
    "profile.python.roots: expected an array of strings",
  ],
  [{ comets: true }, "profile.comets: unknown field"],
  [
    {
      launchManifests: [
        { glob: "plugins/*/plugin.json", pointer: "entry", kind: "plugin" },
      ],
    },
    "profile.launchManifests[0].pointer: must start with /",
  ],
])("names the bad field in %j", (patch, message) => {
  expect(() =>
    loadProfile(
      writeTmp("p.json", JSON.stringify({ ...DEFAULT_PROFILE, ...patch })),
    ),
  ).toThrow(message);
  // a ProfileError, whose field is the message's part before ": "
  const error = refusal(() =>
    loadProfile(
      writeTmp("p.json", JSON.stringify({ ...DEFAULT_PROFILE, ...patch })),
    ),
  );
  expect(error.message).toBe(message);
  expect(error.field).toBe(message.slice(0, message.indexOf(": ")));
});

it("rejects a forbidden rule whose path does not compile", () => {
  const rules = {
    schema: 1,
    forbidden: [
      { name: "x", severity: "error", from: { path: "(" }, to: { path: "a" } },
    ],
  };
  expect(() => loadRules(writeTmp("r.json", JSON.stringify(rules)))).toThrow(
    "rules.forbidden[0].from.path: invalid regular expression",
  );
  const error = refusal(() =>
    loadRules(writeTmp("r.json", JSON.stringify(rules))),
  );
  expect(error.name).toBe("ProfileError");
  expect(error.field).toBe("rules.forbidden[0].from.path");
});

it("starts from no entries, the gate at 0.005 and no rules, and cannot be changed", () => {
  expect(DEFAULT_PROFILE).toStrictEqual({
    schema: 1,
    components: [],
    typescript: { aliases: {}, tsconfigs: [] },
    python: { roots: [], singleFileModules: [] },
    tests: { extraPatterns: [] },
    launchManifests: [],
    denylist: { extra: [] },
    gates: { maxUnresolvedRelativeImports: 0.005 },
    rules: null,
  });
  expect(
    loadProfile(writeTmp("p.json", JSON.stringify(DEFAULT_PROFILE))),
  ).toStrictEqual(DEFAULT_PROFILE);
  expect(() => DEFAULT_PROFILE.python.roots.push("sim/src")).toThrow(TypeError);
  expect(() => {
    DEFAULT_PROFILE.typescript.aliases["@obs/web/*"] = ["web/src/*"];
  }).toThrow(TypeError);
  expect(() => {
    DEFAULT_PROFILE.gates.maxUnresolvedRelativeImports = 1;
  }).toThrow(TypeError);
  expect(DEFAULT_PROFILE.python.roots).toEqual([]);
});

it("loads every field of a profile as written", () => {
  const full: Profile = {
    schema: 1,
    components: ["web/src/*", "sim/src/observatory"],
    typescript: {
      aliases: {
        "@obs/web/*": ["web/src/*"],
        "@obs/core": ["lib/core/src/index.ts"],
      },
      tsconfigs: ["web/tsconfig.json"],
    },
    python: { roots: [".", "sim/src"], singleFileModules: ["tools/skyctl.py"] },
    tests: { extraPatterns: ["web/src/qa/**"] },
    launchManifests: [
      {
        glob: "plugins/*/package.json",
        pointer: "/host/extensions",
        kind: "plugin",
      },
      { glob: "plugins/*/plugin.json", pointer: "/a~1b/~0c", kind: "plugin" },
    ],
    denylist: { extra: ["sim/data/*.csv"] },
    gates: { maxUnresolvedRelativeImports: 0 },
    rules: "../rules/observatory.json",
  };
  expect(
    loadProfile(writeTmp("p.json", JSON.stringify(full, null, 2))),
  ).toStrictEqual(full);
});

it.each<[string, unknown, string]>([
  ["value is an array", [], "profile: expected an object"],
  ["schema is 2", { ...D, schema: 2 }, "profile.schema: must be 1"],
  [
    "denylist is missing",
    without(D, "denylist"),
    "profile.denylist: missing field",
  ],
  [
    "key holds a space",
    { ...D, "sky map": {} },
    'profile["sky map"]: unknown field',
  ],
  [
    "python is null",
    { ...D, python: null },
    "profile.python: expected an object",
  ],
  [
    "component is a number",
    { ...D, components: ["web/src/*", 7] },
    "profile.components[1]: expected a string",
  ],
  [
    "component starts with /",
    { ...D, components: ["/web/src/*"] },
    `profile.components[0]: ${REL}`,
  ],
  [
    "test pattern ends with /",
    { ...D, tests: { extraPatterns: ["web/src/qa/"] } },
    `profile.tests.extraPatterns[0]: ${REL}`,
  ],
  [
    "denylist glob climbs out with ..",
    { ...D, denylist: { extra: ["../sky/*"] } },
    `profile.denylist.extra[0]: ${REL}`,
  ],
  [
    "aliases is an array",
    { ...D, typescript: { ...D.typescript, aliases: [] } },
    "profile.typescript.aliases: expected an object",
  ],
  [
    "alias maps to a string",
    {
      ...D,
      typescript: { ...D.typescript, aliases: { "@obs/web/*": "web/src/*" } },
    },
    'profile.typescript.aliases["@obs/web/*"]: expected an array of strings',
  ],
  [
    "alias target has an empty segment",
    {
      ...D,
      typescript: {
        ...D.typescript,
        aliases: { "@obs/web/*": ["web//src/*"] },
      },
    },
    `profile.typescript.aliases["@obs/web/*"][0]: ${REL}`,
  ],
  [
    "typescript has paths",
    { ...D, typescript: { ...D.typescript, paths: {} } },
    "profile.typescript.paths: unknown field",
  ],
  [
    "tsconfig is absolute",
    {
      ...D,
      typescript: { ...D.typescript, tsconfigs: ["/web/tsconfig.json"] },
    },
    `profile.typescript.tsconfigs[0]: ${REL}`,
  ],
  [
    "Python root starts with ./",
    { ...D, python: { roots: ["./sim/src"], singleFileModules: [] } },
    `profile.python.roots[0]: ${ROOT}`,
  ],
  [
    "single-file module has a . segment",
    { ...D, python: { roots: [], singleFileModules: ["tools/./skyctl.py"] } },
    `profile.python.singleFileModules[0]: ${REL}`,
  ],
  [
    "launchManifests is an object",
    { ...D, launchManifests: {} },
    "profile.launchManifests: expected an array",
  ],
  [
    "launch manifest has no glob",
    { ...D, launchManifests: [{ pointer: "/entry", kind: "plugin" }] },
    "profile.launchManifests[0].glob: missing field",
  ],
  [
    "launch manifest is a bin",
    {
      ...D,
      launchManifests: [
        { glob: "plugins/*/plugin.json", pointer: "/entry", kind: "bin" },
      ],
    },
    'profile.launchManifests[0].kind: must be "plugin"',
  ],
  [
    "pointer holds ~2",
    {
      ...D,
      launchManifests: [
        { glob: "plugins/*/plugin.json", pointer: "/a~2b", kind: "plugin" },
      ],
    },
    'profile.launchManifests[0].pointer: has a "~" that is not "~0" or "~1"',
  ],
  [
    "gate is 2",
    { ...D, gates: { maxUnresolvedRelativeImports: 2 } },
    "profile.gates.maxUnresolvedRelativeImports: expected a number from 0 to 1",
  ],
  [
    "gate is a string",
    { ...D, gates: { maxUnresolvedRelativeImports: "0.005" } },
    "profile.gates.maxUnresolvedRelativeImports: expected a number from 0 to 1",
  ],
  [
    "rules is 7",
    { ...D, rules: 7 },
    "profile.rules: expected a non-empty string or null",
  ],
  [
    "rules is empty",
    { ...D, rules: "" },
    "profile.rules: expected a non-empty string or null",
  ],
])("refuses a profile whose %s", (_, value, message) => {
  const error = refusal(() =>
    loadProfile(writeTmp("p.json", JSON.stringify(value))),
  );
  expect(error.message).toBe(message);
  expect(error.field).toBe(message.slice(0, message.indexOf(": ")));
});

const rule = {
  name: "sky-not-from-api",
  severity: "error",
  from: { path: "^web/src/sky/" },
  to: { path: "^web/src/api/" },
};

it("loads rules, keeping only the optional keys they hold", () => {
  const rules: Rules = {
    schema: 1,
    cycles: { severity: "warn" },
    forbidden: [
      {
        name: "sky-not-from-api",
        severity: "error",
        from: { path: "^web/src/sky/" },
        to: { path: "^web/src/api/" },
      },
      {
        name: "web-apart-from-sim",
        severity: "info",
        comment: "web reads the sky through the API",
        from: { path: "^web/" },
        to: { path: "^sim/" },
      },
    ],
    layers: [
      {
        name: "sim-layers",
        severity: "warn",
        containers: ["observatory"],
        layers: ["tools", "ephemeris", "orbits"],
      },
      {
        name: "tools-on-top",
        severity: "error",
        layers: ["observatory.tools"],
      },
    ],
  };
  expect(
    loadRules(writeTmp("rules.json", JSON.stringify(rules))),
  ).toStrictEqual(rules);
  expect(loadRules(writeTmp("rules.json", '{ "schema": 1 }'))).toStrictEqual({
    schema: 1,
  });
});

it.each<[string, unknown, string]>([
  ["value is null", null, "rules: expected an object"],
  ["schema is missing", { forbidden: [] }, "rules.schema: missing field"],
  ["schema is 2", { schema: 2 }, "rules.schema: must be 1"],
  [
    "key is unknown",
    { schema: 1, required: [] },
    "rules.required: unknown field",
  ],
  [
    "cycle severity is fatal",
    { schema: 1, cycles: { severity: "fatal" } },
    `rules.cycles.severity: ${SEVERITY}`,
  ],
  [
    "forbidden is an object",
    { schema: 1, forbidden: {} },
    "rules.forbidden: expected an array",
  ],
  [
    "forbidden rule has no name",
    { schema: 1, forbidden: [without(rule, "name")] },
    "rules.forbidden[0].name: missing field",
  ],
  [
    "forbidden rule has a via",
    { schema: 1, forbidden: [{ ...rule, via: { path: "^lib/" } }] },
    "rules.forbidden[0].via: unknown field",
  ],
  [
    "forbidden comment is a number",
    { schema: 1, forbidden: [{ ...rule, comment: 1 }] },
    "rules.forbidden[0].comment: expected a string",
  ],
  [
    "forbidden from has a pathNot",
    {
      schema: 1,
      forbidden: [{ ...rule, from: { path: "^web/", pathNot: "x" } }],
    },
    "rules.forbidden[0].from.pathNot: unknown field",
  ],
  [
    "forbidden from path is a number",
    { schema: 1, forbidden: [{ ...rule, from: { path: 1 } }] },
    "rules.forbidden[0].from.path: expected a string",
  ],
  [
    "second forbidden to path does not compile",
    { schema: 1, forbidden: [rule, { ...rule, to: { path: "[" } }] },
    "rules.forbidden[1].to.path: invalid regular expression",
  ],
  [
    "layer has no layers",
    { schema: 1, layers: [{ name: "sim", severity: "warn" }] },
    "rules.layers[0].layers: missing field",
  ],
  [
    "layer container is a number",
    {
      schema: 1,
      layers: [{ name: "sim", severity: "warn", containers: [1], layers: [] }],
    },
    "rules.layers[0].containers[0]: expected a string",
  ],
  [
    "layer severity is loud",
    { schema: 1, layers: [{ name: "sim", severity: "loud", layers: [] }] },
    `rules.layers[0].severity: ${SEVERITY}`,
  ],
])("refuses rules whose %s", (_, value, message) => {
  const error = refusal(() =>
    loadRules(writeTmp("r.json", JSON.stringify(value))),
  );
  expect(error.message).toBe(message);
  expect(error.field).toBe(message.slice(0, message.indexOf(": ")));
});

it("refuses a profile that is not UTF-8 text or not JSON, and reads one with a byte order mark", () => {
  const text = JSON.stringify(DEFAULT_PROFILE);
  const latin1 = Buffer.concat([
    Buffer.from(text.slice(0, 20)),
    Buffer.from([0xff]),
    Buffer.from(text.slice(20)),
  ]);
  expect(refusal(() => loadProfile(writeTmp("p.json", latin1))).message).toBe(
    "profile: not UTF-8 text",
  );
  // a profile is JSON, never JSONC
  const notJson = refusal(() =>
    loadProfile(writeTmp("p.json", "{ // a comment\n}")),
  );
  expect(notJson.field).toBe("profile");
  expect(notJson.message.startsWith("profile: not JSON (")).toBe(true);
  expect(loadProfile(writeTmp("p.json", `\uFEFF${text}`))).toStrictEqual(
    DEFAULT_PROFILE,
  );
});

// A read of a FIFO blocks until a writer opens it.
it.skipIf(process.platform === "win32")(
  "refuses a profile or rules file that is not a regular file, without reading it",
  () => {
    const dir = tmp();
    const fifo = join(dir, "profile.json");
    execFileSync("mkfifo", [fifo]);
    expect(refusal(() => loadProfile(fifo)).message).toBe(
      "profile: not a regular file",
    );
    expect(refusal(() => loadRules(fifo)).message).toBe(
      "rules: not a regular file",
    );
    expect(refusal(() => loadProfile(dir)).message).toBe(
      "profile: not a regular file",
    );
    expect(refusal(() => loadProfile(join(dir, "missing.json"))).message).toBe(
      "profile: cannot read the file (ENOENT)",
    );
  },
);
