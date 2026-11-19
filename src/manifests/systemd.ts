// systemd units (§5.7): every *.service's ExecStart, ExecStartPre, ExecStartPost, ExecReload
// and ExecStop in [Service], read as data. Each command, its -@:+! prefixes stripped, launches
// what commands.ts finds in it, matched by suffix against the tracked paths, so %h/... and
// absolute deploy prefixes do not matter. Kind unit, named after the unit file.
//
// A *.timer starts its service (Unit=, else the same-named .service), and that service's
// entries are read here with the service as their manifest. A timer so adds no fact of its
// own, and no entry appears twice.
import { posix } from "node:path";
import { parseIni } from "../profile/index.js";
import { launchedFiles, splitCommand } from "./commands.js";
import type { EntryFact, ReadContext } from "./types.js";

const EXEC_KEYS: ReadonlySet<string> = new Set([
  "ExecStart",
  "ExecStartPre",
  "ExecStartPost",
  "ExecReload",
  "ExecStop",
]);
const PREFIXES = /^[-@:+!]+/;

// A unit's lines as systemd reads them: each line trimmed, so an indented line is never a
// continuation; a line ending in "\" joined with the next by a space, comment lines inside the
// join dropped. Each joined line keeps the number of its first line.
function unitLines(text: string): { text: string; lineOf: number[] } {
  const physical = (text.startsWith("\uFEFF") ? text.slice(1) : text).split(
    "\n",
  );
  const joined: string[] = [];
  const lineOf: number[] = [];
  let open: string[] | null = null;
  for (const [i, raw] of physical.entries()) {
    let body = raw.trim();
    if (open !== null && (body.startsWith("#") || body.startsWith(";")))
      continue;
    const continues = body.endsWith("\\");
    if (continues) body = body.slice(0, -1).trimEnd();
    if (open === null) {
      open = [body];
      lineOf.push(i + 1);
    } else {
      open.push(body);
    }
    if (!continues) {
      joined.push(open.join(" "));
      open = null;
    }
  }
  if (open !== null) joined.push(open.join(" "));
  return { text: joined.join("\n"), lineOf };
}

export function readSystemdUnits(ctx: ReadContext): EntryFact[] {
  const facts: EntryFact[] = [];
  for (const manifest of ctx.input.paths) {
    if (!manifest.endsWith(".service")) continue;
    const text = ctx.input.read(manifest);
    if (text === null) continue;
    const name = posix.basename(manifest);
    const unit = unitLines(text);
    for (const entry of parseIni(unit.text)) {
      if (entry.section !== "Service" || !EXEC_KEYS.has(entry.key)) continue;
      const line = unit.lineOf[entry.line - 1] ?? entry.line;
      for (const words of splitCommand(entry.value)) {
        const command = [
          (words[0] ?? "").replace(PREFIXES, ""),
          ...words.slice(1),
        ];
        for (const file of launchedFiles(
          command,
          ctx.bySuffix,
          ctx.input.pythonModules,
        )) {
          facts.push({
            file,
            qualname: null,
            kind: "unit",
            manifest,
            line,
            name,
          });
        }
      }
    }
  }
  return facts;
}
