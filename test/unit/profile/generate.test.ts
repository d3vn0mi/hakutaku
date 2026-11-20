import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import * as build from "../../../src/build.js";
import {
  DEFAULT_PROFILE,
  generateProfile,
  loadProfile,
} from "../../../src/profile/index.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A fresh directory under the OS temp directory, removed after the file's last test.
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-generate-"));
  made.push(dir);
  return dir;
};

// Writes the files into a fresh temp directory and returns it, as export writes a snapshot.
const snapshot = (files: Record<string, string>): string => {
  const dir = tmp();
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
};

const writeTmp = (name: string, data: string): string => {
  const path = join(tmp(), name);
  writeFileSync(path, data);
  return path;
};

const json = (value: unknown): string => JSON.stringify(value);

it("collects aliases from tsconfig paths and package exports", async () => {
  const dir = snapshot({
    "web/tsconfig.json":
      '{ "compilerOptions": { "baseUrl": ".", "paths": { "@obs/web/*": ["src/*"] } } }',
    "lib/core/package.json":
      '{ "name": "@obs/core", "exports": { ".": { "import": "./dist/index.js" } } }',
    "lib/core/src/index.ts": "",
  });
  const g = await generateProfile(dir);
  expect(g.profile.typescript.aliases).toEqual({
    "@obs/core": ["lib/core/src/index.ts"],
    "@obs/web/*": ["web/src/*"],
  });
  expect(g.conflicts).toEqual([]);
  expect(g.found.aliases).toBe(2);
});

it("stops on two packages exporting one name", async () => {
  const g = await generateProfile(
    snapshot({
      "a/package.json": '{ "name": "@obs/core", "main": "src/index.ts" }',
      "a/src/index.ts": "",
      "b/package.json": '{ "name": "@obs/core", "main": "src/index.ts" }',
      "b/src/index.ts": "",
    }),
  );
  expect(g.conflicts).toEqual([
    'two packages export "@obs/core": a/src/index.ts and b/src/index.ts; name one in the profile',
    'two packages export "@obs/core/*": a/src/* and b/src/*; name one in the profile',
  ]);
});

it("finds Python roots by walking up from __init__.py", async () => {
  const g = await generateProfile(
    snapshot({
      "sim/src/observatory/__init__.py": "",
      "sim/src/observatory/ephemeris/__init__.py": "",
      "pkg/__init__.py": "",
    }),
  );
  expect(g.profile.python.roots).toEqual([".", "sim/src"]);
  expect(g.found.pythonRoots).toEqual([".", "sim/src"]);
});

it("lists single-file modules and warns on an extends into node_modules", async () => {
  const g = await generateProfile(
    snapshot({
      "tools/pyproject.toml": '[tool.setuptools]\npy-modules = ["skyctl"]',
      "tools/skyctl.py": "",
      "web/tsconfig.json": '{ "extends": "@obs/tsconfig/base.json" }',
    }),
  );
  expect(g.profile.python.singleFileModules).toEqual(["tools/skyctl.py"]);
  expect(g.warnings).toEqual([
    "web/tsconfig.json: extends @obs/tsconfig/base.json was not resolved",
  ]);
});

it("writes a profile that loadProfile accepts", async () => {
  const g = await generateProfile(snapshot({ "web/src/a.ts": "" }));
  expect(loadProfile(writeTmp("p.json", JSON.stringify(g.profile)))).toEqual(
    g.profile,
  );
  // and one that fills every field the generator writes, through odd names
  const odd = await generateProfile(
    snapshot({
      "sky map/package.json": json({
        name: "@obs/sky-map",
        main: "dist/index.js",
      }),
      "sky map/src/index.ts": "",
      "web #2/tsconfig.json": json({
        compilerOptions: { paths: { "~/*": ["./src/*", "../../outside/*"] } },
      }),
      "étoile/__init__.py": "",
      "tools %/pyproject.toml": '[tool.setuptools]\npy-modules = ["skyctl"]',
      "tools %/src/skyctl.py": "",
    }),
  );
  expect(odd.profile).toEqual({
    ...DEFAULT_PROFILE,
    typescript: {
      aliases: {
        "@obs/sky-map": ["sky map/src/index.ts"],
        "@obs/sky-map/*": ["sky map/src/*"],
        "~/*": ["web #2/src/*"],
      },
      tsconfigs: ["web #2/tsconfig.json"],
    },
    python: { roots: ["."], singleFileModules: ["tools %/src/skyctl.py"] },
  });
  expect(loadProfile(writeTmp("p.json", JSON.stringify(odd.profile)))).toEqual(
    odd.profile,
  );
});

