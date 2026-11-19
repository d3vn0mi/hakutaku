// The secret scan over the files of this repository, listed exactly as tree.test.ts lists
// them: what git tracks, plus untracked files that .gitignore does not exclude. Each text
// file goes through the redaction rules' matching; a hit fails the scan.
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { findSecrets } from "../../src/redact/index.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BINARY_SNIFF_BYTES = 8000;

function treeFiles(): string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  return [...new Set(out.split("\0").filter((p) => p !== ""))];
}

// The text git would store for a path: a symlink's target, or a regular file's content.
// Undefined for a binary file (a NUL byte in its first 8,000 bytes), for a path that no
// longer exists in the work tree, and for anything else, such as a submodule.
function textOf(path: string): string | undefined {
  const abs = join(ROOT, path);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(abs);
  } catch {
    return undefined;
  }
  if (stat.isSymbolicLink()) return readlinkSync(abs, "utf8");
  if (!stat.isFile()) return undefined;
  const bytes = readFileSync(abs);
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return undefined;
  return bytes.toString("utf8");
}

it("finds no secret in any tracked text file", () => {
  const found: string[] = [];
  for (const path of treeFiles()) {
    const text = textOf(path);
    if (text === undefined) continue;
    for (const { line, rule } of findSecrets(text)) {
      found.push(`${path}:${line}: ${rule}`);
    }
  }
  expect(found, `secrets, as path:line: rule:\n${found.join("\n")}`).toEqual(
    [],
  );
});
