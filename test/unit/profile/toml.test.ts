import { expect, it } from "vitest";
import { parseTomlSubset } from "../../../src/profile/index.js";

it("reads the pyproject tables hakutaku uses and nulls the rest", () => {
  const t = parseTomlSubset(
    [
      "[project.scripts]",
      'ephemeris = "observatory.ephemeris.cli:main"',
      '[project.entry-points."observatory.plugins"]',
      "aurora = 'observatory.plugins.aurora:load'",
      "[tool.poetry.scripts]",
      'rebuild = "observatory.tools.rebuild:run"',
      "[tool.setuptools]",
      'py-modules = [\n  "skyctl",\n]',
      "released = 2026-01-01",
    ].join("\n"),
  );
  expect(t).toEqual({
    project: {
      scripts: { ephemeris: "observatory.ephemeris.cli:main" },
      "entry-points": {
        "observatory.plugins": { aurora: "observatory.plugins.aurora:load" },
      },
    },
    tool: {
      poetry: { scripts: { rebuild: "observatory.tools.rebuild:run" } },
      setuptools: { "py-modules": ["skyctl"], released: null },
    },
  });
});

it("reads basic, literal and multi-line strings by TOML's rules", () => {
  const t = parseTomlSubset(
    [
      String.raw`basic = "tab\tquote\" back\\ e\u00e9 scope\U0001F52D"`,
      String.raw`literal = 'C:\sky\maps'`,
      'multi = """',
      "first",
      'second"""',
      'folded = """\\',
      "    The quick \\",
      '    sky."""',
      'quotes = """"quoted" and ""two"""""',
      "raw = '''",
      String.raw`kept \n as written`,
      "'''",
      "single = '''it's'''",
      "empty = ''",
    ].join("\n"),
  );
  expect(t).toStrictEqual({
    basic: 'tab\tquote" back\\ e\u00e9 scope\u{1F52D}',
    literal: "C:\\sky\\maps",
    multi: "first\nsecond",
    folded: "The quick sky.",
    quotes: '"quoted" and ""two""',
    raw: "kept \\n as written\n",
    single: "it's",
    empty: "",
  });
});

it("reads integers and booleans, and nulls every other scalar", () => {
  const t = parseTomlSubset(
    [
      "dec = +1_000",
      "neg = -17",
      "hex = 0xDEAD_beef",
      "oct = 0o755",
      "bin = 0b1101",
      "zero = -0",
      "max = 9_007_199_254_740_991",
      "big = 9_007_199_254_740_992",
      "lead = 012",
      "signedhex = +0x1F",
      "float = 3.14",
      "exp = 1e6",
      "inf = inf",
      "nan = -nan",
      "date = 1979-05-27",
      "stamp = 1979-05-27 07:32:00Z",
      "local = 07:32:00",
      "yes = true",
      "no = false",
      "word = maybe",
    ].join("\n"),
  );
  expect(t).toStrictEqual({
    dec: 1000,
    neg: -17,
    hex: 0xdeadbeef,
    oct: 0o755,
    bin: 0b1101,
    zero: 0,
    max: Number.MAX_SAFE_INTEGER,
    big: null,
    lead: null,
    signedhex: null,
    float: null,
    exp: null,
    inf: null,
    nan: null,
    date: null,
    stamp: null,
    local: null,
    yes: true,
    no: false,
    word: null,
  });
});

it("reads arrays, inline tables, dotted keys and array tables", () => {
  const t = parseTomlSubset(
    [
      'title.main = "sky"',
      'arr = [ 1, [2, "x"], { a = 1, b.c = 2 }, 1.5, ]  # a comment',
      "multi = [",
      "  # a comment line",
      '  "a",  # after an element',
      '  "b",',
      "]",
      "empty = []",
      "inline = {}",
      "[[plugins]]",
      'name = "aurora"',
      "[plugins.load]",
      'at = "boot"',
      "[[plugins]]",
      'name = "nova"',
      "[ a . \"b.c\" . 'd' ]",
      "e = 1",
    ].join("\n"),
  );
  expect(t).toStrictEqual({
    title: { main: "sky" },
    arr: [1, [2, "x"], { a: 1, b: { c: 2 } }, null],
    multi: ["a", "b"],
    empty: [],
    inline: {},
    plugins: [{ name: "aurora", load: { at: "boot" } }, { name: "nova" }],
    a: { "b.c": { d: { e: 1 } } },
  });
});

