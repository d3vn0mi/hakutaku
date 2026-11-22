// The browser app's markup discipline, read from its source: no markup written from strings, no
// style attribute, no address outside its own server, and a codec free of Node, since the app
// bundles it.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

// Every file under dir, recursively, as a path relative to the repo root.
const listFiles = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(ROOT.length))
    .sort();

const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const files = listFiles("src/viewer/app");

it("app code never writes markup from strings, styles by attribute, or reaches outside", () => {
  const code = files.filter((p) => p.endsWith(".ts"));
  expect(code).toContain("src/viewer/app/main.ts"); // the scan reads real files
  for (const f of code) {
    const s = read(f);
    for (const bad of [
      /\binsertAdjacentHTML\b/,
      /\bouterHTML\b/,
      /\bdocument\.write\b/,
      /\beval\s*\(/,
      /\bnew Function\b/,
      /setAttribute\(\s*["']style["']/,
      /\bstyle=/,
      /https?:\/\//,
    ])
      expect(s, `${f} ${bad}`).not.toMatch(bad);
    if (f !== "src/viewer/app/source/render.ts")
      expect(s, f).not.toMatch(/\.innerHTML\b/);
  }
});

it("the page template and styles hold no inline code and no outside address", () => {
  const html = read("src/viewer/app/page.html");
  expect(html).not.toMatch(
    /<script(?![^>]*\bsrc=)|<style|\sstyle=|https?:\/\//,
  );
  const css = files.filter((p) => p.endsWith(".css"));
  expect(css).toEqual(
    expect.arrayContaining([
      "src/viewer/app/styles/app.css",
      "src/viewer/app/styles/tokens.css",
    ]),
  );
  for (const f of css) expect(read(f), f).not.toMatch(/https?:\/\//);
});

it("the codec the viewer bundles is browser-safe", () => {
  for (const f of [
    "src/model/ids.ts",
    "src/model/tokens.ts",
    "src/model/order.ts",
    "src/model/types.ts",
  ])
    expect(read(f), f).not.toMatch(/\bBuffer\b|from\s+["']node:/);
});
