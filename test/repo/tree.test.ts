// Checks over the files of this repository: what git tracks, plus untracked files that
// .gitignore does not exclude. They keep stores, images and home-directory paths out of
// a public tree.
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const STORE_OR_INDEX = /\.(sqlite(-wal|-shm|-journal)?|db|scip)$/;
const IMAGE = /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i;
const HOME_PATH = /\/(?:home|Users)\/[A-Za-z0-9._-]+/;
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

it("holds no store or index file outside fixtures/", () => {
  const found = treeFiles().filter(
    (p) => !p.startsWith("fixtures/") && STORE_OR_INDEX.test(p),
  );
  expect(
    found,
    `store or index files outside fixtures/:\n${found.join("\n")}`,
  ).toEqual([]);
});

it("holds no image outside fixtures/ and docs/img/", () => {
  const found = treeFiles().filter(
    (p) =>
      !p.startsWith("fixtures/") && !p.startsWith("docs/img/") && IMAGE.test(p),
  );
  expect(
    found,
    `images outside fixtures/ and docs/img/:\n${found.join("\n")}`,
  ).toEqual([]);
});

it("holds no home-directory path in any text file", () => {
  const found: string[] = [];
  for (const path of treeFiles()) {
    const text = textOf(path);
    if (text === undefined) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (HOME_PATH.test(lines[i] ?? "")) found.push(`${path}:${i + 1}`);
    }
  }
  expect(
    found,
    `home-directory paths, as path:line:\n${found.join("\n")}`,
  ).toEqual([]);
});