it('writes paths at the repo top without "./", which loadProfile accepts', async () => {
  const g = await generateProfile(
    snapshot({
      "package.json": json({ name: "sky", main: "./dist/index.js" }),
      "src/index.ts": "",
      "tsconfig.json": json({
        compilerOptions: {
          baseUrl: ".",
          paths: { "#/*": ["./src/*"], "*": ["./types/*"] },
        },
      }),
      "pyproject.toml": '[tool.setuptools]\npy-modules = ["skyctl"]',
      "skyctl.py": "",
      "orbit/__init__.py": "",
    }),
  );
  expect(g.profile.typescript).toEqual({
    aliases: {
      "#/*": ["src/*"],
      "*": ["types/*"],
      sky: ["src/index.ts"],
      "sky/*": ["src/*"],
    },
    tsconfigs: ["tsconfig.json"],
  });
  expect(g.profile.python).toEqual({
    roots: ["."],
    singleFileModules: ["skyctl.py"],
  });
  expect(loadProfile(writeTmp("p.json", JSON.stringify(g.profile)))).toEqual(
    g.profile,
  );
});

it("lists every tsconfig*.json outside node_modules, sorted, whether or not it reads", async () => {
  const g = await generateProfile(
    snapshot({
      "web/tsconfig.json": "{ not json",
      "tsconfig.json": "{}",
      "web/tsconfig.build.json": "{}",
      "lib/core/tsconfig-esm.json": "{}",
      "web/jsconfig.json": "{}",
      "web/tsconfig.json.bak": "{}",
      "web/base-tsconfig.json": "{}",
      "node_modules/@obs/tsconfig/tsconfig.json": "{}",
      "web/node_modules/kepler/tsconfig.json": "{}",
    }),
  );
  expect(g.profile.typescript.tsconfigs).toEqual([
    "lib/core/tsconfig-esm.json",
    "tsconfig.json",
    "web/tsconfig.build.json",
    "web/tsconfig.json",
  ]);
  expect(g.warnings).toEqual([]);
});

it("resolves paths against baseUrl, else the tsconfig's directory, keeping each key's targets in order once", async () => {
  const g = await generateProfile(
    snapshot({
      "tsconfig.json": json({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@obs/*": ["web/src/*", "./lib/*"] },
        },
      }),
      "web/tsconfig.json": json({
        compilerOptions: { baseUrl: "src", paths: { "~/*": ["./*"] } },
      }),
      "lib/tsconfig.json":
        '{\n  // JSONC\n  "compilerOptions": { "paths": { "@lib/core": ["./core/src/index.ts", "core/src/index.ts"], }, },\n}',
    }),
  );
  expect(g.profile.typescript.aliases).toEqual({
    "@lib/core": ["lib/core/src/index.ts"],
    "@obs/*": ["web/src/*", "lib/*"],
    "~/*": ["web/src/*"],
  });
});

it('leaves out a target outside the repo or with two "*", and a key left with none', async () => {
  const g = await generateProfile(
    snapshot({
      "web/tsconfig.json": json({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@obs/up/*": ["../../*"], // leaves the repo
            "@obs/abs/*": ["/srv/sky/*"], // absolute
            "@obs/dir": ["src/"], // a directory
            "@obs/top": [".."], // the repo top
            "@obs/two/*": ["src/*/*"], // TypeScript allows one "*"
            "@obs/*/*": ["src/*"],
            "@obs/mixed/*": ["../../*", "src/mixed/*"],
            "@obs/bad": "src/bad.ts", // not an array
            "@obs/num": [7, "src/num.ts"],
          },
        },
      }),
      "lib/tsconfig.json": json({
        compilerOptions: { baseUrl: "/srv", paths: { "@lib/*": ["*"] } },
      }),
      "api/tsconfig.json": json({
        compilerOptions: {
          baseUrl: "../..",
          paths: { "@api/*": ["api/src/*"] },
        },
      }),
    }),
  );
  expect(g.profile.typescript.aliases).toEqual({
    "@obs/mixed/*": ["web/src/mixed/*"],
    "@obs/num": ["web/src/num.ts"],
  });
  expect(g.warnings).toEqual([]);
  expect(loadProfile(writeTmp("p.json", JSON.stringify(g.profile)))).toEqual(
    g.profile,
  );
});

