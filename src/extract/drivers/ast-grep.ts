// The ast-grep driver: runs hakutaku's rules (ast-grep/rules/) over the snapshot with the CLI
// from the engine lock, and turns its matches into the outline, call sites and import
// statements. The outline mints every definition ID, so this driver has no fallback: its
// failure fails the build.
//
// ast-grep 0.51.1 writes one JSON object per match. Its lines and columns count from 0, and
// its columns are code points, not UTF-8 bytes (probed with é and an astral emoji before a
// match), so a position is line + 1, column + 1. It reports nothing for a file that is not
// valid UTF-8, and it exits 0 when nothing matches.
import { createReadStream, readFileSync, rmSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { createInterface } from "node:readline";
import { readLock, resolveBin } from "../../engines/index.js";
import type { ImportKind } from "../../model/index.js";
import type { EngineDriver, ExtractContext } from "../context.js";
import type { CallFact, ImportFact, OutlineDef, Pos } from "../facts.js";
import {
  buildOutline,
  compareMatches,
  comparePos,
  type RawMatch,
  type RuleLang,
  ruleOf,
} from "../outline.js";
import { type EngineRunResult, engineEnv, runEngine } from "../run.js";

export type { RawMatch } from "../outline.js";

export interface AstGrepFacts {
  defs: OutlineDef[];
  calls: CallFact[];
  imports: ImportFact[];
  computed: Array<{ file: string; line: number }>;
}

// The extensions the rules' files: globs scan, which are hakutaku's own for TypeScript,
// JavaScript, Python and shell. ast-grep would also read .zsh or .bzl files by default.
const SCANNED = new Set([
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".pyi",
  ".sh",
  ".bash",
]);

// Every ignore file is ignored: an analysed repo's .gitignore or .ignore must not hide a file.
const NO_IGNORE = ["hidden", "dot", "exclude", "global", "parent", "vcs"];

const TIMEOUT_MS = 600_000;
const DEEP_TIMEOUT_MS = 3_600_000;
// The stream is parsed in blocks of about this many characters, never read whole: every
// match repeats its text, so the file can pass V8's longest string on a large repo.
const BLOCK_CHARS = 16 * 1024 * 1024;
const LINE_CACHE = 16;

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

export const astGrepDriver: EngineDriver<AstGrepFacts> = {
  name: "ast-grep",
  minDetail: "quick",
  applies: (ctx) => {
    const skipped = new Set(ctx.manifest.metadataOnly.map((m) => m.path));
    return ctx.manifest.tree.some(
      (e) =>
        (e.mode === "100644" || e.mode === "100755") &&
        scanned(e.path) &&
        !skipped.has(e.path),
    );
  },
  run: runAstGrep,
};

const scanned = (path: string): boolean => SCANNED.has(posix.extname(path));

// The --globs value that keeps one snapshot file out of the scan. ast-grep roots its globs at
// its working directory, the work directory, and matches a path outside it whole, so a
// repo-relative glob never matches a snapshot file (probed); this one names the file by its
// absolute path under a leading **, every glob character escaped.
export function excludeGlob(snapshotDir: string, path: string): string {
  return `!**${escapeGlob(snapshotDir)}/${escapeGlob(path)}`;
}

const escapeGlob = (s: string): string => s.replace(/[\\*?[\]{}]/g, "\\$&");

async function runAstGrep(ctx: ExtractContext): Promise<AstGrepFacts> {
  const snapshotDir = resolve(ctx.snapshotDir);
  const workDir = resolve(ctx.workDir);
  // ast-grep reports a missing path on stderr and exits 0, as if nothing matched.
  if (!isDirectory(snapshotDir)) {
    throw new Error(`ast-grep failed: no snapshot directory at ${snapshotDir}`);
  }
  const bin = resolveBin(
    ctx.enginesDir,
    readLock().lock.engines["ast-grep"].bin,
  );
  // T5: metadata-only files stay out of the engine's input. Only files the rules scan need a
  // glob, which keeps the command short.
  const metadataOnly = new Set(ctx.manifest.metadataOnly.map((m) => m.path));
  const globs = [...metadataOnly]
    .filter(scanned)
    .flatMap((path) => ["--globs", excludeGlob(snapshotDir, path)]);
  const argv = [
    bin,
    "scan",
    "--config",
    join(resolve(ctx.exportDir), "sgconfig.yml"),
    "--json=stream",
    ...NO_IGNORE.flatMap((kind) => ["--no-ignore", kind]),
    ...globs,
    snapshotDir,
  ];
  const timeoutMs = ctx.detail === "deep" ? DEEP_TIMEOUT_MS : TIMEOUT_MS;
  const out = join(workDir, "ast-grep.jsonl");
  try {
    const result = await runEngine({
      engine: "ast-grep",
      argv,
      cwd: workDir,
      env: engineEnv(ctx, false),
      timeoutMs,
      stdoutFile: out,
    });
    const failure = failureOf(result, timeoutMs);
    if (failure !== null) throw new Error(`ast-grep failed: ${failure}`);
    const matches = await readMatches(out, snapshotDir);
    for (const match of matches) {
      if (metadataOnly.has(match.file)) {
        throw new Error(
          `ast-grep failed: it scanned ${match.file}, which is metadata-only, so its --globs did not keep it out`,
        );
      }
    }
    return astGrepFacts(matches);
  } finally {
    rmSync(out, { force: true });
  }
}

// Why a run failed, or null. Every non-zero exit is a failure, since the rules keep
// ast-grep's default severity and a scan that matches nothing exits 0; so is an ERROR line
// on stderr, which is how ast-grep reports a path it could not read.
function failureOf(r: EngineRunResult, timeoutMs: number): string | null {
  const tail = r.stderrTail.trim();
  if (r.timedOut) {
    return `timed out after ${timeoutMs / 1000} s${tail === "" ? "" : `\n${tail}`}`;
  }
  if (r.exitCode !== 0) {
    if (tail !== "") return tail;
    return r.signal !== null
      ? `stopped by ${r.signal}`
      : `exit code ${r.exitCode}`;
  }
  return /^ERROR/m.test(tail) ? tail : null;
}

async function readMatches(
  path: string,
  snapshotDir: string,
): Promise<RawMatch[]> {
  const rawLine = snapshotLines(snapshotDir);
  const matches: RawMatch[] = [];
  let block: string[] = [];
  let size = 0;
  const flush = (): void => {
    for (const m of parseAstGrepStream(
      block.join("\n"),
      snapshotDir,
      rawLine,
    )) {
      matches.push(m);
    }
    block = [];
    size = 0;
  };
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    block.push(line);
    size += line.length;
    if (size >= BLOCK_CHARS) flush();
  }
  flush();
  return matches.sort(compareMatches);
}

