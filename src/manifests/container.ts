// Containers and processes, read as data.
// - Dockerfile and Dockerfile.*: CMD and ENTRYPOINT, in exec form (a JSON array of strings) or
//   shell form, matched by suffix, since a path in an image is a deployed one: kind container,
//   named by the command (an exec form's words joined by spaces).
// - Procfile: each "<name>: <command>" line, from the Procfile's directory: kind procfile,
//   named by the process type.
import { posix } from "node:path";
import { commandFiles, launchedFiles, relativeTo } from "./commands.js";
import type { EntryFact, ReadContext } from "./types.js";

const PROCESS = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;

// A Dockerfile's instructions, as Docker reads them: a line ending in "\" continues on the
// next; comment lines, and empty lines inside a continued instruction, are dropped; the keyword
// is read in any case. Each instruction keeps the number of its first line.
function instructions(
  text: string,
): Array<{ keyword: string; args: string; line: number }> {
  const out: Array<{ keyword: string; args: string; line: number }> = [];
  const lines = (text.startsWith("\uFEFF") ? text.slice(1) : text).split("\n");
  let open: { keyword: string; parts: string[]; line: number } | null = null;
  for (const [i, raw] of lines.entries()) {
    const body = raw.trim();
    if (body.startsWith("#") || body === "") continue;
    const continues = body.endsWith("\\");
    const piece = continues ? body.slice(0, -1).trim() : body;
    if (open === null) {
      const space = piece.search(/\s/);
      open = {
        keyword: (space === -1 ? piece : piece.slice(0, space)).toUpperCase(),
        parts: [space === -1 ? "" : piece.slice(space + 1).trim()],
        line: i + 1,
      };
    } else {
      open.parts.push(piece);
    }
    if (!continues) {
      out.push({
        keyword: open.keyword,
        args: open.parts.filter((p) => p !== "").join(" "),
        line: open.line,
      });
      open = null;
    }
  }
  if (open !== null) {
    out.push({
      keyword: open.keyword,
      args: open.parts.filter((p) => p !== "").join(" "),
      line: open.line,
    });
  }
  return out;
}

// An exec form's words, or null for a shell form.
function execForm(args: string): string[] | null {
  if (!args.startsWith("[")) return null;
  try {
    const words: unknown = JSON.parse(args);
    return Array.isArray(words) && words.every((w) => typeof w === "string")
      ? words
      : null;
  } catch {
    return null;
  }
}

function dockerfile(ctx: ReadContext, manifest: string): EntryFact[] {
  const text = ctx.input.read(manifest);
  if (text === null) return [];
  const facts: EntryFact[] = [];
  for (const { keyword, args, line } of instructions(text)) {
    if (keyword !== "CMD" && keyword !== "ENTRYPOINT") continue;
    const words = execForm(args);
    const files =
      words === null
        ? commandFiles(args, ctx.bySuffix, ctx.input.pythonModules)
        : launchedFiles(words, ctx.bySuffix, ctx.input.pythonModules);
    const name = words === null ? args : words.join(" ");
    for (const file of files) {
      facts.push({
        file,
        qualname: null,
        kind: "container",
        manifest,
        line,
        name,
      });
    }
  }
  return facts;
}

function procfile(ctx: ReadContext, manifest: string): EntryFact[] {
  const text = ctx.input.read(manifest);
  if (text === null) return [];
  const facts: EntryFact[] = [];
  const resolve = relativeTo(posix.dirname(manifest), ctx.named);
  for (const [i, raw] of text.split("\n").entries()) {
    const m = PROCESS.exec(raw.trim());
    if (m === null) continue;
    const name = m[1] ?? "";
    for (const file of commandFiles(
      m[2] ?? "",
      resolve,
      ctx.input.pythonModules,
    )) {
      facts.push({
        file,
        qualname: null,
        kind: "procfile",
        manifest,
        line: i + 1,
        name,
      });
    }
  }
  return facts;
}

export function readContainers(ctx: ReadContext): EntryFact[] {
  const facts: EntryFact[] = [];
  for (const manifest of ctx.input.paths) {
    const base = posix.basename(manifest);
    if (base === "Dockerfile" || base.startsWith("Dockerfile."))
      facts.push(...dockerfile(ctx, manifest));
    else if (base === "Procfile") facts.push(...procfile(ctx, manifest));
  }
  return facts;
}
