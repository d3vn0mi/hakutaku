// The Python module index: each dotted module name, and the file that defines it.
import { posix } from "node:path";
import { comparePaths, type ShadowedModule } from "../model/index.js";

// A name part Python can import: an identifier, as str.isidentifier() reads one.
const IDENTIFIER = /^[\p{XID_Start}_]\p{XID_Continue}*$/u;

interface Claim {
  path: string;
  rank: number;
  package: boolean;
}

// Each .py file under a root is named from the deepest root holding it ("." holds every file):
// sim/src/observatory/ephemeris/cli.py under sim/src is observatory.ephemeris.cli, and an
// __init__.py gives its package's name. A part that is not an identifier names nothing, and a
// .pyi stub is never a module. A name two files claim goes to the earlier root in `roots`, as
// the earlier entry of sys.path wins; within one root, a package's __init__.py wins over a
// module of the same name, as Python's finder looks for the package first. Each tracked
// single-file module then gives its stem, unless a root already names that stem. Names are
// listed in path order.
export function pythonModuleIndex(
  paths: Iterable<string>,
  roots: readonly string[],
  singleFileModules: readonly string[],
): Map<string, string> {
  return claimModules(paths, roots, singleFileModules).index;
}

// The files under a root that claim a name another file holds, by the rules pythonModuleIndex
// names them with, in path order. A single-file module whose stem a root names is not one: it
// is declared, so it is no file a root shadows.
export function pythonShadowedModules(
  paths: Iterable<string>,
  roots: readonly string[],
  singleFileModules: readonly string[],
): ShadowedModule[] {
  return claimModules(paths, roots, singleFileModules).shadowed;
}

function claimModules(
  paths: Iterable<string>,
  roots: readonly string[],
  singleFileModules: readonly string[],
): { index: Map<string, string>; shadowed: ShadowedModule[] } {
  const tracked = new Set(paths);
  const named = new Map<string, Claim>();
  // every claim under a root, the held ones among them
  const claims: Array<{ name: string } & Claim> = [];
  for (const path of tracked) {
    if (!path.endsWith(".py")) continue;
    let rank = -1;
    let depth = -1;
    roots.forEach((root, i) => {
      const d = root === "." ? 0 : root.split("/").length;
      if (d > depth && (root === "." || path.startsWith(`${root}/`))) {
        rank = i;
        depth = d;
      }
    });
    if (rank < 0) continue;
    const root = roots[rank] ?? ".";
    const relative = root === "." ? path : path.slice(root.length + 1);
    const parts = relative.slice(0, -".py".length).split("/");
    const isPackage = parts[parts.length - 1] === "__init__";
    if (isPackage) parts.pop();
    if (parts.length === 0 || !parts.every((p) => IDENTIFIER.test(p))) continue;
    const name = parts.join(".");
    claims.push({ name, path, rank, package: isPackage });
    const held = named.get(name);
    if (
      held === undefined ||
      rank < held.rank ||
      (rank === held.rank && isPackage && !held.package)
    ) {
      named.set(name, { path, rank, package: isPackage });
    }
  }
  const shadowed: ShadowedModule[] = [];
  for (const claim of claims) {
    const held = named.get(claim.name) as Claim;
    if (held.path === claim.path) continue;
    shadowed.push({
      path: claim.path,
      name: claim.name,
      heldBy: held.path,
      by: held.rank < claim.rank ? "root" : "package",
    });
  }
  shadowed.sort((a, b) => comparePaths(a.path, b.path));
  for (const path of singleFileModules) {
    if (!tracked.has(path) || !path.endsWith(".py")) continue;
    const stem = posix.basename(path, ".py");
    if (stem === "__init__" || !IDENTIFIER.test(stem) || named.has(stem))
      continue;
    named.set(stem, { path, rank: roots.length, package: false });
  }
  const index = new Map(
    [...named]
      .sort(([a], [b]) => comparePaths(a, b))
      .map(([name, { path }]): [string, string] => [name, path]),
  );
  return { index, shadowed };
}