// The raw bytes of a snapshot file's lines, without their line feeds. A few files are kept,
// since ast-grep writes one file's matches together.
function snapshotLines(
  snapshotDir: string,
): (file: string, line0: number) => Uint8Array {
  const cache = new Map<string, { bytes: Uint8Array; starts: number[] }>();
  return (file, line0) => {
    let entry = cache.get(file);
    if (entry === undefined) {
      const bytes = readFileSync(join(snapshotDir, file));
      const starts = [0];
      for (let i = 0; i < bytes.length; i++)
        if (bytes[i] === 0x0a) starts.push(i + 1);
      entry = { bytes, starts };
      if (cache.size >= LINE_CACHE)
        cache.delete(cache.keys().next().value as string);
      cache.set(file, entry);
    }
    const start = entry.starts[line0];
    if (start === undefined) {
      throw new Error(
        `ast-grep reported line ${line0 + 1} of ${file}, past its end`,
      );
    }
    const next = entry.starts[line0 + 1];
    return entry.bytes.subarray(
      start,
      next === undefined ? entry.bytes.length : next - 1,
    );
  };
}

// The matches in a block of ast-grep's stream, sorted by file, start and rule id. Each line
// is one match; a blank line is skipped. A definition's name line is read with rawLine.
export function parseAstGrepStream(
  jsonl: string,
  snapshotDir: string,
  rawLine: (file: string, line0: number) => Uint8Array,
): RawMatch[] {
  const prefix = `${snapshotDir.replace(/\/+$/, "")}/`;
  const out: RawMatch[] = [];
  for (const line of jsonl.split("\n")) {
    if (line.trim() !== "") out.push(parseLine(line, prefix, rawLine));
  }
  return out.sort(compareMatches);
}

function parseLine(
  line: string,
  prefix: string,
  rawLine: (file: string, line0: number) => Uint8Array,
): RawMatch {
  const notAMatch = (): Error =>
    new Error(
      `ast-grep wrote a line that is not a match: ${line.slice(0, 200)}`,
    );
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw notAMatch();
  }
  if (!isRecord(value)) throw notAMatch();
  const { ruleId, file, range, metaVariables } = value;
  const span = spanOf(range);
  if (typeof ruleId !== "string" || typeof file !== "string" || span === null) {
    throw notAMatch();
  }
  const rule = ruleOf(ruleId);
  const path = file.slice(prefix.length);
  if (
    !file.startsWith(prefix) ||
    path.split("/").some((s) => s === "" || s === "." || s === "..")
  ) {
    throw new Error(`ast-grep reported a file outside the snapshot: ${file}`);
  }
  const vars: RawMatch["vars"] = {};
  if (metaVariables !== undefined) {
    // A match with no capture has no metaVariables.
    if (!isRecord(metaVariables)) throw notAMatch();
    const single = metaVariables.single ?? {};
    if (!isRecord(single)) throw notAMatch();
    for (const [name, capture] of Object.entries(single)) {
      if (!isRecord(capture) || typeof capture.text !== "string")
        throw notAMatch();
      const at = spanOf(capture.range);
      if (at === null) throw notAMatch();
      vars[name] = { text: capture.text, ...at };
    }
  }
  const nameLine =
    rule.role === "def"
      ? lineText(rawLine(path, (vars.NAME?.start.line ?? span.start.line) - 1))
      : "";
  return {
    ruleId,
    file: path,
    start: span.start,
    end: span.end,
    vars,
    nameLine,
  };
}

