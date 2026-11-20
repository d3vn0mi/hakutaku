// hakutaku's own TypeScript and JavaScript resolver: the fallback tier, and the resolution of
// files dependency-cruiser did not list. It follows the generated tsconfig's bundler
// resolution over the snapshot's paths, in the order of the steps below, and decides
// externals by the same rules as the dependency-cruiser driver, so that the two tiers name
// one module alike. Nothing here reads a file: paths is the snapshot's list.
import { posix } from "node:path";
import { RESOLVE_EXTENSIONS } from "../../export/configs.js";
import { NODE_BUILTINS } from "../../model/index.js";

export interface External {
  ecosystem: "npm" | "node";
  name: string;
}

export type TsResolution = { file: string } | External | null;

export interface TsResolveContext {
  paths: ReadonlySet<string>;
  aliases: Readonly<Record<string, string[]>>;
  workspaces: ReadonlyMap<string, string>; // each package.json name to its file target
}

// TypeScript's own sources for an import written with a JavaScript extension, in the order
// TypeScript tries them (tryAddingExtensions in its module resolver).
const TS_TWINS: ReadonlyArray<readonly [string, readonly string[]]> = [
  [".js", [".ts", ".tsx", ".d.ts"]],
  [".jsx", [".tsx", ".ts", ".d.ts"]],
  [".mjs", [".mts", ".d.mts"]],
  [".cjs", [".cts", ".d.cts"]],
];

// Directories TypeScript and dependency-cruiser treat as installed packages.
const NODE_MODULES = "node_modules";

// The steps: a relative specifier as written, then its TypeScript twins, then each extension
// of the generated config's list, then /index with each; a non-relative one through the
// profile's aliases, then the workspaces' names, then Node's built-ins, and anything else is
// an npm package. A file under node_modules is never a repo file: it names its npm package.
export function resolveTsImport(
  from: string,
  specifier: string,
  ctx: TsResolveContext,
): TsResolution {
  if (isRelative(specifier)) {
    const found = findFile(
      posix.join(posix.dirname(from), specifier),
      namesDirectory(specifier),
      ctx.paths,
    );
    return found === null ? null : fileOrPackage(found);
  }
  const aliased = resolveAlias(specifier, ctx);
  if (aliased !== null) return aliased;
  const workspace = ctx.workspaces.get(specifier);
  if (workspace !== undefined && ctx.paths.has(workspace)) {
    return fileOrPackage(workspace);
  }
  return externalOf(specifier);
}

// Node's relative specifiers: "." and "..", and those starting "./" or "../".
export function isRelative(specifier: string): boolean {
  return (
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../")
  );
}

// A path inside the repo, as the snapshot names its files: relative, with no empty, "." or
// ".." segment.
export function isRepoPath(path: string): boolean {
  return (
    path !== "" &&
    !path.startsWith("/") &&
    path.split("/").every((s) => s !== "" && s !== "." && s !== "..")
  );
}

// The external module a specifier names when it reached no repo file: a node: specifier, or
// a top-level name in NODE_BUILTINS, is a Node built-in by its top-level name (fs/promises is
// node:fs); any other bare specifier is an npm package by its name; anything else (an
// absolute path, a URL, a #subpath import, "@" without a scope) names none.
export function externalOf(specifier: string): External | null {
  return builtinOf(specifier) ?? npmOf(specifier);
}

// The Node built-in a specifier names, or null.
export function builtinOf(specifier: string): External | null {
  if (specifier.startsWith("node:")) {
    const name = specifier.slice("node:".length).split("/")[0] ?? "";
    return name === "" ? null : { ecosystem: "node", name };
  }
  const top = specifier.split("/")[0] ?? "";
  return NODE_BUILTINS.has(top) ? { ecosystem: "node", name: top } : null;
}

// A bare specifier's npm package: @scope/name, or the first segment.
function npmOf(specifier: string): External | null {
  if (
    specifier === "" ||
    isRelative(specifier) ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier)
  ) {
    return null;
  }
  const [first = "", second] = specifier.split("/");
  if (!first.startsWith("@")) return { ecosystem: "npm", name: first };
  return first.length > 1 && second !== undefined && second !== ""
    ? { ecosystem: "npm", name: `${first}/${second}` }
    : null;
}

// Whether a repo path lies under a node_modules directory.
export function inNodeModules(path: string): boolean {
  return path.split("/").slice(0, -1).includes(NODE_MODULES);
}

// A repo path a resolution reached: the file itself, or, under node_modules, the npm package
// it belongs to: the directory after the last node_modules directory, with its scope. A file
// lying directly in node_modules or in a scope's directory belongs to no package.
export function fileOrPackage(path: string): TsResolution {
  const segments = path.split("/");
  const file = segments.length - 1;
  const at = segments.slice(0, file).lastIndexOf(NODE_MODULES);
  if (at < 0) return { file: path };
  const scoped = segments[at + 1]?.startsWith("@") === true;
  const parts = scoped ? 2 : 1;
  return at + parts < file
    ? {
        ecosystem: "npm",
        name: segments.slice(at + 1, at + 1 + parts).join("/"),
      }
    : null;
}

// "." and ".." name a directory, as does a specifier ending in "/".
function namesDirectory(specifier: string): boolean {
  const last = specifier.slice(specifier.lastIndexOf("/") + 1);
  return last === "" || last === "." || last === "..";
}

// The first candidate for base that paths holds. A base that leaves the repo finds nothing.
function findFile(
  joined: string,
  directoryOnly: boolean,
  paths: ReadonlySet<string>,
): string | null {
  const base = joined.replace(/\/+$/, "");
  if (base !== "." && !isRepoPath(base)) return null;
  const candidates: string[] = [];
  if (!directoryOnly && base !== ".") {
    candidates.push(base);
    for (const [js, twins] of TS_TWINS) {
      if (base.endsWith(js)) {
        const stem = base.slice(0, -js.length);
        for (const twin of twins) candidates.push(stem + twin);
      }
    }
    for (const ext of RESOLVE_EXTENSIONS) candidates.push(base + ext);
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    candidates.push(posix.join(base, `index${ext}`));
  }
  return candidates.find((c) => paths.has(c)) ?? null;
}

// The profile's aliases, as TypeScript reads paths: a key equal to the specifier wins;
// otherwise the key with one * whose prefix is longest (the first of equals) matches, and its
// targets are tried in order, the * replaced by what it matched. A key or target with more
// than one * is skipped, as TypeScript refuses it. An exact key's target is taken as written.
function resolveAlias(specifier: string, ctx: TsResolveContext): TsResolution {
  let key: string | null = null;
  let star: string | null = null;
  if (Object.hasOwn(ctx.aliases, specifier) && !specifier.includes("*")) {
    key = specifier;
  } else {
    let longest = -1;
    for (const candidate of Object.keys(ctx.aliases)) {
      const parts = candidate.split("*");
      if (parts.length !== 2) continue;
      const [prefix = "", suffix = ""] = parts;
      if (
        prefix.length > longest &&
        specifier.length >= prefix.length + suffix.length &&
        specifier.startsWith(prefix) &&
        specifier.endsWith(suffix)
      ) {
        longest = prefix.length;
        key = candidate;
        star = specifier.slice(prefix.length, specifier.length - suffix.length);
      }
    }
  }
  if (key === null) return null;
  for (const target of ctx.aliases[key] ?? []) {
    if (target.split("*").length > 2) continue;
    const path = star ? target.replace("*", star) : target;
    const found = findFile(
      posix.normalize(path),
      path.endsWith("/"),
      ctx.paths,
    );
    if (found !== null) return fileOrPackage(found);
  }
  return null;
}
