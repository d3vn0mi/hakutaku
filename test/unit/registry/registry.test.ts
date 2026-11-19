import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  exportDirFor,
  findEntry,
  hakutakuDirs,
  loadRegistry,
  profilePathFor,
  type RegistryEntry,
  saveEntry,
  storePathFor,
} from "../../../src/registry/index.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Each test points the XDG variables at a fresh root under the OS temp directory, in which
// nothing exists yet; afterEach restores them.
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "hakutaku-registry-"));
  made.push(root);
  vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const entry = (id: string): RegistryEntry => ({
  id,
  source: `/checkouts/${id}`,
  ref: "main",
  detail: "standard",
  noSource: false,
  snippets: true,
  profile: `/profiles/${id}.json`,
});

const registryFile = (): string => join(hakutakuDirs().data, "registry.json");

it("keeps entries sorted by id and replaces an entry with the same id", () => {
  saveEntry(entry("vega"));
  saveEntry(entry("observatory"));
  saveEntry({ ...entry("vega"), detail: "quick" });
  expect(loadRegistry().repos.map((e) => [e.id, e.detail])).toEqual([
    ["observatory", "standard"],
    ["vega", "quick"],
  ]);
  expect(
    readdirSync(hakutakuDirs().data).filter((f) => f.includes(".tmp")),
  ).toEqual([]);
});

it("finds an entry and builds its paths", () => {
  saveEntry(entry("observatory"));
  expect(findEntry("observatory")?.id).toBe("observatory");
  expect(findEntry("vega")).toBeNull();
  expect(storePathFor("observatory")).toBe(
    join(hakutakuDirs().data, "stores/observatory/store.sqlite"),
  );
  expect(exportDirFor("observatory", "a".repeat(40))).toBe(
    `${join(hakutakuDirs().cache, "exports/observatory", "a".repeat(40))}/`,
  );
  expect(profilePathFor("observatory")).toBe(
    join(hakutakuDirs().config, "profiles/observatory.json"),
  );
});

it("answers an empty registry, and makes no directory, when registry.json does not exist", () => {
  expect(loadRegistry()).toStrictEqual({ version: 1, repos: [] });
  expect(findEntry("observatory")).toBeNull();
  expect(existsSync(hakutakuDirs().data)).toBe(false);
});

it("writes each entry with exactly its type's keys, in their order, whatever order they came in", () => {
  const e = entry("observatory");
  saveEntry({
    profile: e.profile,
    snippets: e.snippets,
    noSource: e.noSource,
    detail: e.detail,
    ref: e.ref,
    source: e.source,
    id: e.id,
    extra: 1,
  } as RegistryEntry);
  expect(readFileSync(registryFile(), "utf8")).toBe(
    `${JSON.stringify({ version: 1, repos: [e] }, null, 2)}\n`,
  );
  expect(loadRegistry().repos).toStrictEqual([e]);
});

it("sorts the entries of a registry.json written by hand, and drops keys its type does not declare", () => {
  mkdirSync(hakutakuDirs().data, { recursive: true });
  writeFileSync(
    registryFile(),
    JSON.stringify({
      version: 1,
      repos: [{ ...entry("vega"), later: true }, entry("observatory")],
    }),
  );
  expect(loadRegistry()).toStrictEqual({
    version: 1,
    repos: [entry("observatory"), entry("vega")],
  });
});

it.each([
  ["not JSON", "{"],
  ["an array", "[]"],
  ["a newer version", JSON.stringify({ version: 2, repos: [] })],
  ["no repos", JSON.stringify({ version: 1 })],
  [
    "an id that is not a repo id",
    JSON.stringify({ version: 1, repos: [{ ...entry("vega"), id: "Vega" }] }),
  ],
  [
    "a relative source",
    JSON.stringify({
      version: 1,
      repos: [{ ...entry("vega"), source: "vega" }],
    }),
  ],
  [
    "an entry without snippets",
    JSON.stringify({
      version: 1,
      repos: [{ ...entry("vega"), snippets: undefined }],
    }),
  ],
  [
    "an id listed twice",
    JSON.stringify({ version: 1, repos: [entry("vega"), entry("vega")] }),
  ],
])(
  "refuses a registry.json holding %s, and writes nothing over it",
  (_, text) => {
    mkdirSync(hakutakuDirs().data, { recursive: true });
    writeFileSync(registryFile(), text);
    const refusal = `${registryFile()}: not an hakutaku registry`;
    expect(() => loadRegistry()).toThrow(refusal);
    expect(() => findEntry("vega")).toThrow(refusal);
    expect(() => saveEntry(entry("observatory"))).toThrow(refusal);
    expect(readFileSync(registryFile(), "utf8")).toBe(text);
  },
);

it("refuses a registry.json that is not a regular file, without reading it", () => {
  mkdirSync(hakutakuDirs().data, { recursive: true });
  execFileSync("mkfifo", [registryFile()]);
  expect(() => loadRegistry()).toThrow(
    `${registryFile()}: not an hakutaku registry (not a regular file)`,
  );
});

it.each<[string, Partial<RegistryEntry>]>([
  ["an upper-case id", { id: "Vega" }],
  ["an id with a slash", { id: "../vega" }],
  ["a relative source", { source: "checkouts/vega" }],
  ["an empty ref", { ref: "" }],
  ["an unknown detail", { detail: "max" as RegistryEntry["detail"] }],
  ["a relative profile", { profile: "vega.json" }],
])(
  "refuses to save an entry with %s, which loadRegistry would refuse",
  (_, change) => {
    expect(() => saveEntry({ ...entry("vega"), ...change })).toThrow(TypeError);
    expect(existsSync(registryFile())).toBe(false);
  },
);

it("refuses an id or a commit that is not one, so no path leaves its directory", () => {
  for (const id of ["../vega", "Vega", "", "vega/x"]) {
    expect(() => storePathFor(id)).toThrow(RangeError);
    expect(() => profilePathFor(id)).toThrow(RangeError);
    expect(() => exportDirFor(id, "a".repeat(40))).toThrow(RangeError);
  }
  for (const commit of ["../x", "A".repeat(40), "a".repeat(39), ""]) {
    expect(() => exportDirFor("vega", commit)).toThrow(RangeError);
  }
});
