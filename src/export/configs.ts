// The engines' configs, generated beside the snapshot, so that no
// config from the analysed repo is ever read: tsconfig.json for scip-typescript, in the
// snapshot's parent directory; depcruise.json, which dependency-cruiser always gets with
// --config; sgconfig.yml, with hakutaku's own ast-grep rules copied beside it; and, for
// scip-python at deep detail, pyrightconfig.json, which Pyright finds in the export directory
// before it looks for any other, and empty-env.json, the empty list of installed packages that
// scip-python reads in place of asking pip. Every path in them is relative to the export
// directory; extract adds the absolute ones at run time.
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { comparePaths } from "../model/index.js";
import type { Profile, Rules } from "../profile/index.js";

// The package's ast-grep/ directory: two levels above this module, in src/ as in dist/.
const PACKAGE_AST_GREP = fileURLToPath(
  new URL("../../ast-grep/", import.meta.url),
);

// The extensions dependency-cruiser's resolver tries, in order; hakutaku's own TypeScript
// resolver (src/extract/resolve/ts.ts) tries the same list.
export const RESOLVE_EXTENSIONS: readonly string[] = Object.freeze([
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
]);

// `metadataOnly` lists the paths kept out of every engine's input, which stay in the
// snapshot for their metadata.
export function writeEngineConfigs(
  exportDir: string,
  profile: Profile,
  rules: Rules | null,
  metadataOnly: readonly string[],
): void {
  const skipped = [...metadataOnly].sort(comparePaths);
  writeJson(join(exportDir, "tsconfig.json"), tsconfig(profile, skipped));
  writeJson(join(exportDir, "depcruise.json"), depcruise(rules, skipped));
  copyTree(PACKAGE_AST_GREP, join(exportDir, "ast-grep"));
  const utils = isDirectory(join(PACKAGE_AST_GREP, "utils"))
    ? "utilDirs:\n  - ast-grep/utils\n"
    : "";
  writeFileSync(
    join(exportDir, "sgconfig.yml"),
    `ruleDirs:\n  - ast-grep/rules\n${utils}`,
  );
  writeJson(
    join(exportDir, "pyrightconfig.json"),
    pyrightconfig(profile, skipped),
  );
  writeFileSync(join(exportDir, "empty-env.json"), "[]\n");
}

// What Pyright leaves out of a project by default, which an exclude list of a config replaces:
// node_modules, __pycache__, and every directory or file whose name starts with a dot.
const PYRIGHT_EXCLUDES: readonly string[] = [
  "**/node_modules",
  "**/__pycache__",
  "**/.*",
];
const PYRIGHT_SKIPS: ReadonlySet<string> = new Set([
  "node_modules",
  "__pycache__",
]);

// Whether Pyright reads a snapshot path as a source file of the project pyrightconfig.json gives
// it, before the metadata-only files are left out: a .py or .pyi file, none of whose names it
// leaves out by default.
export function pyrightReads(path: string): boolean {
  return (
    /\.pyi?$/.test(path) &&
    path
      .split("/")
      .every((name) => !name.startsWith(".") && !PYRIGHT_SKIPS.has(name))
  );
}

// Pyright over the snapshot alone, the profile's Python roots as its import roots, in their
// order. Its exclude list keeps its defaults and adds each metadata-only file it would read. A
// path is a glob there: "*" and "?" are its only wildcards and cannot be escaped, so each is
// written "?", which matches one character, the path's own among them.
function pyrightconfig(profile: Profile, skipped: readonly string[]): unknown {
  return {
    include: ["snapshot"],
    exclude: [
      ...PYRIGHT_EXCLUDES,
      ...skipped
        .filter(pyrightReads)
        .map((path) => `snapshot/${path.replace(/[*?]/g, "?")}`),
    ],
    extraPaths: profile.python.roots.map((root) =>
      posix.join("snapshot", root),
    ),
  };
}

// Bundler resolution over the snapshot, with the profile's aliases resolved from it.
// noResolve keeps TypeScript's program to the files include lists: an import still binds to a
// listed file, but never adds a file the list leaves out. Without it, one import of an excluded
// file, such as a 50 MB minified bundle, puts that file in scip-typescript's program, and its
// parse alone runs past the build's memory cap.
function tsconfig(profile: Profile, skipped: readonly string[]): unknown {
  return {
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
      noResolve: true,
      skipLibCheck: true,
      esModuleInterop: true,
      types: [],
      baseUrl: "snapshot",
      paths: profile.typescript.aliases,
    },
    include: ["snapshot/**/*"],
    exclude: skipped.map((path) => `snapshot/${path}`),
  };
}

// The rules file's forbidden entries as dependency-cruiser's rules, in their order, then one
// rule that reports every cycle; hakutaku applies the cycles severity itself.
function depcruise(rules: Rules | null, skipped: readonly string[]): unknown {
  const forbidden = (rules?.forbidden ?? []).map((rule) => ({
    name: rule.name,
    severity: rule.severity,
    ...(rule.comment === undefined ? {} : { comment: rule.comment }),
    from: { path: rule.from.path },
    to: { path: rule.to.path },
  }));
  return {
    forbidden: [
      ...forbidden,
      {
        name: "hakutaku-cycle",
        severity: "info",
        from: {},
        to: { circular: true },
      },
    ],
    options: {
      tsPreCompilationDeps: true,
      // a node_modules directory, not a name holding the word (web/no_node_modules.ts is
      // cruised); and a file a relative import reaches outside the snapshot ("../" from
      // baseDir), which is resolved but never opened
      doNotFollow: { path: ["(^|/)node_modules(/|$)", "^\\.\\./"] },
      moduleSystems: ["es6", "cjs", "tsd", "amd"],
      combinedDependencies: false,
      cache: false,
      enhancedResolveOptions: {
        exportsFields: ["exports"],
        conditionNames: ["import", "require", "node", "default", "types"],
        extensions: [...RESOLVE_EXTENSIONS],
      },
      ...(skipped.length === 0
        ? {}
        : { exclude: { path: `^(${skipped.map(escapeRegExp).join("|")})$` } }),
    },
  };
}

const escapeRegExp = (s: string): string =>
  s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

const writeJson = (file: string, value: unknown): void => {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

const isDirectory = (path: string): boolean =>
  statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

// Copies the directories and regular files under `from`; nothing else is in the package's tree.
function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      copyTree(join(from, entry.name), join(to, entry.name));
    } else if (entry.isFile()) {
      copyFileSync(join(from, entry.name), join(to, entry.name));
    }
  }
}
