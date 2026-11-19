// package.json (§5.7): each bin, and each script whose command names a repo file. Read as
// data; no script runs.
import { posix } from "node:path";
import { parseJsonc } from "../profile/index.js";
import { isObject, repoPath } from "./built-paths.js";
import { commandFiles, relativeTo } from "./commands.js";
import type { EntryFact, ManifestInput, ReadContext } from "./types.js";

// A script is a dev-script when its name, or its part before the first ":", is one of these,
// alone or after "pre" or "post".
const DEV_SCRIPTS: ReadonlySet<string> = new Set([
  "test",
  "lint",
  "build",
  "format",
  "fmt",
  "typecheck",
  "check",
  "coverage",
  "prepare",
]);

export function isDevScript(name: string): boolean {
  const head = name.split(":", 1)[0] ?? "";
  return (
    DEV_SCRIPTS.has(head) ||
    (head.startsWith("pre") && DEV_SCRIPTS.has(head.slice(3))) ||
    (head.startsWith("post") && DEV_SCRIPTS.has(head.slice(4)))
  );
}

// The key path of a member or element, as the key of a line map.
export const keyOf = (path: readonly string[]): string => JSON.stringify(path);

// The line of each member and element of a JSON or JSONC text, by its key path (array indexes
// as decimal strings), down to `depth` keys: a member's line is its key's, an element's the
// line it starts on. A repeated key gives its last line, as parseJsonc keeps its last value.
// parseJsonc gives values only; this walks the same text again for positions, and is used only
// on a text parseJsonc has read, so it can trust its shape.
export function jsonLines(text: string, depth: number): Map<string, number> {
  const src = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const lines = new Map<string, number>();
  let pos = 0;
  let line = 1;
  let counted = 0;
  // positions only grow, so each line end is counted once
  const lineAt = (at: number): number => {
    for (
      let nl = src.indexOf("\n", counted);
      nl !== -1 && nl < at;
      nl = src.indexOf("\n", nl + 1)
    ) {
      line++;
    }
    counted = Math.max(counted, at);
    return line;
  };
  const skip = (): void => {
    for (;;) {
      const c = src[pos];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        pos++;
      } else if (c === "/" && src[pos + 1] === "/") {
        const nl = src.indexOf("\n", pos);
        pos = nl === -1 ? src.length : nl;
      } else if (c === "/" && src[pos + 1] === "*") {
        const end = src.indexOf("*/", pos + 2);
        pos = end === -1 ? src.length : end + 2;
      } else {
        return;
      }
    }
  };
  // A string at pos, decoded as JSON decodes it.
  const string = (): string => {
    const start = pos;
    for (pos++; pos < src.length && src[pos] !== '"'; pos++) {
      if (src[pos] === "\\") pos++;
    }
    pos++;
    try {
      return String(JSON.parse(src.slice(start, pos)));
    } catch {
      return "";
    }
  };
  const value = (path: string[] | null): void => {
    const open = src[pos];
    if (open === "{" || open === "[") {
      const close = open === "{" ? "}" : "]";
      pos++;
      for (let index = 0; ; index++) {
        skip();
        if (pos >= src.length) return;
        if (src[pos] === close) {
          pos++;
          return;
        }
        const at = pos;
        let key = String(index);
        if (open === "{") {
          if (src[pos] !== '"') return;
          key = string();
          skip();
          if (src[pos] === ":") pos++;
          skip();
        }
        const child =
          path !== null && path.length < depth ? [...path, key] : null;
        if (child !== null) lines.set(keyOf(child), lineAt(at));
        value(child);
        skip();
        if (src[pos] === ",") pos++;
        else if (src[pos] !== close) return;
      }
    }
    if (open === '"') {
      string();
      return;
    }
    // a number, true, false or null
    while (pos < src.length && !',]} \t\r\n/"{['.includes(src[pos] ?? ""))
      pos++;
  };
  skip();
  value([]);
  return lines;
}

// A manifest's value and the line of a key path in it: the path's own line, else that of its
// deepest recorded ancestor, else 1. Null when the file cannot be read or is not JSONC.
export function readJson(
  input: ManifestInput,
  path: string,
  depth: number,
): { value: unknown; line(keys: readonly string[]): number } | null {
  const text = input.read(path);
  if (text === null) return null;
  let value: unknown;
  try {
    value = parseJsonc(text);
  } catch {
    return null;
  }
  let lines: Map<string, number> | null = null;
  return {
    value,
    line: (keys) => {
      lines ??= jsonLines(text, depth);
      for (let n = keys.length; n > 0; n--) {
        const found = lines.get(keyOf(keys.slice(0, n)));
        if (found !== undefined) return found;
      }
      return 1;
    },
  };
}

// The command a string bin installs: the package's name without its scope, as npm names it.
function binName(manifest: Record<string, unknown>): string | null {
  const name = manifest.name;
  if (typeof name !== "string" || name === "") return null;
  return name.startsWith("@")
    ? name.slice(name.indexOf("/") + 1) || null
    : name;
}

// Every package.json: bin, a string or an object, through sourceForBuilt from the package's
// directory, kind bin; each script whose command names a repo file, from the package's
// directory as npm runs it, kind script or dev-script. The line is the key's.
export function readPackageJsons(ctx: ReadContext): EntryFact[] {
  const facts: EntryFact[] = [];
  for (const manifest of ctx.input.paths) {
    if (posix.basename(manifest) !== "package.json") continue;
    const doc = readJson(ctx.input, manifest, 2);
    if (doc === null || !isObject(doc.value)) continue;
    const dir = posix.dirname(manifest);
    const bin = doc.value.bin;
    const bins: Array<[string, unknown, string[]]> =
      typeof bin === "string"
        ? [[binName(doc.value) ?? "", bin, ["bin"]]]
        : isObject(bin)
          ? Object.entries(bin).map(([name, target]) => [
              name,
              target,
              ["bin", name],
            ])
          : [];
    for (const [name, target, keys] of bins) {
      if (name === "" || typeof target !== "string") continue;
      const path = repoPath(dir, target);
      const file = path === null ? null : ctx.named(path);
      if (file !== null) {
        facts.push({
          file,
          qualname: null,
          kind: "bin",
          manifest,
          line: doc.line(keys),
          name,
        });
      }
    }
    const scripts = doc.value.scripts;
    if (!isObject(scripts)) continue;
    const resolve = relativeTo(dir, ctx.named);
    for (const [name, command] of Object.entries(scripts)) {
      if (typeof command !== "string") continue;
      for (const file of commandFiles(
        command,
        resolve,
        ctx.input.pythonModules,
      )) {
        facts.push({
          file,
          qualname: null,
          kind: isDevScript(name) ? "dev-script" : "script",
          manifest,
          line: doc.line(["scripts", name]),
          name,
        });
      }
    }
  }
  return facts;
}