it("takes the first string under types, import, node, default and require, depth first", async () => {
  const g = await generateProfile(
    snapshot({
      "lib/core/package.json": json({
        name: "@obs/core",
        exports: {
          ".": {
            browser: "./dist/browser.js",
            node: { require: "./dist/node.cjs", import: "./dist/node.mjs" },
            default: "./dist/index.js",
          },
          "./orbit": [
            { browser: "./dist/orbit.browser.js" },
            { types: "./dist/orbit.d.ts" },
            "./dist/orbit.js",
          ],
          "./star": { require: "./dist/star.cjs", default: "./dist/star.js" },
          "./comet": {
            types: { browser: "./dist/comet.browser.d.ts" },
            import: "./dist/comet.js",
          },
        },
      }),
      "lib/core/src/node.mts": "",
      "lib/core/src/node.cts": "",
      "lib/core/src/index.ts": "",
      "lib/core/src/browser.ts": "",
      "lib/core/src/orbit.ts": "",
      "lib/core/src/orbit.browser.ts": "",
      "lib/core/src/star.ts": "",
      "lib/core/src/star.cts": "",
      "lib/core/src/comet.ts": "",
      "lib/core/src/comet.browser.ts": "",
    }),
  );
  expect(g.profile.typescript.aliases).toEqual({
    "@obs/core": ["lib/core/src/node.mts"],
    "@obs/core/comet": ["lib/core/src/comet.ts"],
    "@obs/core/orbit": ["lib/core/src/orbit.ts"],
    "@obs/core/star": ["lib/core/src/star.ts"],
  });
});

it("maps subpath and pattern exports through sourceForBuilt, a tsconfig's outDir and rootDir included", async () => {
  const g = await generateProfile(
    snapshot({
      "lib/core/package.json": json({
        name: "@obs/core",
        exports: {
          "./*": "./dist/*.js",
          "./orbits/*": { types: "./types/orbits/*.d.ts" },
          "./sky": "./out/sky.js",
          "./package.json": "./package.json",
          "./data/*": "./data/*",
          "./empty/*": "./empty/*.json", // "*" matches no character of .json
          "./two/*": "./dist/*/*.js", // a target with two "*"
          "./a*/*": "./dist/*.js", // a key with two "*"
          ".hidden": "./dist/hidden.js", // neither "." nor "./x"
        },
      }),
      "lib/core/tsconfig.json": json({
        compilerOptions: { outDir: "out", rootDir: "source" },
      }),
      "lib/core/src/orbit.ts": "",
      "lib/core/src/hidden.ts": "",
      "lib/core/source/sky.ts": "",
      "lib/core/types/orbits/kepler.d.ts": "",
      "lib/core/data/stars.json": "",
      "lib/core/empty/.json": "",
    }),
  );
  expect(g.profile.typescript.aliases).toEqual({
    "@obs/core/*": ["lib/core/src/*"],
    "@obs/core/data/*": ["lib/core/data/*"],
    "@obs/core/orbits/*": ["lib/core/types/orbits/*"],
    "@obs/core/package.json": ["lib/core/package.json"],
    "@obs/core/sky": ["lib/core/source/sky.ts"],
  });
});

it("drops from a pattern export's target an extension TypeScript adds itself, so a tsconfig alias for it agrees", async () => {
  const g = await generateProfile(
    snapshot({
      "tsconfig.json": json({
        compilerOptions: { paths: { "@obs/core/*": ["lib/core/src/*"] } },
      }),
      "lib/core/package.json": json({
        name: "@obs/core",
        exports: {
          "./*": "./dist/*.js", // .ts
          "./ui/*": "./dist/ui/*.js", // .tsx
          "./legacy/*": "./legacy/*.js", // .js, tracked as given
          "./jsx/*": "./jsx/*.jsx",
          "./mjs/*": "./dist/mjs/*.mjs", // .mts stays
          "./widgets/*": "./dist/widgets/*/index.js", // more than an extension after "*"
        },
      }),
      "lib/core/src/orbit.ts": "",
      "lib/core/src/ui/dial.tsx": "",
      "lib/core/legacy/sky.js": "",
      "lib/core/jsx/chart.jsx": "",
      "lib/core/src/mjs/kepler.mts": "",
      "lib/core/src/widgets/dial/index.ts": "",
    }),
  );
  expect(g.conflicts).toEqual([]);
  expect(g.profile.typescript.aliases).toEqual({
    "@obs/core/*": ["lib/core/src/*"],
    "@obs/core/jsx/*": ["lib/core/jsx/*"],
    "@obs/core/legacy/*": ["lib/core/legacy/*"],
    "@obs/core/mjs/*": ["lib/core/src/mjs/*.mts"],
    "@obs/core/ui/*": ["lib/core/src/ui/*"],
    "@obs/core/widgets/*": ["lib/core/src/widgets/*/index.ts"],
  });
});