it("keeps the first value of a duplicate key, and never writes through a value", () => {
  const t = parseTomlSubset(
    [
      'name = "first"',
      'name = "second"',
      "name.sub = 1",
      "[tool]",
      "x = 1",
      "[tool]",
      "x = 2",
      "y = 3",
      "[name]",
      "lost = 1",
      "[[tool]]",
      "lost = 2",
      "[[runs]]",
      "n = 1",
      "[runs]",
      "lost = 3",
      "[list]",
      "items = [1]",
      "[[list.items]]",
      "lost = 4",
    ].join("\n"),
  );
  expect(t).toStrictEqual({
    name: "first",
    tool: { x: 1, y: 3 },
    runs: [{ n: 1 }],
    list: { items: [1] },
  });
});

it("never steps into an array that [[...]] did not make", () => {
  // through a static array, a header would reach a number or an inline table
  expect(
    parseTomlSubset(["arr = [1]", "[arr.y]", "z = 1"].join("\n")),
  ).toStrictEqual({ arr: [1] });
  expect(
    parseTomlSubset(
      ["tbl = [{ x = 1 }]", "[tbl.y]", "z = 1", "[[tbl.w]]", "q = 2"].join(
        "\n",
      ),
    ),
  ).toStrictEqual({ tbl: [{ x: 1 }] });
});

it("nulls a value it cannot read, and reads on from the next line", () => {
  const t = parseTomlSubset(
    [
      'open = "no end',
      String.raw`bad = "\q"`,
      'after = "x" y',
      'ok = "yes"',
      'arr = [1, "unterminated',
      "next = 2",
      "just words",
      "= 1",
      "[unclosed",
      "lost = 1",
      "[fine]",
      "kept = 1",
      // an unclosed array ends at the first line that cannot go on with it
      "list = [1, 2",
      "[later]",
      "x = 1",
    ].join("\n"),
  );
  expect(t).toStrictEqual({
    open: null,
    bad: null,
    after: null,
    ok: "yes",
    arr: null,
    next: 2,
    fine: { kept: 1, list: null },
    later: { x: 1 },
  });
});

it("makes keys such as __proto__, constructor and toString own keys", () => {
  const t = parseTomlSubset(
    ["__proto__ = 1", "constructor = 2", "[toString]", "x = 3"].join("\n"),
  );
  expect(t).toStrictEqual(
    JSON.parse('{ "__proto__": 1, "constructor": 2, "toString": { "x": 3 } }'),
  );
  expect(Object.keys(t)).toEqual(["__proto__", "constructor", "toString"]);
  expect(Object.getPrototypeOf(t)).toBe(Object.prototype);
});

it("reads a byte order mark and CRLF line ends", () =>
  expect(
    parseTomlSubset('\uFEFFa = """\r\nx\r\ny"""\r\n[t]\r\nb = 1 # sky\r\n'),
  ).toStrictEqual({ a: "x\ny", t: { b: 1 } }));

it("never throws, and reads 1 MiB of hostile text in one pass", () => {
  const mib = 1 << 20;
  expect(parseTomlSubset("a = [\n".repeat(Math.floor(mib / 6)))).toStrictEqual({
    a: null,
  });
  // one array that runs to the end of the text, so a reader that went back to the line after
  // its start would read the rest of the text once per line
  expect(parseTomlSubset(`${"a = [1,\n".repeat(mib / 8)}end`)).toStrictEqual({
    a: null,
  });
  expect(parseTomlSubset(`x = ${"[".repeat(mib)}`)).toStrictEqual({ x: null });
  expect(
    parseTomlSubset(`t = ${"{ a = ".repeat(Math.floor(mib / 6))}`),
  ).toStrictEqual({
    t: null,
  });
  expect(parseTomlSubset("[".repeat(mib))).toStrictEqual({});
  expect(parseTomlSubset(`k${".k".repeat(mib / 2)} = 1`)).toStrictEqual({});
  expect(parseTomlSubset(`s = """${"x\n".repeat(mib / 2)}`)).toStrictEqual({
    s: null,
  });
  expect(parseTomlSubset(`q = """${'"'.repeat(mib)}`)).toStrictEqual({
    q: null,
  });
  expect(parseTomlSubset(`w = a${" ".repeat(mib)}b`)).toStrictEqual({
    w: null,
  });
});
