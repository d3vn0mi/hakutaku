// The licence report. The shipped tree is the package's production dependencies, read from the
// lockfile, and every package the viewer bundles, read from esbuild's record of the last build;
// each one must be under a licence on the allowlist. The report lists every shipped package.
import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import YAML from "yaml";
import {
  ALLOWED_LICENCES,
  bundledLocations,
  licenceAllowed,
  licenceProblems,
  normaliseLicence,
  type PackageLock,
  shippedPackages,
} from "../../scripts/release/licences.mjs";

// What the viewer's build bundled, as esbuild's metafile names its inputs; npm run build writes it.
const META = ".cache/viewer-meta.json";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readMeta(): { inputs: Record<string, unknown> } {
  if (!existsSync(META)) throw new Error(`no ${META}: run npm run build first`);
  return readJson(META);
}

it("licenceAllowed follows the licence allowlist", () => {
  expect([...ALLOWED_LICENCES].sort()).toEqual([
    "0BSD",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "BlueOak-1.0.0",
    "CC0-1.0",
    "ISC",
    "MIT",
    "OFL-1.1",
    "Python-2.0",
    "Unlicense",
  ]);
  for (const id of [
    "MIT",
    "ISC",
    "0BSD",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "Apache-2.0",
    "OFL-1.1",
    "Unlicense",
    "CC0-1.0",
    "Python-2.0",
    "BlueOak-1.0.0",
    "(MIT OR CC0-1.0)",
    "MIT AND ISC",
    "MIT OR GPL-3.0-only",
  ]) {
    expect(licenceAllowed(id), id).toBe(true);
  }
  for (const id of [
    "MIT AND GPL-3.0-only",
    "MPL-2.0",
    "PSF-2.0",
    "CC-BY-4.0",
    "Apache-2.0+",
    "GPL-2.0-only WITH Classpath-exception-2.0",
    "UNLICENSED",
    "SEE LICENSE IN LICENSE",
    "",
  ]) {
    expect(licenceAllowed(id), id).toBe(false);
  }
});

it("licenceAllowed binds AND tighter than OR, and refuses an exception and anything malformed", () => {
  // these read MIT OR (GPL-3.0-only AND GPL-3.0-only) and (GPL-3.0-only AND MPL-2.0) OR ISC
  expect(licenceAllowed("MIT OR GPL-3.0-only AND GPL-3.0-only")).toBe(true);
  expect(licenceAllowed("GPL-3.0-only AND MPL-2.0 OR ISC")).toBe(true);
  expect(licenceAllowed("((MIT))")).toBe(true);
  for (const id of [
    "(MIT OR ISC) AND GPL-3.0-only",
    // an exception on an allowed id is still an exception
    "Apache-2.0 WITH LLVM-exception",
    "MIT OR",
    "AND MIT",
    "MIT ISC",
    "(MIT",
    "MIT)",
    "()",
    "MIT WITH",
    // the operators are upper case
    "MIT or ISC",
  ]) {
    expect(licenceAllowed(id), id).toBe(false);
  }
});

it("normaliseLicence reads the legacy forms", () => {
  expect(normaliseLicence({ license: "MIT" })).toBe("MIT");
  expect(normaliseLicence({ license: { type: "ISC" } })).toBe("ISC");
  expect(
    normaliseLicence({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] }),
  ).toBe("(MIT OR Apache-2.0)");
  expect(normaliseLicence({})).toBeNull();
  expect(normaliseLicence({ licenses: [{ type: "BSD-2-Clause" }] })).toBe(
    "BSD-2-Clause",
  );
  expect(normaliseLicence(null)).toBeNull();
  expect(normaliseLicence({ license: "" })).toBeNull();
  expect(normaliseLicence({ license: 1 })).toBeNull();
  expect(normaliseLicence({ licenses: [] })).toBeNull();
  expect(
    normaliseLicence({ licenses: [{ type: "MIT" }, { url: "LICENSE" }] }),
  ).toBeNull();
});

it("bundledLocations reads esbuild's inputs and adds the font packages", () => {
  expect(
    bundledLocations(
      {
        inputs: {
          "node_modules/sigma/dist/sigma.js": {},
          "node_modules/@scope/lib/index.js": {},
          "node_modules/a/node_modules/b/x.js": {},
          "src/viewer/app/main.ts": {},
        },
      },
      { "@ibm/plex-mono": "1.1.0", vitest: "3.2.4" },
    ),
  ).toEqual([
    "node_modules/@ibm/plex-mono",
    "node_modules/@scope/lib",
    "node_modules/a/node_modules/b",
    "node_modules/sigma",
  ]);
});

it("bundledLocations takes node_modules only as a whole segment, and each package once", () => {
  expect(
    bundledLocations(
      {
        inputs: {
          "node_modules/sigma/dist/sigma.js": {},
          "node_modules/sigma/package.json": {},
          "src/not_node_modules/x/y.js": {},
        },
      },
      {},
    ),
  ).toEqual(["node_modules/sigma"]);
});

