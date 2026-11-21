// hakutaku's own Python resolver: the fallback tier, and the resolution of the files grimp did
// not read. It resolves a module as an import statement names it, over the module index that
// pythonModuleIndex builds: a relative module from the importing file's package, or, in a repo
// whose top is itself a package, from the repo top; an absolute one by its longest prefix in
// the index; and a name the index does not hold by its top-level name, as a standard-library
// module or else a PyPI package. Nothing here reads a file.
import { PYTHON_STDLIB } from "../../model/index.js";

export type PythonResolution =
  | { file: string }
  | { ecosystem: "python" | "pypi"; name: string }
  | null;

// `module` keeps the dots a relative import starts with: ".", "..catalog.stars". A relative
// module names exactly one module, and matches nothing when the index lacks it, when it climbs
// past the top package, or when the importing file has no package (it is not in the index, or
// it is a top-level module).
//
// `tree`, the tree's regular files, lets a repo whose top holds an __init__.py be the package a
// plugin is to the application that imports it. A relative import the index leaves unresolved
// is then read again from the repo top, when the importing file's package chain reaches it.
export function resolvePythonImport(
  from: string,
  module: string,
  modules: ReadonlyMap<string, string>,
  tree?: ReadonlySet<string>,
): PythonResolution {
  const dots = module.length - module.replace(/^\.+/, "").length;
  const rest = module.slice(dots);
  const parts = rest === "" ? [] : rest.split(".");
  if (parts.includes("")) return null;
  if (dots === 0) {
    const [top] = parts;
    if (top === undefined) return null;
    for (let n = parts.length; n > 0; n--) {
      const file = modules.get(parts.slice(0, n).join("."));
      if (file !== undefined) return { file };
    }
    return { ecosystem: PYTHON_STDLIB.has(top) ? "python" : "pypi", name: top };
  }
  const name = namesOf(modules).get(from);
  if (name !== undefined) {
    // an __init__.py is its package; any other module's package is its parent
    const pkg = name.split(".");
    if (!isInit(from)) pkg.pop();
    const kept = pkg.length - (dots - 1);
    const file =
      kept < 1
        ? undefined
        : modules.get([...pkg.slice(0, kept), ...parts].join("."));
    if (file !== undefined) return { file };
  }
  return tree === undefined ? null : fromRepoTop(from, dots, parts, tree);
}

const isInit = (path: string): boolean =>
  path === "__init__.py" || path.endsWith("/__init__.py");

// A name part Python can import: an identifier, as str.isidentifier() reads one.
const IDENTIFIER = /^[\p{XID_Start}_]\p{XID_Continue}*$/u;

// A relative import read with the repo top as the outermost package. The importing file must be
// a module of a package chain that reaches the repo top: its directory and each one above it
// hold an __init__.py, as the repo top does, and every part of its path is an identifier. Its
// package is then its directory, and the module names one file by its path from the repo top:
// a package's __init__.py before a module of the same name, never a stub, and the repo top's
// own __init__.py when the climb leaves no name at all.
function fromRepoTop(
  from: string,
  dots: number,
  parts: readonly string[],
  tree: ReadonlySet<string>,
): PythonResolution {
  if (!tree.has("__init__.py") || !from.endsWith(".py")) return null;
  const dirs = from.split("/");
  const stem = (dirs.pop() as string).slice(0, -".py".length);
  if (stem !== "__init__" && !IDENTIFIER.test(stem)) return null;
  for (let n = dirs.length; n > 0; n--) {
    const dir = dirs.slice(0, n);
    if (
      !IDENTIFIER.test(dir[n - 1] as string) ||
      !tree.has([...dir, "__init__.py"].join("/"))
    ) {
      return null;
    }
  }
  const kept = dirs.length - (dots - 1);
  if (kept < 0) return null;
  const target = [...dirs.slice(0, kept), ...parts];
  if (!target.every((p) => IDENTIFIER.test(p))) return null;
  if (target.length === 0) return { file: "__init__.py" };
  const path = target.join("/");
  for (const file of [`${path}/__init__.py`, `${path}.py`]) {
    if (tree.has(file)) return { file };
  }
  return null;
}

// Each index's inverse, made once: the module each file defines. An index must not change
// after its first use. A file the index names twice, a declared single-file module that also
// lies under a root, takes its dotted name: only there can a relative import work.
const inverses = new WeakMap<
  ReadonlyMap<string, string>,
  Map<string, string>
>();

function namesOf(modules: ReadonlyMap<string, string>): Map<string, string> {
  let names = inverses.get(modules);
  if (names === undefined) {
    names = new Map();
    for (const [name, path] of modules) {
      const held = names.get(path);
      if (held === undefined || parts(name) > parts(held)) {
        names.set(path, name);
      }
    }
    inverses.set(modules, names);
  }
  return names;
}

const parts = (name: string): number => name.split(".").length;
