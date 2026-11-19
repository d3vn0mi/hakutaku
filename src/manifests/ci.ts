// CI (§5.7): every run: line of .github/workflows/*.yml and *.yaml and of .gitlab-ci.yml, read
// line by line without a YAML parser, its commands from the repo top. An inline value is one
// command line, unquoted; a | or > block is a command line per line, each with its own line
// number; a run: with nothing after it (a mapping, such as defaults.run) is no command. Kind
// ci, named by the command line.
import { commandFiles, relativeTo } from "./commands.js";
import type { EntryFact, ReadContext } from "./types.js";

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
// "run:" as a key at the start of a line, or of a sequence entry; group 1 ends where "run"
// starts, group 2 is its value
const RUN = /^(\s*(?:-\s+)?)run:(?:\s+(.*))?$/;
const BLOCK = /^[|>][-+0-9]*\s*(?:#.*)?$/;

// An inline scalar's text: a quoted one unquoted, a plain one without its comment.
function scalar(value: string): string {
  const text = value.trim();
  if (text.startsWith("'")) {
    const end = text.lastIndexOf("'");
    return end > 0 ? text.slice(1, end).replaceAll("''", "'") : text.slice(1);
  }
  if (text.startsWith('"')) {
    const end = text.lastIndexOf('"');
    const quoted = end > 0 ? text.slice(0, end + 1) : `${text}"`;
    try {
      return String(JSON.parse(quoted));
    } catch {
      return quoted.slice(1, -1);
    }
  }
  const comment = text.search(/\s#/);
  return (comment === -1 ? text : text.slice(0, comment)).trim();
}

const indentOf = (line: string): number =>
  line.length - line.trimStart().length;

// Each run: command line of a workflow, with the line it is on.
export function runLines(
  text: string,
): Array<{ command: string; line: number }> {
  const lines = text
    .split("\n")
    .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const out: Array<{ command: string; line: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = RUN.exec(lines[i] ?? "");
    if (m === null) continue;
    const value = (m[2] ?? "").trim();
    if (value === "") continue;
    if (!BLOCK.test(value)) {
      const command = scalar(value);
      if (command !== "") out.push({ command, line: i + 1 });
      continue;
    }
    // the block: every following line deeper than the key, and the blank lines among them
    const key = (m[1] ?? "").length;
    for (; i + 1 < lines.length; i++) {
      const next = lines[i + 1] ?? "";
      if (next.trim() === "") continue;
      if (indentOf(next) <= key) break;
      out.push({ command: next.trim(), line: i + 2 });
    }
  }
  return out;
}

export function readCi(ctx: ReadContext): EntryFact[] {
  const facts: EntryFact[] = [];
  const resolve = relativeTo("", ctx.named);
  for (const manifest of ctx.input.paths) {
    if (!WORKFLOW.test(manifest) && manifest !== ".gitlab-ci.yml") continue;
    const text = ctx.input.read(manifest);
    if (text === null) continue;
    for (const { command, line } of runLines(text)) {
      for (const file of commandFiles(
        command,
        resolve,
        ctx.input.pythonModules,
      )) {
        facts.push({
          file,
          qualname: null,
          kind: "ci",
          manifest,
          line,
          name: command,
        });
      }
    }
  }
  return facts;
}