it("shippedPackages takes production entries and bundled locations, never dev-only ones", () => {
  const lock = {
    lockfileVersion: 3,
    packages: {
      "": { name: "hakutaku", version: "0.0.0" },
      "node_modules/x": { version: "1.0.0", license: "GPL-3.0-only" },
      "node_modules/d": { version: "2.0.0", license: "MPL-2.0", dev: true },
      "node_modules/v": { version: "3.0.0", license: "MPL-2.0", dev: true },
      "node_modules/u": { version: "4.0.0" },
    },
  };
  expect(
    licenceProblems(shippedPackages(lock, ["node_modules/v"], () => null)),
  ).toEqual([
    "u@4.0.0 (node_modules/u, dependency): UNKNOWN",
    "v@3.0.0 (node_modules/v, bundled): MPL-2.0",
    "x@1.0.0 (node_modules/x, dependency): GPL-3.0-only",
  ]);
});

it("shippedPackages names each package, reads a licence the lock lacks from its manifest, and lists a bundled dependency once", () => {
  const lock: PackageLock = {
    lockfileVersion: 3,
    packages: {
      "": { name: "hakutaku", version: "0.0.0" },
      "node_modules/alias": { name: "real", version: "1.0.0", license: "MIT" },
      "node_modules/b/node_modules/@s/c": { version: "2.0.0" },
      "node_modules/both": { version: "3.0.0", license: "ISC" },
    },
  };
  const read: string[] = [];
  const shipped = shippedPackages(lock, ["node_modules/both"], (location) => {
    read.push(location);
    return { license: { type: "BSD-2-Clause" } };
  });
  expect(shipped).toEqual([
    {
      name: "real",
      version: "1.0.0",
      licence: "MIT",
      location: "node_modules/alias",
      via: "dependency",
    },
    {
      name: "@s/c",
      version: "2.0.0",
      licence: "BSD-2-Clause",
      location: "node_modules/b/node_modules/@s/c",
      via: "dependency",
    },
    {
      name: "both",
      version: "3.0.0",
      licence: "ISC",
      location: "node_modules/both",
      via: "bundled",
    },
  ]);
  // a manifest is read only where the lock names no licence
  expect(read).toEqual(["node_modules/b/node_modules/@s/c"]);
  expect(() => shippedPackages(lock, ["node_modules/gone"])).toThrow(
    "node_modules/gone is bundled, but package-lock.json has no entry for it",
  );
});

it("the shipped tree uses only allowlisted licences", () => {
  const lock = readJson<PackageLock>("package-lock.json");
  const { devDependencies } = readJson<{
    devDependencies: Record<string, string>;
  }>("package.json");
  // a licence the lock does not name is read from <location>/package.json
  const shipped = shippedPackages(
    lock,
    bundledLocations(readMeta(), devDependencies),
  );
  const report = [
    `licence report: ${shipped.length} packages`,
    ...shipped.map(
      (p) => `${p.name}@${p.version}  ${p.licence ?? "UNKNOWN"}  ${p.via}`,
    ),
  ].join("\n");
  console.log(report);
  expect(
    shipped.some(
      (p) => p.name === "@modelcontextprotocol/sdk" && p.via === "dependency",
    ),
  ).toBe(true);
  expect(shipped.some((p) => p.via === "bundled")).toBe(true);
  // the bundled packages are those the viewer's manifest lists, from the same build: so the
  // metafile holds the bundle's inputs, not only the fonts
  const { bundled } = readJson<{
    bundled: Array<{ name: string; version: string }>;
  }>("dist/viewer/manifest.json");
  expect(
    shipped
      .filter((p) => p.via === "bundled")
      .map((p) => `${p.name}@${p.version}`)
      .sort(),
  ).toEqual(bundled.map((b) => `${b.name}@${b.version}`).sort());
  expect(licenceProblems(shipped)).toEqual([]);
});

it("CI's linux job runs the licence report after the pack allowlist, as ci:local does", () => {
  const ci = YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
    jobs: Record<string, { steps: Array<{ name?: string }> }>;
  };
  const steps = (ci.jobs.linux?.steps ?? []).filter(
    (s) => s.name !== undefined,
  );
  const at = steps.findIndex((s) => s.name === "licence report");
  expect(steps[at]).toEqual({
    name: "licence report",
    run: "npm run check:licences",
  });
  expect(steps.slice(at - 1, at + 2).map((s) => s.name)).toEqual([
    "pack allowlist",
    "licence report",
    "secret scan",
  ]);
  const { scripts } = readJson<{ scripts: Record<string, string> }>(
    "package.json",
  );
  expect(scripts["check:licences"]).toBe(
    "vitest run test/release/licences.test.ts",
  );
  expect(scripts["ci:local"]).toContain(
    "npm run check:pack && npm run check:licences && npm run check:secrets",
  );
});