function spanOf(range: unknown): { start: Pos; end: Pos } | null {
  if (!isRecord(range)) return null;
  const start = posOf(range.start);
  const end = posOf(range.end);
  return start === null || end === null ? null : { start, end };
}

function posOf(p: unknown): Pos | null {
  if (!isRecord(p)) return null;
  const { line, column } = p;
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column)) return null;
  if ((line as number) < 0 || (column as number) < 0) return null;
  return { line: (line as number) + 1, col: (column as number) + 1 };
}

// A line as the store decodes text: UTF-8 with U+FFFD for invalid bytes, a byte order mark
// kept, and the CR of a CRLF ending dropped.
function lineText(bytes: Uint8Array): string {
  const text = decoder.decode(bytes);
  return text.endsWith("\r") ? text.slice(0, -1) : text;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// The facts of a list of matches: the outline, then the call sites and the import statements
// in file and position order. A binding match joins the import statement whose match holds
// it; a computed import counts by its line only.
export function astGrepFacts(matches: readonly RawMatch[]): AstGrepFacts {
  const sorted = [...matches].sort(compareMatches);
  const calls: CallFact[] = [];
  const imports: ImportFact[] = [];
  const computed: Array<{ file: string; line: number }> = [];
  const statements = new Map<
    string,
    Array<{ match: RawMatch; fact: ImportFact }>
  >();
  const bindings: RawMatch[] = [];
  for (const match of sorted) {
    const rule = ruleOf(match.ruleId);
    if (rule.role === "call") {
      const name = capture(match, "NAME");
      calls.push({
        file: match.file,
        at: name.start,
        callee: name.text,
        receiver: match.vars.RECV?.text ?? null,
      });
      continue;
    }
    if (rule.role !== "import") continue;
    if (rule.what === "computed") {
      computed.push({ file: match.file, line: match.start.line });
      continue;
    }
    if (
      rule.what === "name" ||
      rule.what === "default" ||
      rule.what === "namespace"
    ) {
      bindings.push(match);
      continue;
    }
    const spec = capture(match, "SPEC");
    const specifier = specifierOf(rule.lang, rule.what, spec.text);
    if (specifier === null) continue;
    const fact: ImportFact = {
      file: match.file,
      at: spec.start,
      endLine: lastLine(match),
      specifier,
      kind: rule.what as ImportKind,
      names: [],
    };
    imports.push(fact);
    const list = statements.get(match.file);
    if (list === undefined) statements.set(match.file, [{ match, fact }]);
    else list.push({ match, fact });
  }
  for (const binding of bindings) {
    const owner = ownerOf(statements.get(binding.file) ?? [], binding);
    if (owner !== null) owner.fact.names.push(bindingName(binding));
  }
  return { defs: buildOutline(sorted), calls, imports, computed };
}

function capture(match: RawMatch, name: string): RawMatch["vars"][string] {
  const v = match.vars[name];
  if (v === undefined) {
    throw new Error(
      `ast-grep rule ${match.ruleId} matched no $${name} at ${match.file}:${match.start.line}`,
    );
  }
  return v;
}

// The last line a match covers: an exclusive end at column 1 ends on the line before.
const lastLine = (m: RawMatch): number =>
  m.end.col === 1 && m.end.line > m.start.line ? m.end.line - 1 : m.end.line;

// The statement holding a binding: the last one, in position order, that starts at or before
// it, when its range holds it. Statements never nest. A binding outside every statement, as
// tree-sitter may leave in code that does not parse, joins none.
function ownerOf<T extends { match: RawMatch }>(
  list: readonly T[],
  binding: RawMatch,
): T | null {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (comparePos((list[mid] as T).match.start, binding.start) <= 0)
      lo = mid + 1;
    else hi = mid;
  }
  const owner = list[lo - 1];
  if (owner === undefined) return null;
  return comparePos(binding.end, owner.match.end) <= 0 ? owner : null;
}

