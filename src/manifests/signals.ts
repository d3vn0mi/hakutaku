// Secondary signals (§5.7), each recorded with the file itself as its manifest and its path as
// its name, except a route's:
// - executable: git mode 100755 and a first line starting "#!", at line 1;
// - main-guard: each __main__.py at line 1, and each `if __name__ == "__main__":` line of a .py
//   file, either quote, starting its line;
// - route: when a package.json depends on next (dependencies or devDependencies), its
//   directory's app/**/page.* and app/**/route.* files and every pages/** file, with the
//   extension .tsx, .ts, .jsx or .js, at line 1, named by the URL path: app/page.tsx is "/",
//   app/api/stars/route.ts is "/api/stars", pages/index.tsx is "/" and pages/blog/index.tsx is
//   "/blog". Under app/, a route group "(name)" and a parallel slot "@name" add no part to the
//   URL, and a file under a private "_name" folder is no route, as Next.js routes them.
import { posix } from "node:path";
import { parseJsonc } from "../profile/index.js";
import { isObject } from "./built-paths.js";
import type { EntryFact, ReadContext } from "./types.js";

const MAIN_GUARD = /^if\s+__name__\s*==\s*(["'])__main__\1\s*:/;
const ROUTE_EXT: ReadonlySet<string> = new Set([".tsx", ".ts", ".jsx", ".js"]);

function dependsOnNext(ctx: ReadContext, manifest: string): boolean {
  const text = ctx.input.read(manifest);
  if (text === null) return false;
  let doc: unknown;
  try {
    doc = parseJsonc(text);
  } catch {
    return false;
  }
  if (!isObject(doc)) return false;
  return [doc.dependencies, doc.devDependencies].some(
    (deps) => isObject(deps) && Object.hasOwn(deps, "next"),
  );
}

// The URL path a file of the Next.js app in `dir` ("." for the repo top) serves, or null.
function routeOf(path: string, dir: string): string | null {
  const prefix = dir === "." ? "" : `${dir}/`;
  if (!path.startsWith(prefix)) return null;
  const relative = path.slice(prefix.length);
  const ext = posix.extname(relative);
  if (!ROUTE_EXT.has(ext)) return null;
  const parts = relative.slice(0, -ext.length).split("/");
  if (parts[0] === "app" && parts.length > 1) {
    const leaf = parts[parts.length - 1];
    if (leaf !== "page" && leaf !== "route") return null;
    const folders = parts.slice(1, -1);
    if (folders.some((f) => f.startsWith("_"))) return null;
    const url = folders.filter(
      (f) => !(f.startsWith("(") && f.endsWith(")")) && !f.startsWith("@"),
    );
    return `/${url.join("/")}`;
  }
  if (parts[0] === "pages" && parts.length > 1) {
    const url = parts.slice(1);
    if (url[url.length - 1] === "index") url.pop();
    return `/${url.join("/")}`;
  }
  return null;
}

export function readSignals(ctx: ReadContext): EntryFact[] {
  const facts: EntryFact[] = [];
  const own = (
    file: string,
    kind: EntryFact["kind"],
    line: number,
    name = file,
  ) => facts.push({ file, qualname: null, kind, manifest: file, line, name });
  const apps: string[] = [];
  for (const path of ctx.input.paths) {
    const base = posix.basename(path);
    if (
      ctx.input.modes.get(path) === "100755" &&
      (ctx.input.read(path)?.startsWith("#!") ?? false)
    ) {
      own(path, "executable", 1);
    }
    if (path.endsWith(".py")) {
      if (base === "__main__.py") own(path, "main-guard", 1);
      const text = ctx.input.read(path);
      if (text !== null) {
        const lines = (text.startsWith("\uFEFF") ? text.slice(1) : text).split(
          "\n",
        );
        for (const [i, line] of lines.entries()) {
          if (MAIN_GUARD.test(line)) own(path, "main-guard", i + 1);
        }
      }
    }
    if (base === "package.json" && dependsOnNext(ctx, path)) {
      apps.push(posix.dirname(path));
    }
  }
  for (const dir of apps) {
    for (const path of ctx.input.paths) {
      const url = routeOf(path, dir);
      if (url !== null) own(path, "route", 1, url);
    }
  }
  return facts;
}
