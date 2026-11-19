// Python launch manifests (§5.7): pyproject.toml's [project.scripts], [project.gui-scripts],
// [project.entry-points.*] and [tool.poetry.scripts] (string values), and setup.cfg's
// [options.entry_points] console_scripts and gui_scripts. Each "module:function" maps to the
// module's file, through the module index, and the qualname "function"; a value without ":"
// names the module alone, with no qualname. Kind console-script, named after the script.
// setup.py is never read.
import { posix } from "node:path";
import { parseIni, parseTomlSubset } from "../profile/index.js";
import { isObject } from "./built-paths.js";
import { keyOf } from "./package-json.js";
import type { EntryFact, ReadContext } from "./types.js";

const MAX_DEPTH = 512;

// "module:object.attr", with optional white space around ":" and an optional trailing
// "[extras]", as the entry-point format writes it. Each optional part takes its own trailing
// white space, so no two \s* meet and a value is rejected in linear time.
const OBJECT_REF = /^([^\s:[\]]+)\s*(?::\s*([^\s:[\]]+)\s*)?(?:\[[^\]]*\])?$/u;

function objectRef(
  value: string,
): { module: string; qualname: string | null } | null {
  const m = OBJECT_REF.exec(value.trim());
  if (m === null) return null;
  return { module: m[1] ?? "", qualname: m[2] ?? null };
}

// The key path a dotted key writes, as parseTomlSubset reads it, or null.
function keyPath(raw: string): string[] | null {
  const path: string[] = [];
  let node: unknown = parseTomlSubset(`${raw} = 0`);
  while (isObject(node)) {
    const keys = Object.keys(node);
    if (keys.length !== 1) return null;
    const key = keys[0] as string;
    path.push(key);
    node = node[key];
  }
  return node === 0 && path.length > 0 ? path : null;
}

// The table path a header line opens, as parseTomlSubset reads it, or null.
function headerPath(text: string): string[] | null {
  const path: string[] = [];
  let node: unknown = parseTomlSubset(text);
  while (isObject(node)) {
    const keys = Object.keys(node);
    if (keys.length === 0) return path.length > 0 ? path : null;
    if (keys.length !== 1) return null;
    const key = keys[0] as string;
    path.push(key);
    node = node[key];
  }
  return Array.isArray(node) && path.length > 0 ? path : null;
}

// The line where each key path of a TOML text is first written, as parseTomlSubset keeps the
// first value of a repeated key: each key's full path (its table's, then its own, inline
// tables included) and each header's table path. parseTomlSubset gives values only; this walks
// the text again for positions, skipping strings and arrays whole, so a line inside a
// multi-line string is never read as a header or a key. Keys and headers are decoded by
// parseTomlSubset itself. A line it cannot read is passed over as parseTomlSubset passes it.
export function tomlLines(text: string): Map<string, number> {
  const s = (text.startsWith("\uFEFF") ? text.slice(1) : text).replaceAll(
    "\r\n",
    "\n",
  );
  const lines = new Map<string, number>();
  let pos = 0;
  let line = 1;
  let counted = 0;
  const lineAt = (at: number): number => {
    if (at < counted) {
      line = 1;
      counted = 0;
    }
    for (
      let nl = s.indexOf("\n", counted);
      nl !== -1 && nl < at;
      nl = s.indexOf("\n", nl + 1)
    ) {
      line++;
    }
    counted = at;
    return line;
  };
  const record = (path: readonly string[], at: number): void => {
    const key = keyOf(path);
    if (!lines.has(key)) lines.set(key, lineAt(at));
  };
  const ws = (): void => {
    while (s[pos] === " " || s[pos] === "\t") pos++;
  };
  const blank = (): void => {
    for (;;) {
      ws();
      if (s[pos] === "\n") {
        pos++;
      } else if (s[pos] === "#") {
        const nl = s.indexOf("\n", pos);
        pos = nl === -1 ? s.length : nl;
      } else {
        return;
      }
    }
  };
  // A one-line string at pos, quoted by `quote`; false when it does not close on its line.
  const short = (quote: string): boolean => {
    for (pos++; pos < s.length && s[pos] !== quote && s[pos] !== "\n"; pos++) {
      if (quote === '"' && s[pos] === "\\") pos++;
    }
    if (s[pos] !== quote) return false;
    pos++;
    return true;
  };
  // A dotted key at pos, as written; null when none can be read.
  const rawKey = (): string | null => {
    const start = pos;
    for (;;) {
      const c = s[pos];
      if (c === '"' || c === "'") {
        if (!short(c)) return null;
      } else {
        const bare = /[A-Za-z0-9_-]+/y;
        bare.lastIndex = pos;
        if (!bare.test(s)) return null;
        pos = bare.lastIndex;
      }
      const save = pos;
      ws();
      if (s[pos] !== ".") {
        pos = save;
        return s.slice(start, pos);
      }
      pos++;
      ws();
    }
  };
  // Passes over the value at pos. In a table value, at `path`, records its keys. False when
  // the value cannot be read.
  const value = (path: readonly string[] | null, depth: number): boolean => {
    if (depth > MAX_DEPTH) return false;
    for (const quote of ['"""', "'''"]) {
      if (!s.startsWith(quote, pos)) continue;
      for (pos += 3; pos < s.length; pos++) {
        if (quote === '"""' && s[pos] === "\\") pos++;
        else if (s.startsWith(quote, pos)) {
          while (s[pos] === quote[0]) pos++;
          return true;
        }
      }
      return false;
    }
    const c = s[pos];
    if (c === '"' || c === "'") return short(c);
    if (c === "[" || c === "{") {
      const close = c === "[" ? "]" : "}";
      pos++;
      for (;;) {
        blank();
        if (s[pos] === close) {
          pos++;
          return true;
        }
        if (pos >= s.length) return false;
        let inner: readonly string[] | null = null;
        if (c === "{") {
          const at = pos;
          const raw = rawKey();
          if (raw === null) return false;
          ws();
          if (s[pos] !== "=") return false;
          pos++;
          ws();
          const keys = keyPath(raw);
          if (path !== null && keys !== null) {
            inner = [...path, ...keys];
            record(inner, at);
          }
        }
        if (!value(inner, depth + 1)) return false;
        blank();
        if (s[pos] === ",") pos++;
        else if (s[pos] !== close) return false;
      }
    }
    // a bare value: to a comma, a bracket, a brace, a comment or the end of its line
    const start = pos;
    while (pos < s.length && !",]}#\n".includes(s[pos] ?? "")) pos++;
    return pos > start;
  };
  // Where reading goes on after a statement that began at `start` and stopped at `at`, as
  // parseTomlSubset's resume decides.
  const resume = (start: number, at: number): number => {
    let i = at;
    while (i > start && (s[i - 1] === " " || s[i - 1] === "\t")) i--;
    if (i > start && s[i - 1] === "\n") return at;
    const nl = s.indexOf("\n", at);
    return nl === -1 ? s.length : nl + 1;
  };
  let table: readonly string[] | null = [];
  for (;;) {
    blank();
    if (pos >= s.length) return lines;
    const start = pos;
    if (s[pos] === "[") {
      const nl = s.indexOf("\n", pos);
      const end = nl === -1 ? s.length : nl;
      table = headerPath(s.slice(pos, end));
      if (table !== null) record(table, start);
      pos = end;
      continue;
    }
    const raw = rawKey();
    let read = false;
    if (raw !== null) {
      ws();
      if (s[pos] === "=") {
        pos++;
        ws();
        const keys = keyPath(raw);
        const full =
          table !== null && keys !== null ? [...table, ...keys] : null;
        if (full !== null) record(full, start);
        read = value(full, 0);
        if (read) {
          ws();
          if (s[pos] === "#") {
            const nl = s.indexOf("\n", pos);
            pos = nl === -1 ? s.length : nl;
          }
          read = pos >= s.length || s[pos] === "\n";
        }
      }
    }
    if (!read) pos = resume(start, pos);
  }
}