function bindingName(binding: RawMatch): string {
  const { lang, what } = ruleOf(binding.ruleId);
  if (what === "default") return "default";
  if (what === "namespace") return "*";
  const text = capture(binding, "NAMES").text;
  // a TS string name, import { "a-b" as ab }; a Python name is a plain identifier, or *
  return lang !== "py" && isQuoted(text) ? cookJs(text.slice(1, -1)) : text;
}

const isQuoted = (text: string): boolean =>
  text.length >= 2 &&
  (text[0] === '"' || text[0] === "'") &&
  text.endsWith(text[0]);

// A specifier as its module system reads it: a string's value, a Python module name without
// white space, or a shell word as the shell would pass it. null for a shell argument that
// expands at run time, which names no file the snapshot could resolve.
function specifierOf(
  lang: RuleLang,
  what: string,
  text: string,
): string | null {
  if (lang === "sh") return shellWord(text);
  if (lang === "py") {
    if (what === "dynamic") return pythonString(text);
    return text.replace(/\\\r?\n|\s+/g, "");
  }
  // a string or a template without substitutions: one delimiter at each end
  return cookJs(text.slice(1, -1));
}

// The value of a JavaScript string's or a substitution-free template's contents.
function cookJs(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = body[++i];
    if (e === undefined) break;
    switch (e) {
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "\t";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "v":
        out += "\v";
        break;
      case "0":
        out += "\0";
        break;
      case "x": {
        out += String.fromCodePoint(
          Number.parseInt(body.slice(i + 1, i + 3), 16) || 0,
        );
        i += 2;
        break;
      }
      case "u": {
        if (body[i + 1] === "{") {
          const close = body.indexOf("}", i);
          if (close < 0) {
            // no closing brace, which tree-sitter still parses as a string: the rest stays
            // as written (a loop index of -1 would cook the string again forever)
            return out + body.slice(i - 1);
          }
          out += codePoint(body.slice(i + 2, close));
          i = close;
        } else {
          out += String.fromCharCode(
            Number.parseInt(body.slice(i + 1, i + 5), 16) || 0,
          );
          i += 4;
        }
        break;
      }
      case "\r":
        if (body[i + 1] === "\n") i++;
        break;
      case "\n":
        break;
      default:
        // a backslash before U+2028 or U+2029 continues the line, as one before a line feed
        if (e !== LINE_SEPARATOR && e !== PARAGRAPH_SEPARATOR) out += e;
    }
  }
  return out;
}

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

function codePoint(hex: string): string {
  const n = Number.parseInt(hex, 16);
  return Number.isSafeInteger(n) && n >= 0 && n <= 0x10ffff
    ? String.fromCodePoint(n)
    : "";
}

// A plain Python string literal's value: an r or u prefix, single or triple quotes. The rules
// keep b and f strings out. An escape Python does not know keeps its backslash, as in Python.
function pythonString(text: string): string {
  const raw = /^[rR]/.test(text);
  const quoted = text.replace(/^[rRuU]/, "");
  const q = quoted.startsWith('"""') || quoted.startsWith("'''") ? 3 : 1;
  const body = quoted.slice(q, quoted.length - q);
  return raw ? body : body.replace(PY_ESCAPE, pythonEscape);
}

// A backslash and a line end, a one-character escape, 1 to 3 octal digits, or x, u or U with
// 2, 4 or 8 hex digits.
const PY_ESCAPE =
  /\\(\r\n|[\n\\'"abfnrtv]|[0-7]{1,3}|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})/g;

const PY_SIMPLE: Record<string, string> = {
  "\r\n": "",
  "\n": "",
  "\\": "\\",
  "'": "'",
  '"': '"',
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

function pythonEscape(written: string, e: string): string {
  const simple = PY_SIMPLE[e];
  if (simple !== undefined) return simple;
  const n = /^[xuU]/.test(e)
    ? Number.parseInt(e.slice(1), 16)
    : Number.parseInt(e, 8);
  return n <= 0x10ffff ? String.fromCodePoint(n) : written;
}

// A shell word without expansions, as the shell passes it: a single-quoted string's
// contents, a double-quoted string's with \\ \" \$ and \` unescaped, or a bare word with its
// backslashes removed. null for anything that expands (a $, a backtick, a glob character, a
// leading ~, or quotes inside a word).
function shellWord(text: string): string | null {
  if (/^'[^']*'$/.test(text)) return text.slice(1, -1);
  if (/^"(?:[^"\\$`]|\\.)*"$/s.test(text)) {
    return text
      .slice(1, -1)
      .replace(/\\([\\"$`\n])/g, (_, e: string) => (e === "\n" ? "" : e));
  }
  if (
    /^(?:[^\s$`"'*?[\]{}()<>|&;\\~]|\\.)(?:[^\s$`"'*?[\]{}()<>|&;\\]|\\.)*$/s.test(
      text,
    )
  ) {
    return text.replace(/\\(.)/gs, "$1");
  }
  return null;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