it("reads exports given as a string, an array or the conditions of ., and none that mix keys", async () => {
  const g = await generateProfile(
    snapshot({
      "a/package.json": json({ name: "@obs/a", exports: "./dist/index.js" }),
      "a/src/index.ts": "",
      "b/package.json": json({
        name: "@obs/b",
        exports: { import: "./dist/index.js", require: "./dist/index.cjs" },
      }),
      "b/src/index.ts": "",
      "c/package.json": json({
        name: "@obs/c",
        exports: { ".": "./dist/index.js", import: "./dist/index.js" },
      }),
      "c/src/index.ts": "",
      "d/package.json": json({ name: "@obs/d", exports: ["./dist/index.js"] }),
      "d/src/index.ts": "",
    }),
  );
  expect(g.profile.typescript.aliases).toEqual({
    "@obs/a": ["a/src/index.ts"],
    "@obs/b": ["b/src/index.ts"],
    "@obs/d": ["d/src/index.ts"],
  });
});

it("uses main, and <name>/* for a src/ directory, only without exports and with a name", async () => {
  const g = await generateProfile(
    snapshot({
      "a/package.json": json({ name: "@obs/a", main: "dist/index.js" }),
      "a/src/index.ts": "",
      "b/package.json": json({ name: "@obs/b" }),
      "b/src/orbit.ts": "",
      "c/package.json": json({ main: "src/index.ts" }),
      "c/src/index.ts": "",
      "d/package.json": json({ name: "@obs/d", main: "./lib/d.js" }),
      "d/lib/d.js": "",
      "e/package.json": json({
        name: "@obs/e",
        exports: { ".": "./src/index.ts" },
      }),
      "e/src/index.ts": "",
      "f/package.json": json({ name: "", main: "index.js" }),
      "f/index.js": "",
      "g/package.json": json({ name: "@obs/g", main: "dist/missing.js" }),
      "h/package.json": json({
        name: "@obs/h",
        exports: null,
        main: "index.js",
      }),
      "h/index.js": "",
    }),
  );
  expect(g.profile.typescript.aliases).toEqual({
    "@obs/a": ["a/src/index.ts"],
    "@obs/a/*": ["a/src/*"],
    "@obs/b/*": ["b/src/*"],
    "@obs/d": ["d/lib/d.js"],
    "@obs/e": ["e/src/index.ts"],
    "@obs/h": ["h/index.js"],
  });
});

it("leaves out an export Node refuses or no tracked file answers, and a package.json that does not read", async () => {
  const g = await generateProfile(
    snapshot({
      "a/package.json": json({
        name: "@obs/a",
        exports: {
          ".": "./dist/index.js",
          "./gone": "./dist/gone.js",
          "./blocked": null,
          "./browser": { browser: "./src/b.ts" },
          "./up": "../b/src/index.ts", // not "./"
          "./plain": "src/b.ts", // not "./"
          "./sneak": "./../b/src/index.ts", // a ".." segment
          "./twice": "./dist//index.js", // an empty segment
          "./vendored": "./node_modules/kepler/index.js",
        },
      }),
      "a/src/index.ts": "",
      "a/src/b.ts": "",
      "a/node_modules/kepler/index.js": "",
      "b/package.json": '{ "name": "@obs/b", ',
      "b/src/index.ts": "",
    }),
  );
  expect(g.profile.typescript.aliases).toEqual({
    "@obs/a": ["a/src/index.ts"],
  });
  expect(g.conflicts).toEqual([]);
  expect(g.warnings).toEqual([]);
});

