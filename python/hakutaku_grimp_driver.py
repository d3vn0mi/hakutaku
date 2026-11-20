"""hakutaku's grimp driver: the Python import graph of a snapshot's packages.

Run as:  <python> -I -S -B hakutaku_grimp_driver.py <input.json>

The input names the engines' Python directory (where grimp is installed), the import roots,
the top-level packages under them, the single-file modules and the layer contracts:

    {"enginesPython": "...", "roots": ["..."], "packages": ["..."],
     "singleFileModules": [{"module": "...", "file": "..."}],
     "layers": [{"name": "...", "severity": "...", "containers": ["..."], "layers": ["..."]}]}

It prints one JSON object on stdout and exits 0:

    {"grimp": "<version>", "modules": [...], "imports": [{"importer", "imported", "line"}],
     "external": [...], "layerViolations": [{"name", "severity", "importer", "imported",
     "chain": [{"importer", "imported", "line"}]}], "unreadable": [{"file", "reason"}],
     "warnings": [...]}

Any other error prints its type and message on stderr and exits 3.

No module of the analysed code is ever imported. Python runs isolated (-I: no environment
variable, no user site-packages, not the script's directory on sys.path), without site (-S: no
site-packages and no .pth file, so that nothing installed on the machine can stand in for a
package of the snapshot) and without writing bytecode (-B: nothing is written beside grimp in
the engines directory). The driver imports everything it needs before the roots go on
sys.path, and appends them at its end, so no file under them can stand in for a module the
driver or grimp imports; from then on an audit hook refuses every import. grimp parses the
files it reads and never imports them, and the single-file modules are parsed with ast.

Written for Python 3.10, the oldest Python grimp supports.
"""

import ast
import json
import os
import sys
import warnings

# How many files grimp may fail to read before the driver gives up.
MAX_UNREADABLE = 50


def refuse_imports(event, args):
    # A codec named in a file's coding line is the one import allowed: it comes from the
    # standard library's encodings package, which searches only its own directory.
    if event == "import" and not args[0].startswith("encodings."):
        raise ImportError(
            "the grimp driver imports nothing once the roots are on sys.path: " + args[0]
        )


def main(argv):
    with open(argv[1], encoding="utf-8") as handle:
        job = json.load(handle)
    sys.path.insert(0, job["enginesPython"])
    import importlib.util

    import grimp
    import grimp.exceptions

    # Parsing old code warns (an invalid escape, "is" with a literal); nothing is printed.
    warnings.simplefilter("ignore")
    roots = [os.path.abspath(root) for root in job["roots"]]
    sys.path.extend(roots)
    sys.addaudithook(refuse_imports)

    notes = []
    packages = []
    for name in job["packages"]:
        # find_spec on a dotted name would import the name's parent package
        if not name.isidentifier():
            notes.append("left out the package %s: not a name Python can import" % name)
            continue
        origin = found_origin(importlib.util, name)
        if origin is not None and origin == own_init(name, roots):
            packages.append(name)
        else:
            notes.append(
                "left out the package %s: Python imports that name from %s"
                % (name, described(origin))
            )

    files = set()
    for name in packages:
        files.update(python_files(os.path.join(package_root(name, roots), name)))
    unreadable = []
    graph = build_graph(grimp, packages, files, unreadable)

    internal = {m for m in graph.modules if not graph.is_module_squashed(m)}
    singles = {entry["module"] for entry in job["singleFileModules"]}
    known = internal | singles

    imports = set()
    for importer in internal:
        for imported in graph.find_modules_directly_imported_by(importer):
            # a relative import that climbs past the top package names the empty module
            if imported == "":
                continue
            for detail in graph.get_import_details(importer=importer, imported=imported):
                imports.add((importer, imported, detail["line_number"]))
    for entry in job["singleFileModules"]:
        overlay(entry["module"], entry["file"], known, imports, unreadable)

    external = {imported for _, imported, _ in imports if imported not in known}

    violations = set()
    for contract in job["layers"]:
        violations |= check_layers(grimp, graph, internal, contract, notes)

    result = {
        "grimp": grimp.__version__,
        "modules": sorted(known),
        "imports": [
            {"importer": a, "imported": b, "line": line} for a, b, line in sorted(imports)
        ],
        "external": sorted(external),
        "layerViolations": [
            {
                "name": name,
                "severity": severity,
                "importer": importer,
                "imported": imported,
                "chain": [{"importer": a, "imported": b, "line": line} for a, b, line in chain],
            }
            for name, severity, importer, imported, chain in sorted(violations)
        ],
        "unreadable": sorted(unreadable, key=lambda u: u["file"]),
        "warnings": notes,
    }
    json.dump(result, sys.stdout)
    sys.stdout.write("\n")


def found_origin(util, name):
    try:
        found = util.find_spec(name)
    except (ImportError, ValueError):
        return None
    return None if found is None else found.origin


