// INI, read as data: setup.cfg and systemd units. Nothing in it runs, and nothing in it is an
// error.
//
// - "[section]" names the section of the keys after it: the text between the line's first "["
//   and its last "]". Keys before any section are in the section "".
// - "key = value", "key: value" and systemd's "Key=value": the key ends at the line's first "="
//   or ":", and both sides are trimmed. Keys keep their case. Any other line is skipped.
// - A line indented deeper than its key's line goes on with the key's value, after a "\n", as
//   in setup.cfg. Blank and comment lines inside a value stay in it as empty lines, so part n of
//   a value split at "\n" is line `line + n` of the text.
// - "#" and ";" start a comment only as the first character of a line after white space, as in
//   configparser and systemd; later on a line they are part of the value.
// - Repeated keys stay, in file order. Lines end at LF; a CR before it goes with the white space
//   trimmed from each line, and a leading byte order mark is skipped. A backslash at the end of
//   a line is kept as written.

export function parseIni(
  text: string,
): Array<{ section: string; key: string; value: string; line: number }> {
  const lines = (text.startsWith("\uFEFF") ? text.slice(1) : text).split("\n");
  const entries: ReturnType<typeof parseIni> = [];
  let section = "";
  // The entry whose value a deeper line goes on with: its key line's indent, and the last line
  // of its value.
  let open: {
    entry: (typeof entries)[number];
    indent: number;
    last: number;
  } | null = null;
  for (const [i, raw] of lines.entries()) {
    const line = i + 1;
    const body = raw.trim();
    if (body === "" || body.startsWith("#") || body.startsWith(";")) continue;
    const indent = raw.length - raw.trimStart().length;
    if (open !== null && indent > open.indent) {
      open.entry.value += "\n".repeat(line - open.last) + body;
      open.last = line;
      continue;
    }
    open = null;
    const close = body.lastIndexOf("]");
    if (body.startsWith("[") && close > 1) {
      section = body.slice(1, close);
      continue;
    }
    const at = body.search(/[=:]/);
    if (at <= 0) continue; // no "=" or ":", or no key before it
    const entry = {
      section,
      key: body.slice(0, at).trimEnd(),
      value: body.slice(at + 1).trim(),
      line,
    };
    entries.push(entry);
    open = { entry, indent, last: line };
  }
  return entries;
}
