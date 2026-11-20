// hakutaku's own Python resolver: the fallback tier, and the resolution of the files grimp did
// not read. It resolves a module as an import statement names it, over the module index that
// pythonModuleIndex builds: a relative module from the importing file's package, an absolute
// one by its longest prefix in the index, and a name the index does not hold by its top-level
// name, as a standard-library module or else a PyPI package. Nothing here reads a file.
import { PYTHON_STDLIB } from "../../model/index.js";

export type PythonResolution =
  | { file: string }
  | { ecosystem: "python" | "pypi"; name: string }
  | null;

// `module` keeps the dots a relative import starts with: ".", "..catalog.stars". A relative
// module names exactly one module, and matches nothing when the index lacks it, when it climbs
// past the top package, or when the importing file has no package (it is not in the index, or
// it is a top-level module).
export function resolvePythonImport(
  from: string,
  module: string,
  modules: ReadonlyMap<string, string>,
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
  if (name === undefined) return null;
  // an __init__.py is its package; any other module's package is its parent
  const pkg = name.split(".");
  if (!isInit(from)) pkg.pop();
  const kept = pkg.length - (dots - 1);
  if (kept < 1) return null;
  const file = modules.get([...pkg.slice(0, kept), ...parts].join("."));
  return file === undefined ? null : { file };
}

const isInit = (path: string): boolean =>
  path === "__init__.py" || path.endsWith("/__init__.py");

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
