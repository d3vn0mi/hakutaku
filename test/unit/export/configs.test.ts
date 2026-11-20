import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { removeTree, writeEngineConfigs } from "../../../src/export/index.js";
import { comparePaths } from "../../../src/model/index.js";
import {
  DEFAULT_PROFILE,
  type Profile,
  type Rules,
} from "../../../src/profile/index.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) removeTree(dir);
});

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-configs-"));
  made.push(dir);
  return dir;
};

const PACKAGE_AST_GREP = fileURLToPath(
  new URL("../../../ast-grep/", import.meta.url),
);

const profileWith = (aliases: Record<string, string[]>): Profile => {
  const profile = structuredClone(DEFAULT_PROFILE) as Profile;
  profile.typescript.aliases = aliases;
  return profile;
};

const text = (dir: string, name: string): string =>
  readFileSync(join(dir, name), "utf8");

// Every regular file under dir, relative to it, in path order; anything else fails.
function filesUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) found.push(path);
      else throw new Error(`not a file or directory: ${path}`);
    }
  };
  walk("");
  return found.sort(comparePaths);
}

const TSCONFIG = (
  paths: Record<string, string[]>,
  exclude: string[],
): unknown => ({
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "bundler",
    allowJs: true,
    checkJs: false,
    jsx: "preserve",
    resolveJsonModule: true,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    types: [],
    baseUrl: "snapshot",
    paths,
  },
  include: ["snapshot/**/*"],
  exclude,
});

it("writes tsconfig.json with bundler resolution and the profile's aliases", () => {
  const dir = tmp();
  const aliases = {
    "@obs/core": ["lib/core/src/index.ts"],
    "@obs/web/*": ["web/src/*", "web/lib/*"],
  };
  writeEngineConfigs(dir, profileWith(aliases), null, [
    "web/big.js",
    "sky map.min.js",
  ]);
  // The exact object, key order and layout included; the metadata-only paths in path order.
  expect(text(dir, "tsconfig.json")).toBe(
    `${JSON.stringify(TSCONFIG(aliases, ["snapshot/sky map.min.js", "snapshot/web/big.js"]), null, 2)}\n`,
  );
  const bare = tmp();
  writeEngineConfigs(bare, profileWith({}), null, []);
  expect(text(bare, "tsconfig.json")).toBe(
    `${JSON.stringify(TSCONFIG({}, []), null, 2)}\n`,
  );
});

const OPTIONS = {
  tsPreCompilationDeps: true,
  doNotFollow: { path: ["(^|/)node_modules(/|$)", "^\\.\\./"] },
  moduleSystems: ["es6", "cjs", "tsd", "amd"],
  combinedDependencies: false,
  cache: false,
  enhancedResolveOptions: {
    exportsFields: ["exports"],
    conditionNames: ["import", "require", "node", "default", "types"],
    extensions: [
      ".ts",
      ".tsx",
      ".mts",
      ".cts",
      ".d.ts",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".json",
    ],
  },
};

const CYCLE_RULE = {
  name: "hakutaku-cycle",
  severity: "info",
  from: {},
  to: { circular: true },
};

it("compiles forbidden rules into depcruise.json, last the cycle rule", () => {
  const rules: Rules = {
    schema: 1,
    cycles: { severity: "error" },
    forbidden: [
      {
        name: "no-sim-from-web",
        severity: "error",
        comment: "the web UI reads the simulator over HTTP",
        from: { path: "^web/" },
        to: { path: "^sim/" },
      },
      {
        to: { path: "\\.test\\.ts$" },
        from: { path: "^web/src/" },
        severity: "warn",
        name: "no-test-imports",
      },
    ],
    layers: [{ name: "sky", severity: "warn", layers: ["observatory.api"] }],
  };
  const dir = tmp();
  writeEngineConfigs(dir, profileWith({}), rules, [
    "web/big.js",
    "sky (1).min.js",
    "web/a+b.map",
  ]);
  const exclude = "^(sky \\(1\\)\\.min\\.js|web/a\\+b\\.map|web/big\\.js)$";
  expect(text(dir, "depcruise.json")).toBe(
    `${JSON.stringify(
      {
        forbidden: [
          {
            name: "no-sim-from-web",
            severity: "error",
            comment: "the web UI reads the simulator over HTTP",
            from: { path: "^web/" },
            to: { path: "^sim/" },
          },
          {
            name: "no-test-imports",
            severity: "warn",
            from: { path: "^web/src/" },
            to: { path: "\\.test\\.ts$" },
          },
          CYCLE_RULE,
        ],
        options: { ...OPTIONS, exclude: { path: exclude } },
      },
      null,
      2,
    )}\n`,
  );
  // The exclusion matches exactly the metadata-only paths.
  const re = new RegExp(exclude);
  expect(
    ["web/big.js", "sky (1).min.js", "web/a+b.map"].every((p) => re.test(p)),
  ).toBe(true);
  expect(
    ["web/bigXjs", "x/web/big.js", "web/big.js.map", "web/aab.map"].some((p) =>
      re.test(p),
    ),
  ).toBe(false);
  // Without rules or metadata-only paths: only the cycle rule, and no exclusion.
  const bare = tmp();
  writeEngineConfigs(bare, profileWith({}), null, []);
  expect(JSON.parse(text(bare, "depcruise.json"))).toStrictEqual({
    forbidden: [CYCLE_RULE],
    options: OPTIONS,
  });
});

it("copies ast-grep/ beside sgconfig.yml", () => {
  const dir = tmp();
  writeEngineConfigs(dir, profileWith({}), null, []);
  const utils = existsSync(join(PACKAGE_AST_GREP, "utils"));
  expect(text(dir, "sgconfig.yml")).toBe(
    `ruleDirs:\n  - ast-grep/rules\n${utils ? "utilDirs:\n  - ast-grep/utils\n" : ""}`,
  );
  const files = filesUnder(PACKAGE_AST_GREP);
  expect(files).toContain("README.md");
  expect(filesUnder(join(dir, "ast-grep"))).toEqual(files);
  for (const file of files) {
    expect(readFileSync(join(dir, "ast-grep", file))).toEqual(
      readFileSync(join(PACKAGE_AST_GREP, file)),
    );
  }
  expect(statSync(join(dir, "ast-grep")).isDirectory()).toBe(true);
});

it("writes no absolute path into the generated files", () => {
  const dir = tmp();
  writeEngineConfigs(
    dir,
    profileWith({ "@obs/web/*": ["web/src/*"] }),
    {
      schema: 1,
      forbidden: [
        {
          name: "no-sim-from-web",
          severity: "error",
          from: { path: "^web/" },
          to: { path: "^sim/" },
        },
      ],
    },
    ["web/big.js"],
  );
  for (const name of ["tsconfig.json", "depcruise.json", "sgconfig.yml"]) {
    expect(text(dir, name)).not.toContain(dir);
    expect(text(dir, name)).not.toMatch(/["\s]\//);
  }
});
