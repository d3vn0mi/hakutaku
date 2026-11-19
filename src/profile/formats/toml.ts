// A TOML subset, read as data: the tables that pyproject.toml's readers need. Nothing in it runs,
// and nothing in it is an error.
//
// It reads tables [a.b] and [a."b.c"], array tables [[a]], dotted, bare and quoted keys, basic
// and literal strings (multi-line too), arrays (multi-line too), inline tables, booleans, and
// integers (decimal, 0x, 0o and 0b, with "_"). Any other value (a float, a date or time, inf or
// nan, an integer outside the safe range) becomes null.
// - A duplicate key keeps its first value. A header or a dotted key that runs into a value, or
//   into an array that [[...]] did not make, is dropped, with every key under it.
// - A value that cannot be read becomes null, and reading goes on at the next line, or at the
//   line that stopped an unclosed array or inline table. A header that cannot be read drops the
//   keys under it. Reading never goes back before the place a failed read stopped, so any text
//   is read in linear time.
// - It is more lenient than TOML 1.0 in two ways: a header may reopen a table, an inline one
//   too, and an inline table may span lines and end with a comma, as TOML 1.1 allows.
//
// Keys become own properties, so a key such as "__proto__" is data and never a prototype. Arrays
// and inline tables nest at most MAX_DEPTH deep, and a key has at most MAX_DEPTH parts. A leading
// byte order mark is skipped, and CRLF reads as LF, in strings too.

const MAX_DEPTH = 512;

type Table = Record<string, unknown>;

// Where a read stopped.
class Stop {
  constructor(readonly at: number) {}
}

const BARE_KEY = /[A-Za-z0-9_-]+/y;
const BARE_END = new Set([",", "]", "}", "#", "\n"]);
const DEC = /^[+-]?(?:0|[1-9](?:_?[0-9])*)$/;
const HEX = /^0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*$/;
const OCT = /^0o[0-7](?:_?[0-7])*$/;
const BIN = /^0b[01](?:_?[01])*$/;
const HEX_DIGITS = /^[0-9A-Fa-f]*$/;

const ESCAPES: Readonly<Record<string, string>> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  '"': '"',
  "\\": "\\",
};

const define = (target: Table, key: string, value: unknown): void => {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
};

const isTable = (v: unknown): v is Table =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// A bare value: true, false or a safe integer; null for anything else.
function scalarOf(token: string): boolean | number | null {
  if (token === "true") return true;
  if (token === "false") return false;
  if (
    !(DEC.test(token) || HEX.test(token) || OCT.test(token) || BIN.test(token))
  ) {
    return null;
  }
  const n = Number(token.replaceAll("_", ""));
  if (!Number.isSafeInteger(n)) return null;
  return n === 0 ? 0 : n; // -0 reads as 0
}

