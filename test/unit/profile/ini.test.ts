import { expect, it } from "vitest";
import { parseIni } from "../../../src/profile/index.js";

it("reads setup.cfg continuation lines and repeated unit keys", () => {
  expect(
    parseIni(
      "[options.entry_points]\nconsole_scripts =\n    ephemeris = observatory.ephemeris.cli:main\n",
    ),
  ).toEqual([
    {
      section: "options.entry_points",
      key: "console_scripts",
      value: "\nephemeris = observatory.ephemeris.cli:main",
      line: 2,
    },
  ]);
  expect(
    parseIni(
      "[Service]\nExecStartPre=/bin/true\nExecStartPre=/bin/false\n",
    ).map((e) => e.line),
  ).toEqual([2, 3]);
  // both keys stay, in file order, with their own values
  expect(
    parseIni("[Service]\nExecStartPre=/bin/true\nExecStartPre=/bin/false\n"),
  ).toStrictEqual([
    { section: "Service", key: "ExecStartPre", value: "/bin/true", line: 2 },
    { section: "Service", key: "ExecStartPre", value: "/bin/false", line: 3 },
  ]);
});

it("reads key = value, key: value and Key=value, splitting at the first = or :, and skips comments", () =>
  expect(
    parseIni(
      [
        "# observatory",
        "; units too",
        "[metadata]",
        "name = observatory",
        "version: 0.1",
        "url = https://example.org/sky",
        "time: 07:30",
        "a:b = c",
        "[Service]",
        "ExecStart=/srv/observatory/scripts/sync-sky.sh --at=dawn",
        'Environment="SKY=clear"',
        "  # an indented comment",
        "Description = Sync the sky # not a comment",
      ].join("\n"),
    ),
  ).toStrictEqual([
    { section: "metadata", key: "name", value: "observatory", line: 4 },
    { section: "metadata", key: "version", value: "0.1", line: 5 },
    {
      section: "metadata",
      key: "url",
      value: "https://example.org/sky",
      line: 6,
    },
    { section: "metadata", key: "time", value: "07:30", line: 7 },
    { section: "metadata", key: "a", value: "b = c", line: 8 },
    {
      section: "Service",
      key: "ExecStart",
      value: "/srv/observatory/scripts/sync-sky.sh --at=dawn",
      line: 10,
    },
    {
      section: "Service",
      key: "Environment",
      value: '"SKY=clear"',
      line: 11,
    },
    {
      section: "Service",
      key: "Description",
      value: "Sync the sky # not a comment",
      line: 13,
    },
  ]));

it("keeps blank and comment lines inside a value as empty lines, so line n of a value is the key's line + n", () => {
  const text = [
    "[options.entry_points]",
    "console_scripts =",
    "    ephemeris = observatory.ephemeris.cli:main",
    "",
    "    # rebuild = observatory.tools.rebuild:run",
    "    skyctl = skyctl:main",
    "",
    "gui_scripts = viewer = observatory.viewer:main",
  ].join("\n");
  const entries = parseIni(text);
  expect(entries).toStrictEqual([
    {
      section: "options.entry_points",
      key: "console_scripts",
      value:
        "\nephemeris = observatory.ephemeris.cli:main\n\n\nskyctl = skyctl:main",
      line: 2,
    },
    {
      section: "options.entry_points",
      key: "gui_scripts",
      value: "viewer = observatory.viewer:main",
      line: 8,
    },
  ]);
  const lines = text.split("\n");
  for (const entry of entries) {
    for (const [n, part] of entry.value.split("\n").entries()) {
      if (n > 0 && part !== "") {
        expect(lines[entry.line - 1 + n]?.trim()).toBe(part);
      }
    }
  }
});

it("ends a value at a line no deeper than its key's, and at a section header", () =>
  expect(
    parseIni(
      [
        "[s]",
        "  a = 1",
        "    more",
        "  b = 2",
        "c = 3",
        "  d = 4",
        "[t]",
        "  e = 5",
      ].join("\n"),
    ),
  ).toStrictEqual([
    { section: "s", key: "a", value: "1\nmore", line: 2 },
    { section: "s", key: "b", value: "2", line: 4 },
    { section: "s", key: "c", value: "3\nd = 4", line: 5 },
    { section: "t", key: "e", value: "5", line: 8 },
  ]));

it('keeps keys before any section in the section "", and skips lines it cannot read', () =>
  expect(
    parseIni(
      [
        "top = 1",
        "[s]",
        "k = v",
        "no delimiter here",
        "    indented = after a line that is not read",
        "= no key",
        "[]",
        "x = 1",
      ].join("\n"),
    ),
  ).toStrictEqual([
    { section: "", key: "top", value: "1", line: 1 },
    { section: "s", key: "k", value: "v", line: 3 },
    {
      section: "s",
      key: "indented",
      value: "after a line that is not read",
      line: 5,
    },
    { section: "s", key: "x", value: "1", line: 8 },
  ]));

// The byte order mark is no indent: the first key's own line starts at column 1.
it("reads a byte order mark and CRLF line ends", () =>
  expect(
    parseIni(
      "\uFEFFtop = 1\r\n more\r\n[Unit]\r\nDescription=Sky sync\r\n  continued\r\n",
    ),
  ).toStrictEqual([
    { section: "", key: "top", value: "1\nmore", line: 1 },
    {
      section: "Unit",
      key: "Description",
      value: "Sky sync\ncontinued",
      line: 4,
    },
  ]));

it("never throws, and reads 1 MiB of hostile text in one pass", () => {
  const mib = 1 << 20;
  expect(parseIni("[".repeat(mib))).toStrictEqual([]);
  expect(parseIni("=".repeat(mib))).toStrictEqual([]);
  expect(parseIni(`k =\n${"\n".repeat(mib)}  x\n`)).toStrictEqual([
    { section: "", key: "k", value: `${"\n".repeat(mib + 1)}x`, line: 1 },
  ]);
  const pairs = Math.floor(mib / 12);
  expect(parseIni("k = v\n  # c\n".repeat(pairs))).toHaveLength(pairs);
});
