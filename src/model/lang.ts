// Code languages by file extension: the key is the extension with its leading dot, in
// lower case, and the value the language's lower-case name. Only code languages are
// here; data formats and docs are not.
import type { Lang } from "./types.js";

const EXTENSIONS: ReadonlyArray<readonly [Lang, readonly string[]]> = [
  ["typescript", [".ts", ".tsx", ".mts", ".cts"]],
  ["javascript", [".js", ".jsx", ".mjs", ".cjs"]],
  ["python", [".py", ".pyi"]],
  ["shell", [".sh", ".bash"]],
  ["c", [".c", ".h"]],
  ["c++", [".cc", ".cpp", ".cxx", ".c++", ".hh", ".hpp", ".hxx", ".h++"]],
  ["c#", [".cs"]],
  ["go", [".go"]],
  ["rust", [".rs"]],
  ["java", [".java"]],
  ["kotlin", [".kt", ".kts"]],
  ["ruby", [".rb"]],
  ["php", [".php"]],
  ["swift", [".swift"]],
  ["scala", [".scala", ".sc"]],
  ["lua", [".lua"]],
  ["dart", [".dart"]],
  ["elixir", [".ex", ".exs"]],
  ["haskell", [".hs", ".lhs"]],
  ["ocaml", [".ml", ".mli"]],
  ["perl", [".pl", ".pm"]],
  ["zig", [".zig"]],
];

// No prototype, so that no inherited name such as "constructor" answers a lookup.
const byExt: Record<string, Lang> = Object.create(null);
for (const [lang, exts] of EXTENSIONS)
  for (const ext of exts) byExt[ext] = lang;

export const LANG_BY_EXT: Readonly<Record<string, Lang>> = Object.freeze(byExt);
