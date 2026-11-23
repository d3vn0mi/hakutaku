// The browser app's markup discipline, read from its source: no markup written or parsed from
// strings but on one line of render.ts, which only highlight.js's or escapeHtml's output reaches,
// no style attribute, no address outside its own server, and a codec free of Node, since the app
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

// The one line of the app that writes markup from a string: render.ts parses a chunk of lines,
// each of them highlight.js's output or escapeHtml's, so no repository text reaches it unescaped.
const MARKUP_FILE = "src/viewer/app/source/render.ts";
const MARKUP_LINE = '    parsed.innerHTML = `<span class="chunk">${shown';

// What no app code may hold, render.ts included: a way to write or parse markup from a string (a
// frame's srcdoc, in any case, as HTML reads attribute names), to run a string as code, to style
// by attribute, or to name an address outside the page's own server.
const BANNED: ReadonlyArray<RegExp> = [
  /\binsertAdjacentHTML\b/,
  /\bouterHTML\b/,
  /\bdocument\.write(?:ln)?\b/,
  /\bDOMParser\b/,
  /\bparseFromString\b/,
  /\bcreateContextualFragment\b/,
  /\bsetHTMLUnsafe\b/,
  /\bparseHTMLUnsafe\b/,
  /srcdoc/i,
  /\beval\s*\(/,
  /\bnew Function\b/,
  /setAttribute\(\s*["']style["']/,
  /\bstyle=/,
  /https?:\/\//,
];

// What is wrong with one app file: each banned form it holds, and each line that names innerHTML,
// but for MARKUP_LINE, once, in MARKUP_FILE.
function findings(path: string, text: string): string[] {
  const found = BANNED.filter((bad) => bad.test(text)).map(
    (bad) => `${path} ${bad}`,
  );
  let allowed = path === MARKUP_FILE ? 1 : 0;
  text.split("\n").forEach((line, i) => {
    if (!line.includes("innerHTML")) return;
    if (line === MARKUP_LINE && allowed > 0) {
      allowed--;
      return;
    }
    found.push(`${path}:${i + 1} innerHTML`);
  });
  return found;
}

// Each form the scan must find, as one line of an app file, and a word its finding names.
const CAUGHT: ReadonlyArray<[line: string, names: string]> = [
  ["const doc = new DOMParser();", "DOMParser"],
  ['const page = doc.parseFromString(text, "text/html");', "parseFromString"],
  ["const part = range.createContextualFragment(text);", "Contextual"],
  ["el.setHTMLUnsafe(text);", "setHTMLUnsafe"],
  ["const page = Document.parseHTMLUnsafe(text);", "parseHTMLUnsafe"],
  ["frame.srcdoc = text;", "srcdoc"],
  ['h("iframe", { attrs: { srcdoc: text } });', "srcdoc"],
  ['frame.setAttribute("SRCDOC", text);', "srcdoc"],
  ["document.write(text);", "document"],
  ["document.writeln(text);", "document"],
  ['el.insertAdjacentHTML("beforeend", text);', "insertAdjacentHTML"],
  ["el.outerHTML = text;", "outerHTML"],
  ["el.innerHTML = text;", "innerHTML"],
  ['el["innerHTML"] = text;', "innerHTML"],
  ["const run = eval(text);", "eval"],
  ["const run = new Function(text);", "Function"],
  ['el.setAttribute("style", text);', "style"],
  ['const tag = "<p style=x>";', "style="],
  ['fetch("https://example.invalid/");', "https"],
];

it("finds every way to write markup from a string, in any app file, and allows innerHTML on its one line only", () => {
  const other = "src/viewer/app/main.ts";
  for (const [line, names] of CAUGHT) {
    for (const path of [other, MARKUP_FILE]) {
      const found = findings(path, `const a = 1;\n${line}\n`);
      expect([line, path, found.length], found.join("; ")).toEqual([
        line,
        path,
        1,
      ]);
      expect(found[0], line).toContain(names);
    }
  }
  // the one line allowed, where it stands, once
  expect(findings(MARKUP_FILE, `a;\n${MARKUP_LINE}\nb;\n`)).toEqual([]);
  // the same line anywhere else, again in render.ts, or another innerHTML in render.ts
  expect(findings(other, `${MARKUP_LINE}\n`)).toEqual([`${other}:1 innerHTML`]);
  expect(findings(MARKUP_FILE, `${MARKUP_LINE}\n${MARKUP_LINE}\n`)).toEqual([
    `${MARKUP_FILE}:2 innerHTML`,
  ]);
  expect(
    findings(MARKUP_FILE, `${MARKUP_LINE}\n  code.innerHTML = text;\n`),
  ).toEqual([`${MARKUP_FILE}:2 innerHTML`]);
  // text written as text is fine
  expect(
    findings(other, 'el.textContent = text;\nh("p", { text });\n'),
  ).toEqual([]);
});

it("app code never writes markup from strings, styles by attribute, or reaches outside", () => {
  // TypeScript, and the one script, which sets up highlight.js
  const code = files.filter((p) => p.endsWith(".ts") || p.endsWith(".js"));
  expect(code).toContain("src/viewer/app/main.ts"); // the scan reads real files
  expect(code).toContain("src/viewer/app/source/hljs.js");
  expect(code).toContain(MARKUP_FILE);
  expect(code.flatMap((f) => findings(f, read(f)))).toEqual([]);
  // the one innerHTML allowed is there, once: when it goes, so does its exemption
  expect(
    read(MARKUP_FILE)
      .split("\n")
      .filter((line) => line === MARKUP_LINE),
  ).toHaveLength(1);
});

// Inline code or styles, a style attribute, an outside address, or a frame's own document, in the
// page's template, in any case, as HTML reads tag and attribute names.
const PAGE_BANNED =
  /<script(?![^>]*\bsrc=)|<style|\sstyle=|https?:\/\/|srcdoc/i;

it("finds inline code, styles, outside addresses and framed documents in the page's template", () => {
  for (const markup of [
    "<script>go()</script>",
    "<SCRIPT>go()</SCRIPT>",
    "<style>p{}</style>",
    '<p style="color:red">',
    '<a href="https://example.invalid/">',
    '<iframe srcdoc="<p>x</p>"></iframe>',
  ]) {
    expect(markup).toMatch(PAGE_BANNED);
  }
  expect('<script type="module" src="assets/app.js"></script>').not.toMatch(
    PAGE_BANNED,
  );
});

it("the page template and styles hold no inline code and no outside address", () => {
  const html = read("src/viewer/app/page.html");
  expect(html).not.toMatch(PAGE_BANNED);
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
