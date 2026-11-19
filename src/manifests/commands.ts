// Command paths (§5.7): which repo files a command launches. Commands are read as data; none
// runs.
//
// - A command line splits into commands at &&, ||, ;, | and line ends outside quotes. Words
//   follow the shell's quoting: '...' keeps every character; inside "..." a backslash escapes
//   " \ $ ` and a line end; elsewhere it escapes any character. An unquoted # that starts a
//   word starts a comment, to the end of the line.
// - A command launches the file its command word names, after any NAME=value assignments, as a
//   shell reads them. When that word is a runner, by its base name (/usr/bin/python3 is
//   python3), it also launches the file the first word after it that is not an option names.
//   deno is a runner only as "deno run". After python or python3, -m takes the next word as a
//   module, through the module index; a package runs its __main__.py, as Python does.
// - How a word names a file is the caller's: from a directory (relativeTo), or by suffix
//   (bySuffix).
import { repoPath } from "./built-paths.js";
import type { Named, Resolve } from "./types.js";

const RUNNERS: ReadonlySet<string> = new Set([
  "node",
  "tsx",
  "ts-node",
  "python",
  "python3",
  "bash",
  "sh",
  "deno",
  "bun",
]);
const PYTHON: ReadonlySet<string> = new Set(["python", "python3"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ESCAPED_IN_DOUBLE = '"\\$`\n';

export function splitCommand(line: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = (): void => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") {
      const close = line.indexOf("'", i + 1);
      const end = close === -1 ? line.length : close;
      word += line.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '"') {
      inWord = true;
      for (i++; i < line.length && line[i] !== '"'; i++) {
        const next = line[i + 1] ?? "";
        if (
          line[i] === "\\" &&
          next !== "" &&
          ESCAPED_IN_DOUBLE.includes(next)
        ) {
          i++;
          if (next !== "\n") word += next;
        } else {
          word += line[i];
        }
      }
    } else if (c === "\\") {
      if (i + 1 < line.length) {
        i++;
        if (line[i] !== "\n") {
          word += line[i];
          inWord = true;
        }
      }
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord();
    } else if (c === "\n" || c === ";") {
      endCommand();
    } else if (c === "|") {
      if (line[i + 1] === "|") i++;
      endCommand();
    } else if (c === "&" && line[i + 1] === "&") {
      i++;
      endCommand();
    } else if (c === "#" && !inWord) {
      const nl = line.indexOf("\n", i);
      i = (nl === -1 ? line.length : nl) - 1;
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

// The module a `python -m` runs: its file, or a package's __main__.py.
function moduleFile(
  name: string | undefined,
  modules: ReadonlyMap<string, string>,
): string | null {
  if (name === undefined) return null;
  const file = modules.get(name);
  if (file === undefined) return null;
  if (file.endsWith("/__init__.py") || file === "__init__.py")
    return modules.get(`${name}.__main__`) ?? null;
  return file;
}

// The files one command's words launch.
export function launchedFiles(
  words: readonly string[],
  resolve: Resolve,
  modules: ReadonlyMap<string, string>,
): string[] {
  let i = 0;
  while (i < words.length && ASSIGNMENT.test(words[i] ?? "")) i++;
  const command = words[i];
  if (command === undefined) return [];
  const files: string[] = [];
  const own = resolve(command);
  if (own !== null) files.push(own);
  const runner = command.slice(command.lastIndexOf("/") + 1);
  if (!RUNNERS.has(runner)) return files;
  i++;
  if (runner === "deno") {
    if (words[i] !== "run") return files;
    i++;
  }
  for (; i < words.length; i++) {
    const word = words[i] ?? "";
    if (word === "-m" && PYTHON.has(runner)) {
      const file = moduleFile(words[i + 1], modules);
      if (file !== null) files.push(file);
      return files;
    }
    if (word.startsWith("-")) continue;
    const file = resolve(word);
    if (file !== null) files.push(file);
    return files;
  }
  return files;
}

// The files a command line launches, command by command.
export function commandFiles(
  line: string,
  resolve: Resolve,
  modules: ReadonlyMap<string, string>,
): string[] {
  return splitCommand(line).flatMap((words) =>
    launchedFiles(words, resolve, modules),
  );
}

// A word as a path from the directory `base` ("" for the repo top), with a leading ./ or a ../
// that stays inside the repo, through `named`. An absolute word names nothing.
export function relativeTo(base: string, named: Named): Resolve {
  return (word) => {
    const path = repoPath(base, word);
    return path === null ? null : named(path);
  };
}

// A word by suffix: of the word and its tails that start after a "/", the longest that names a
// file through `named`, so that /srv/observatory/ and %h/observatory/ prefixes do not matter. A
// tail holding an empty, "." or ".." segment is never tried, nor one longer than `longest`
// characters: the caller sets `longest` so that no longer tail can name a file.
export function bySuffix(named: Named, longest: number): Resolve {
  return (word) => {
    const starts: number[] = [];
    let end = word.length;
    while (end >= 0) {
      const slash = end === 0 ? -1 : word.lastIndexOf("/", end - 1);
      const segment = word.slice(slash + 1, end);
      if (segment === "" || segment === "." || segment === "..") break;
      if (word.length - (slash + 1) > longest) break;
      starts.push(slash + 1);
      if (slash < 0) break;
      end = slash;
    }
    for (let i = starts.length - 1; i >= 0; i--) {
      const file = named(word.slice(starts[i]));
      if (file !== null) return file;
    }
    return null;
  };
}