it("names one conflict for each other target, sorted, from any source, and leaves the key out", async () => {
  const g = await generateProfile(
    snapshot({
      "c/package.json": json({ name: "@obs/core", main: "src/index.ts" }),
      "c/src/index.ts": "",
      "a/package.json": json({ name: "@obs/core", main: "src/index.ts" }),
      "a/src/index.ts": "",
      "b/package.json": json({ name: "@obs/core", main: "src/index.ts" }),
      "b/src/index.ts": "",
      "sky/package.json": json({ name: "@obs/sky", main: "src/index.ts" }),
      "sky/src/index.ts": "",
      "tsconfig.json": json({
        compilerOptions: {
          paths: {
            "@obs/web/*": ["web/src/*"],
            "@obs/sky": ["sky/src/index.ts"],
            "@obs/multi": ["x/a.ts", "x/b.ts"],
            '@obs/"sky"\t': ["sky/a.ts"],
          },
        },
      }),
      "web/tsconfig.json": json({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@obs/web/*": ["src/*"],
            "@obs/sky": ["../sky/lib/index.ts"],
            "@obs/multi": ["../x/a.ts"],
            '@obs/"sky"\t': ["../sky/b.ts"],
          },
        },
      }),
    }),
  );
  // each key JSON-quoted
  expect(g.conflicts).toEqual([
    'two packages export "@obs/\\"sky\\"\\t": sky/a.ts and sky/b.ts; name one in the profile',
    'two packages export "@obs/core": a/src/index.ts and b/src/index.ts; name one in the profile',
    'two packages export "@obs/core": a/src/index.ts and c/src/index.ts; name one in the profile',
    'two packages export "@obs/core/*": a/src/* and b/src/*; name one in the profile',
    'two packages export "@obs/core/*": a/src/* and c/src/*; name one in the profile',
    'two packages export "@obs/multi": x/a.ts and ["x/a.ts","x/b.ts"]; name one in the profile',
    'two packages export "@obs/sky": sky/lib/index.ts and sky/src/index.ts; name one in the profile',
  ]);
  expect(g.profile.typescript.aliases).toEqual({
    "@obs/sky/*": ["sky/src/*"],
    "@obs/web/*": ["web/src/*"],
  });
  expect(g.found.aliases).toBe(2);
});

it("writes alias keys in path order, whatever order they are found in", async () => {
  const g = await generateProfile(
    snapshot({
      "tsconfig.json":
        '{ "compilerOptions": { "paths": { "~/*": ["web/src/*"], "@obs/b": ["b.ts"], "#/*": ["lib/*"], "@obs/a": ["a.ts"] } } }',
    }),
  );
  expect(Object.keys(g.profile.typescript.aliases)).toEqual([
    "#/*",
    "@obs/a",
    "@obs/b",
    "~/*",
  ]);
});

it("warns on each extends into node_modules, in tsconfig and list order, and on no other", async () => {
  const g = await generateProfile(
    snapshot({
      "web/tsconfig.json": json({
        extends: [
          "./tsconfig.base.json",
          "@obs/tsconfig/base.json",
          "../node_modules/@tsconfig/node22/tsconfig.json",
        ],
      }),
      "web/tsconfig.base.json": "{}",
      "lib/tsconfig.json": json({ extends: "../tsconfig.json" }),
      "tsconfig.json": json({ extends: "/srv/tsconfig.json" }),
      "api/tsconfig.json": json({ extends: "@obs/tsconfig" }),
      // relative, as TypeScript reads a backslash
      "cli/tsconfig.json": json({ extends: ".\\tsconfig.base.json" }),
      "node_modules/@obs/tsconfig/tsconfig.json": json({
        extends: "@obs/base",
      }),
    }),
  );
  expect(g.warnings).toEqual([
    "api/tsconfig.json: extends @obs/tsconfig was not resolved",
    "web/tsconfig.json: extends @obs/tsconfig/base.json was not resolved",
    "web/tsconfig.json: extends ../node_modules/@tsconfig/node22/tsconfig.json was not resolved",
  ]);
});

it("takes the parent of the topmost package, and the repo top when the top is a package too", async () => {
  const g = await generateProfile(
    snapshot({
      "__init__.py": "",
      "sky/__init__.py": "",
      "sky/orbit/__init__.py": "",
      "tools/a/b/__init__.py": "",
      "tools/a/b/c/__init__.py": "",
      "tools/a/d.py": "",
      "sim/src/observatory/ephemeris/__init__.py": "",
    }),
  );
  expect(g.profile.python.roots).toEqual([
    ".",
    "sim/src/observatory",
    "tools/a",
  ]);
});

it("lists the roots in path order, whatever order their packages come in", async () => {
  // sim/sky-x/ comes before sim/sky/ in path order, yet its root comes after sim/sky
  const g = await generateProfile(
    snapshot({
      "sim/sky-x/kepler/__init__.py": "",
      "sim/sky/orbit/__init__.py": "",
    }),
  );
  expect(g.profile.python.roots).toEqual(["sim/sky", "sim/sky-x"]);
  expect(g.found.pythonRoots).toEqual(["sim/sky", "sim/sky-x"]);
});

it("lists single-file modules from <dir>/ before <dir>/src/, identifiers only, sorted and once", async () => {
  const g = await generateProfile(
    snapshot({
      "tools/pyproject.toml":
        '[tool.setuptools]\npy-modules = ["skyctl", "orbit", "missing", "a.b", "../escape", 7, "skyctl", "kepler"]',
      "tools/kepler.py": "",
      "tools/skyctl.py": "",
      "tools/src/skyctl.py": "",
      "tools/src/orbit.py": "",
      "tools/a.b.py": "",
      "escape.py": "",
      "pyproject.toml": '[tool.setuptools]\npy-modules = ["skyctl"]',
      "skyctl.py": "",
      "sim/pyproject.toml":
        '[project]\nname = "sim"\n[tool.setuptools]\npackages = ["observatory"]',
      "web/pyproject.toml": '[tool.setuptools]\npy-modules = "kepler"',
      "web/kepler.py": "",
    }),
  );
  expect(g.profile.python.singleFileModules).toEqual([
    "skyctl.py",
    "tools/kepler.py",
    "tools/skyctl.py",
    "tools/src/orbit.py",
  ]);
});

it("finds the components computeComponents finds, and counts each launch manifest once, never a test's", async () => {
  const g = await generateProfile(
    snapshot({
      "web/package.json": json({
        name: "@obs/web",
        bin: { sky: "./dist/cli.js" },
        scripts: { start: "node dist/server.js", test: "node --test" },
      }),
      "web/src/cli.ts": "",
      "web/src/server.ts": "",
      Procfile: "web: node web/dist/server.js\n",
      "sim/src/observatory/__init__.py": "",
      "sim/src/observatory/ephemeris.py":
        'if __name__ == "__main__":\n    pass\n',
      "sim/tests/test_orbit.py": 'if __name__ == "__main__":\n    pass\n',
      "tools/run.ts": "",
      "docs/guide.md": "# Guide\n",
    }),
  );
  // web/package.json, Procfile and ephemeris.py, its own main-guard manifest
  expect(g.found).toEqual({
    aliases: 1,
    pythonRoots: ["sim/src"],
    components: ["sim/", "sim/src/observatory/", "tools/", "web/"],
    launchManifests: 3,
  });
});

it("reads a file's mode from its owner's execute bit, as git does", async () => {
  const dir = snapshot({
    "scripts/deploy.sh": "#!/bin/sh\necho sky\n",
    "scripts/group.sh": "#!/bin/sh\necho sky\n",
    "scripts/plain.sh": "#!/bin/sh\necho sky\n",
  });
  chmodSync(join(dir, "scripts/deploy.sh"), 0o744);
  chmodSync(join(dir, "scripts/group.sh"), 0o655);
  chmodSync(join(dir, "scripts/plain.sh"), 0o644);
  // deploy.sh alone is executable, its own manifest
  expect((await generateProfile(dir)).found.launchManifests).toBe(1);
});

it("takes no alias, tsconfig or warning from under node_modules, yet counts its manifests and package roots", async () => {
  const g = await generateProfile(
    snapshot({
      "node_modules/@obs/core/package.json": json({
        name: "@obs/core",
        main: "index.js",
        bin: { core: "cli.js" },
      }),
      "node_modules/@obs/core/index.js": "",
      "node_modules/@obs/core/cli.js": "",
      "node_modules/@obs/core/tsconfig.json": json({
        extends: "@obs/base",
        compilerOptions: { paths: { "@obs/x/*": ["src/*"] } },
      }),
      "web/node_modules/@obs/core/package.json": json({
        name: "@obs/core",
        main: "index.js",
      }),
      "web/node_modules/@obs/core/index.js": "",
    }),
  );
  expect(g).toEqual({
    profile: DEFAULT_PROFILE,
    conflicts: [],
    found: {
      aliases: 0,
      pythonRoots: [],
      components: ["node_modules/@obs/core/", "web/node_modules/@obs/core/"],
      launchManifests: 1,
    },
    warnings: [],
  });
});

it("reads a file of 1,048,576 bytes, and none longer, not even in part", async () => {
  // a pyproject.toml of exactly `size` bytes, padded by a last comment, so that its first
  // 1,048,576 bytes would read as well as the whole
  const sized = (size: number): string => {
    const head = '[tool.setuptools]\npy-modules = ["skyctl"]\n# ';
    return head + "x".repeat(size - head.length);
  };
  const g = await generateProfile(
    snapshot({
      "lib/a/pyproject.toml": sized(1_048_576),
      "lib/a/skyctl.py": "",
      "lib/b/pyproject.toml": sized(1_048_577),
      "lib/b/skyctl.py": "",
      "sim/x.ts": "",
      "tools/x.ts": "",
      "web/x.ts": "",
    }),
  );
  expect(g.profile.python.singleFileModules).toEqual(["lib/a/skyctl.py"]);
  // lib/b/pyproject.toml, unread, still makes lib/b/ a package root; no component holds more
  // than 40% of the files, so none splits
  expect(g.found.components).toEqual([
    "lib/a/",
    "lib/b/",
    "sim/",
    "tools/",
    "web/",
  ]);
});

it("reads only regular files under the snapshot, through no link, and never opens a FIFO", async () => {
  const outside = snapshot({
    "package.json": json({ name: "@obs/outside", main: "src/index.ts" }),
    "src/index.ts": "",
    "tsconfig.json": json({
      compilerOptions: { paths: { "@obs/x/*": ["src/*"] } },
    }),
    "__init__.py": "",
  });
  const dir = snapshot({
    "web/src/a.ts": "",
    "sim/x.ts": "",
    "tools/x.ts": "",
  });
  symlinkSync(outside, join(dir, "linked"));
  symlinkSync(join(outside, "package.json"), join(dir, "package.json"));
  symlinkSync(join(outside, "__init__.py"), join(dir, "web/__init__.py"));
  execFileSync("mkfifo", [join(dir, "tsconfig.json")]);
  const g = await generateProfile(dir);
  expect(g.profile).toEqual(DEFAULT_PROFILE);
  // no linked/ component: the link to a directory is never walked
  expect(g.found).toEqual({
    aliases: 0,
    pythonRoots: [],
    components: ["sim/", "tools/", "web/"],
    launchManifests: 0,
  });
}, 5000);

it("fills every other field from DEFAULT_PROFILE, in objects of its own", async () => {
  const g = await generateProfile(snapshot({}));
  expect(g).toEqual({
    profile: DEFAULT_PROFILE,
    conflicts: [],
    found: { aliases: 0, pythonRoots: [], components: [], launchManifests: 0 },
    warnings: [],
  });
  // the same keys, in the same order
  expect(JSON.stringify(g.profile)).toBe(JSON.stringify(DEFAULT_PROFILE));
  g.profile.components.push("web/src/*");
  g.profile.typescript.tsconfigs.push("web/tsconfig.json");
  g.profile.python.roots.push("sim/src");
  g.profile.tests.extraPatterns.push("*.check.ts");
  g.profile.launchManifests.push({
    glob: "plugins/*/plugin.json",
    pointer: "/entry",
    kind: "plugin",
  });
  g.profile.denylist.extra.push("deploy/**");
  g.profile.gates.maxUnresolvedRelativeImports = 0.01;
  g.found.pythonRoots.push("tools");
  expect(g.profile.python.roots).toEqual(["sim/src"]);
  expect(DEFAULT_PROFILE.tests.extraPatterns).toEqual([]);
  expect(DEFAULT_PROFILE.gates.maxUnresolvedRelativeImports).toBe(0.005);
});

it("is exported by ./build", () => {
  expect(typeof generateProfile).toBe("function");
  expect(build.generateProfile).toBe(generateProfile);
});