// [project.scripts], [project.gui-scripts], each [project.entry-points.<group>] and
// [tool.poetry.scripts], with their key paths.
function scriptTables(
  doc: Record<string, unknown>,
): Array<[string[], Record<string, unknown>]> {
  const at = (...keys: string[]): unknown =>
    keys.reduce<unknown>(
      (node, key) => (isObject(node) ? node[key] : undefined),
      doc,
    );
  const tables: Array<[string[], unknown]> = [
    [["project", "scripts"], at("project", "scripts")],
    [["project", "gui-scripts"], at("project", "gui-scripts")],
  ];
  const groups = at("project", "entry-points");
  if (isObject(groups)) {
    for (const [group, table] of Object.entries(groups)) {
      tables.push([["project", "entry-points", group], table]);
    }
  }
  tables.push([["tool", "poetry", "scripts"], at("tool", "poetry", "scripts")]);
  return tables.filter((t): t is [string[], Record<string, unknown>] =>
    isObject(t[1]),
  );
}

function pyproject(ctx: ReadContext, manifest: string): EntryFact[] {
  const text = ctx.input.read(manifest);
  if (text === null) return [];
  const facts: EntryFact[] = [];
  let lines: Map<string, number> | null = null;
  for (const [path, table] of scriptTables(parseTomlSubset(text))) {
    for (const [name, value] of Object.entries(table)) {
      if (typeof value !== "string") continue;
      const ref = objectRef(value);
      const file =
        ref === null ? undefined : ctx.input.pythonModules.get(ref.module);
      if (ref === null || file === undefined) continue;
      lines ??= tomlLines(text);
      const keys = [...path, name];
      let line = 1;
      for (let n = keys.length; n > 0; n--) {
        const found = lines.get(keyOf(keys.slice(0, n)));
        if (found !== undefined) {
          line = found;
          break;
        }
      }
      facts.push({
        file,
        qualname: ref.qualname,
        kind: "console-script",
        manifest,
        line,
        name,
      });
    }
  }
  return facts;
}

// Part n of a value is on line `line + n`: parseIni keeps blank and comment lines inside a
// value as empty parts.
function setupCfg(ctx: ReadContext, manifest: string): EntryFact[] {
  const text = ctx.input.read(manifest);
  if (text === null) return [];
  const facts: EntryFact[] = [];
  for (const entry of parseIni(text)) {
    if (
      entry.section !== "options.entry_points" ||
      (entry.key !== "console_scripts" && entry.key !== "gui_scripts")
    ) {
      continue;
    }
    entry.value.split("\n").forEach((part, n) => {
      const eq = part.indexOf("=");
      if (eq <= 0) return;
      const name = part.slice(0, eq).trim();
      const ref = objectRef(part.slice(eq + 1));
      const file =
        ref === null ? undefined : ctx.input.pythonModules.get(ref.module);
      if (name === "" || ref === null || file === undefined) return;
      facts.push({
        file,
        qualname: ref.qualname,
        kind: "console-script",
        manifest,
        line: entry.line + n,
        name,
      });
    });
  }
  return facts;
}

export function readPythonManifests(ctx: ReadContext): EntryFact[] {
  const facts: EntryFact[] = [];
  for (const manifest of ctx.input.paths) {
    const base = posix.basename(manifest);
    if (base === "pyproject.toml") facts.push(...pyproject(ctx, manifest));
    else if (base === "setup.cfg") facts.push(...setupCfg(ctx, manifest));
  }
  return facts;
}
