// The language the Source tab highlights a file in, by its extension; a file of no language here
// renders as plain text. The extension is the basename's, from its last "." unless that "."
// starts the name, and compares in its exact case, as the store reads extensions. No DOM here:
// Node tests import it.

export type HlLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "bash"
  | "json"
  | "yaml"
  | "ini"
  | "markdown";

// highlight.js's ini grammar reads TOML too, and systemd's units.
const BY_EXTENSION: ReadonlyMap<string, HlLanguage> = new Map([
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".py", "python"],
  [".pyi", "python"],
  [".sh", "bash"],
  [".bash", "bash"],
  [".json", "json"],
  [".yml", "yaml"],
  [".yaml", "yaml"],
  [".toml", "ini"],
  [".ini", "ini"],
  [".cfg", "ini"],
  [".service", "ini"],
  [".timer", "ini"],
  [".path", "ini"],
  [".socket", "ini"],
  [".target", "ini"],
  [".mount", "ini"],
  [".md", "markdown"],
]);

export function hlLanguage(path: string): HlLanguage | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return BY_EXTENSION.get(name.slice(dot)) ?? null;
}