def described(origin):
    if origin is None:
        return "no file"
    if origin in ("built-in", "frozen"):
        return "a module built into Python"
    return origin


def package_root(name, roots):
    for root in roots:
        if os.path.isfile(os.path.join(root, name, "__init__.py")):
            return root
    return None


def own_init(name, roots):
    root = package_root(name, roots)
    return None if root is None else os.path.join(root, name, "__init__.py")


def python_files(directory):
    found = []
    for path, _, names in os.walk(directory, followlinks=True):
        found.extend(os.path.join(path, n) for n in names if n.endswith(".py"))
    return found


def build_graph(grimp, packages, files, unreadable):
    """grimp's graph of the packages. A file grimp cannot parse or decode stops the whole graph,
    so each such file is replaced by an empty one and the graph built again, up to
    MAX_UNREADABLE files. The files are the driver's own: links or stand-ins in the work
    directory, never the snapshot's."""
    if not packages:
        return grimp.ImportGraph()
    replaced = set()
    while True:
        try:
            return grimp.build_graph(*packages, include_external_packages=True, cache_dir=None)
        except (grimp.exceptions.SourceSyntaxError, UnicodeError) as error:
            path = failed_file(grimp, error, files)
            if path is None or path in replaced:
                raise
            if len(replaced) == MAX_UNREADABLE:
                raise RuntimeError(
                    "grimp could not read more than %d files" % MAX_UNREADABLE
                ) from None
            os.remove(path)
            with open(path, "x", encoding="utf-8"):
                pass
            replaced.add(path)
            syntax = (grimp.exceptions.SourceSyntaxError,)
            unreadable.append({"file": path, "reason": reason_of(error, syntax)})


def failed_file(grimp, error, files):
    if isinstance(error, grimp.exceptions.SourceSyntaxError):
        return error.filename if error.filename in files else None
    # grimp names the file in the message of a decoding error
    message = str(error)
    named = [path for path in files if path in message]
    return max(named, key=len) if named else None


def reason_of(error, syntax=(SyntaxError,)):
    if isinstance(error, syntax):
        line = getattr(error, "lineno", None)
        return "a syntax error at line %d" % line if line else "a syntax error"
    if isinstance(error, UnicodeError):
        return "bytes it cannot decode"
    return type(error).__name__


def overlay(module, path, known, imports, unreadable):
    """The imports of a single-file module, parsed with ast and resolved as grimp resolves
    them: the longest prefix that is a known module, else the top-level name as external. A
    top-level module has no package, so its relative imports are left out."""
    try:
        with open(path, "rb") as handle:
            tree = ast.parse(handle.read(), filename=path)
    except Exception as error:  # a syntax error, bytes it cannot decode, too deep a nesting
        unreadable.append({"file": path, "reason": reason_of(error)})
        return
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.add((module, nearest(alias.name, known), node.lineno))
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            for alias in node.names:
                full = node.module + "." + alias.name
                target = full if full in known else nearest(node.module, known)
                imports.add((module, target, node.lineno))


def nearest(name, known):
    parts = name.split(".")
    for n in range(len(parts), 0, -1):
        prefix = ".".join(parts[:n])
        if prefix in known:
            return prefix
    return parts[0]


def check_layers(grimp, graph, internal, contract, notes):
    """The chains that break one layer contract, each from a module of a lower layer to one of
    a higher layer, with the line of each import along it. A contract whose container grimp did
    not read, or that grimp refuses, is not checked, and a note says so."""
    name = contract["name"]
    containers = contract["containers"]
    missing = [c for c in containers if c not in internal]
    if missing:
        notes.append(
            "did not check the layers contract %s: its container %s is not a module grimp read"
            % (name, missing[0])
        )
        return set()
    try:
        dependencies = graph.find_illegal_dependencies_for_layers(
            layers=contract["layers"], containers=set(containers) if containers else None
        )
    except (ValueError, grimp.exceptions.NoSuchContainer) as error:
        notes.append("did not check the layers contract %s: %s" % (name, error))
        return set()
    found = set()
    for dependency in dependencies:
        for route in dependency.routes:
            for head in route.heads:
                for tail in route.tails:
                    path = [head, *route.middle, tail]
                    chain = tuple(
                        (a, b, first_line(graph, a, b)) for a, b in zip(path, path[1:])
                    )
                    found.add((name, contract["severity"], head, tail, chain))
    return found


def first_line(graph, importer, imported):
    details = graph.get_import_details(importer=importer, imported=imported)
    if not details:
        raise RuntimeError(
            "grimp gave no line for the import of %s by %s" % (imported, importer)
        )
    return min(d["line_number"] for d in details)


if __name__ == "__main__":
    try:
        main(sys.argv)
    except Exception as error:
        sys.stderr.write("%s: %s\n" % (type(error).__name__, error))
        sys.exit(3)