export function parseTomlSubset(text: string): Record<string, unknown> {
  const s = (text.startsWith("\uFEFF") ? text.slice(1) : text).replaceAll(
    "\r\n",
    "\n",
  );
  const root: Table = {};
  // The arrays that [[...]] made, which a later [[...]] adds a table to.
  const arrayTables = new WeakSet<unknown[]>();
  let table: Table = root;
  let pos = 0;

  // Spaces and tabs.
  const ws = (): void => {
    while (s[pos] === " " || s[pos] === "\t") pos++;
  };

  // Spaces, tabs, newlines and comments.
  const blank = (): void => {
    for (;;) {
      const c = s[pos];
      if (c === " " || c === "\t" || c === "\n") {
        pos++;
      } else if (c === "#") {
        const nl = s.indexOf("\n", pos);
        pos = nl === -1 ? s.length : nl;
      } else {
        return;
      }
    }
  };

  // Spaces, tabs and a comment, then a newline or the end of the text.
  const endOfLine = (): void => {
    ws();
    if (s[pos] === "#") {
      const nl = s.indexOf("\n", pos);
      pos = nl === -1 ? s.length : nl;
    }
    if (pos < s.length && s[pos] !== "\n") throw new Stop(pos);
  };

  // The character an escape at pos stands for.
  const escaped = (): string => {
    const c = s[pos + 1] ?? "";
    if (c === "u" || c === "U") {
      const length = c === "u" ? 4 : 8;
      const hex = s.slice(pos + 2, pos + 2 + length);
      const code =
        hex.length === length && HEX_DIGITS.test(hex)
          ? Number.parseInt(hex, 16)
          : -1;
      if (code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        throw new Stop(pos);
      }
      pos += 2 + length;
      return String.fromCodePoint(code);
    }
    if (!Object.hasOwn(ESCAPES, c)) throw new Stop(pos);
    pos += 2;
    return ESCAPES[c] as string;
  };

  // "...": one line, with escapes.
  const basic = (): string => {
    pos++;
    let out = "";
    for (;;) {
      const run = pos;
      while (
        pos < s.length &&
        s[pos] !== '"' &&
        s[pos] !== "\\" &&
        s[pos] !== "\n"
      ) {
        pos++;
      }
      out += s.slice(run, pos);
      if (s[pos] === '"') {
        pos++;
        return out;
      }
      if (s[pos] !== "\\") throw new Stop(pos); // a newline, or the end of the text
      out += escaped();
    }
  };

  // '...': one line, as written.
  const literal = (): string => {
    const start = ++pos;
    while (pos < s.length && s[pos] !== "'" && s[pos] !== "\n") pos++;
    if (s[pos] !== "'") throw new Stop(pos);
    return s.slice(start, pos++);
  };

  // The length of the run of quote characters at `at`. In a multi-line string, a run of three
  // to five ends it, and the quotes before the last three are part of it.
  const run = (quote: string, at: number): number => {
    let n = 0;
    while (s[at + n] === quote) n++;
    return n;
  };

  // """...""": a newline right after the opening quotes is dropped, and a backslash that ends a
  // line drops the newline and the white space after it.
  const multiBasic = (): string => {
    pos += 3;
    if (s[pos] === "\n") pos++;
    let out = "";
    for (;;) {
      const start = pos;
      while (pos < s.length && s[pos] !== '"' && s[pos] !== "\\") pos++;
      out += s.slice(start, pos);
      if (pos >= s.length) throw new Stop(pos);
      if (s[pos] === "\\") {
        let i = pos + 1;
        while (s[i] === " " || s[i] === "\t") i++;
        if (s[i] === "\n") {
          while (s[i] === " " || s[i] === "\t" || s[i] === "\n") i++;
          pos = i;
        } else {
          out += escaped();
        }
        continue;
      }
      const n = run('"', pos);
      if (n > 5) throw new Stop(pos);
      if (n >= 3) {
        pos += n;
        return out + '"'.repeat(n - 3);
      }
      out += '"'.repeat(n);
      pos += n;
    }
  };

  // '''...''': as written, but for a newline right after the opening quotes.
  const multiLiteral = (): string => {
    pos += 3;
    if (s[pos] === "\n") pos++;
    const start = pos;
    const end = s.indexOf("'''", pos);
    if (end === -1) throw new Stop(s.length);
    const n = run("'", end);
    if (n > 5) throw new Stop(end);
    pos = end + n;
    return s.slice(start, end) + "'".repeat(n - 3);
  };

  const simpleKey = (): string => {
    const c = s[pos];
    if (c === '"') return basic();
    if (c === "'") return literal();
    BARE_KEY.lastIndex = pos;
    const bare = BARE_KEY.exec(s);
    if (bare === null) throw new Stop(pos);
    pos += bare[0].length;
    return bare[0];
  };

  // A dotted key. White space may stand around each dot.
  const keyPath = (): string[] => {
    const keys = [simpleKey()];
    for (;;) {
      const save = pos;
      ws();
      if (s[pos] !== ".") {
        pos = save;
        return keys;
      }
      pos++;
      ws();
      if (keys.length === MAX_DEPTH) throw new Stop(pos);
      keys.push(simpleKey());
    }
  };

  // The table under key in t, made when it is absent. Through an array that [[...]] made, its
  // last table, when intoArrays. Null when the key holds anything else.
  const step = (t: Table, key: string, intoArrays: boolean): Table | null => {
    if (!Object.hasOwn(t, key)) {
      const made: Table = {};
      define(t, key, made);
      return made;
    }
    const v = t[key];
    if (isTable(v)) return v;
    if (intoArrays && Array.isArray(v) && arrayTables.has(v)) {
      return v[v.length - 1] as Table;
    }
    return null;
  };

  // Sets a dotted key in t, unless a value stands in its way or it already has one.
  const assign = (t: Table, keys: readonly string[], v: unknown): void => {
    let at: Table | null = t;
    for (const key of keys.slice(0, -1)) {
      at = step(at, key, false);
      if (at === null) return;
    }
    const last = keys[keys.length - 1] ?? "";
    if (!Object.hasOwn(at, last)) define(at, last, v);
  };

  // A value at pos, inside `depth` arrays and inline tables.
  const value = (depth: number): unknown => {
    const c = s[pos];
    if (c === '"') return s.startsWith('"""', pos) ? multiBasic() : basic();
    if (c === "'") return s.startsWith("'''", pos) ? multiLiteral() : literal();
    if (c === "[") return array(depth + 1);
    if (c === "{") return inline(depth + 1);
    // A bare value runs to a comma, a bracket, a brace, a comment or the end of its line.
    const start = pos;
    while (pos < s.length && !BARE_END.has(s[pos] ?? "")) pos++;
    let end = pos;
    while (end > start && (s[end - 1] === " " || s[end - 1] === "\t")) end--;
    if (end === start) throw new Stop(start);
    return scalarOf(s.slice(start, end));
  };

  const array = (depth: number): unknown[] => {
    if (depth > MAX_DEPTH) throw new Stop(pos);
    pos++;
    const out: unknown[] = [];
    for (;;) {
      blank();
      // after "[", or after a comma, which may trail
      if (s[pos] === "]") {
        pos++;
        return out;
      }
      out.push(value(depth));
      blank();
      if (s[pos] === "]") {
        pos++;
        return out;
      }
      if (s[pos] !== ",") throw new Stop(pos);
      pos++;
    }
  };

  const inline = (depth: number): Table => {
    if (depth > MAX_DEPTH) throw new Stop(pos);
    pos++;
    const out: Table = {};
    for (;;) {
      blank();
      // after "{", or after a comma, which may trail
      if (s[pos] === "}") {
        pos++;
        return out;
      }
      const keys = keyPath();
      ws();
      if (s[pos] !== "=") throw new Stop(pos);
      pos++;
      ws();
      assign(out, keys, value(depth));
      blank();
      if (s[pos] === "}") {
        pos++;
        return out;
      }
      if (s[pos] !== ",") throw new Stop(pos);
      pos++;
    }
  };

  // [a.b] or [[a.b]]. Until it is read whole, the keys after it go to a table nobody keeps.
  const header = (): void => {
    const many = s[pos + 1] === "[";
    table = {};
    pos += many ? 2 : 1;
    ws();
    const keys = keyPath();
    ws();
    if (many ? !s.startsWith("]]", pos) : s[pos] !== "]") throw new Stop(pos);
    pos += many ? 2 : 1;
    endOfLine();
    let t: Table | null = root;
    for (const key of keys.slice(0, -1)) {
      t = step(t, key, true);
      if (t === null) return;
    }
    const last = keys[keys.length - 1] ?? "";
    if (!many) {
      table = step(t, last, false) ?? table;
      return;
    }
    if (!Object.hasOwn(t, last)) {
      const made: unknown[] = [];
      arrayTables.add(made);
      define(t, last, made);
    }
    const list = t[last];
    if (Array.isArray(list) && arrayTables.has(list)) {
      const made: Table = {};
      list.push(made);
      table = made;
    }
  };

  // key = value. A value that cannot be read is null.
  const keyValue = (): void => {
    const keys = keyPath();
    ws();
    if (s[pos] !== "=") throw new Stop(pos);
    pos++;
    ws();
    let v: unknown = null;
    let stop: Stop | null = null;
    try {
      v = value(0);
      endOfLine();
    } catch (error) {
      if (!(error instanceof Stop)) throw error;
      v = null;
      stop = error;
    }
    assign(table, keys, v);
    if (stop !== null) throw stop;
  };

  // Where reading goes on after a line that began at `start` stopped at `at`: at `at` itself
  // when it is the first thing on a later line, where an unclosed array or inline table ended;
  // otherwise at the next line.
  const resume = (start: number, at: number): number => {
    let i = at;
    while (i > start && (s[i - 1] === " " || s[i - 1] === "\t")) i--;
    if (i > start && s[i - 1] === "\n") return at;
    const nl = s.indexOf("\n", at);
    return nl === -1 ? s.length : nl + 1;
  };

  for (;;) {
    blank();
    if (pos >= s.length) return root;
    const start = pos;
    try {
      if (s[pos] === "[") header();
      else keyValue();
    } catch (error) {
      if (!(error instanceof Stop)) throw error;
      pos = resume(start, error.at);
    }
  }
}
