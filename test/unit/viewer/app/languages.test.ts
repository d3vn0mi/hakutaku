// The Source tab's languages and highlighting: a file's language by its extension, compared in its
// exact case as the store compares it, and highlight.js's output split into lines, with classes
// and no other markup; a file of no language is escaped plain text.
import { expect, it } from "vitest";
import { highlightLines } from "../../../../src/viewer/app/source/hl.js";
import {
  type HlLanguage,
  hlLanguage,
} from "../../../../src/viewer/app/source/languages.js";

it.each([
  ["a/b.ts", "typescript"],
  ["x.tsx", "typescript"],
  ["x.cjs", "javascript"],
  ["x.pyi", "python"],
  ["x.bash", "bash"],
  ["package.json", "json"],
  ["ci.yaml", "yaml"],
  ["pyproject.toml", "ini"],
  ["deploy/x.service", "ini"],
  ["x.timer", "ini"],
  ["README.md", "markdown"],
  ["Makefile", null],
  ["x.rs", null],
])("%s is %s", (p, l) => {
  expect(hlLanguage(p)).toBe(l);
});

it.each([
  ["x.mts", "typescript"],
  ["x.cts", "typescript"],
  ["types/a.d.ts", "typescript"],
  ["x.js", "javascript"],
  ["x.jsx", "javascript"],
  ["x.mjs", "javascript"],
  ["x.py", "python"],
  ["scripts/sync-sky.sh", "bash"],
  ["x.yml", "yaml"],
  ["x.ini", "ini"],
  ["setup.cfg", "ini"],
  ["x.path", "ini"],
  ["x.socket", "ini"],
  ["x.target", "ini"],
  ["x.mount", "ini"],
  // the extension is the basename's, from its last "." unless that "." starts the name
  ["web.ts/Makefile", null],
  [".bashrc", null],
  [".ts", null],
  ["x.", null],
  ["x", null],
  // in its exact case, as the store reads extensions
  ["x.TS", null],
  ["README.MD", null],
])("%s is also %s", (p, l) => {
  expect(hlLanguage(p)).toBe(l);
});

it("escapes plain text and highlights with classes only", () => {
  expect(highlightLines("<b>&</b>", null)).toEqual([
    "&lt;b&gt;&amp;&lt;/b&gt;",
  ]);
  const ts = highlightLines("const a = 1;", "typescript").join("");
  expect(ts).toContain('class="hljs-keyword"');
  expect(ts).not.toMatch(/\sstyle=/);
});

// A short text in each language, and a class its highlighting must hold.
const SAMPLES: ReadonlyArray<[HlLanguage, string, string]> = [
  [
    "typescript",
    "export function f(n: number): number {\n  return n;\n}\n",
    "hljs-keyword",
  ],
  // JSX, through the xml grammar
  ["typescript", 'const a = <div className="x">hi</div>;\n', "hljs-name"],
  ["javascript", "// one\nconst b = [1, 'two'];\n", "hljs-comment"],
  ["python", "def f(x):\n    return x  # same\n", "hljs-keyword"],
  ["bash", '#!/bin/sh\nif [ -n "$A" ]; then echo hi; fi\n', "hljs-keyword"],
  ["json", '{"a": 1, "b": [true, null]}\n', "hljs-attr"],
  ["yaml", "name: ci\non: [push]\n", "hljs-attr"],
  ["ini", "[Unit]\nDescription=a unit\n", "hljs-section"],
  ["markdown", "# Title\n\nSome *text*.\n", "hljs-section"],
];

it.each(SAMPLES)("highlights %s", (lang, text, mark) => {
  const lines = highlightLines(text, lang);
  expect(lines.join("\n")).toContain(`class="${mark}`);
});

it("writes no tag but highlight.js's spans, each line closing what it opens", () => {
  for (const [lang, text] of SAMPLES) {
    for (const line of highlightLines(text, lang)) {
      // a scope's class, or, around code in another language (JSX), that language's
      for (const [tag] of line.matchAll(/<[^>]*>/g)) {
        expect(tag, `${lang}: ${tag}`).toMatch(
          /^(?:<\/span>|<span class="(?:hljs-[a-z_-]+(?: [a-z_]+)*|language-[a-z]+)">)$/,
        );
      }
      expect(line.split("<span").length, `${lang}: ${line}`).toBe(
        line.split("</span>").length,
      );
    }
  }
});

it("keeps markup in the code as text", () => {
  const code = 'const s = "<img src=x onerror=alert(1)>"; // </span><b>\n';
  for (const lang of ["typescript", null] as const) {
    const html = highlightLines(code, lang).join("\n");
    expect(html, String(lang)).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html, String(lang)).not.toMatch(/<img|<b>|<\/span><b>/);
  }
});

it("gives one fragment per line, a comment across lines included", () => {
  const lines = highlightLines("/* a\n * b\n */\nconst x = 1;\n", "typescript");
  expect(lines).toHaveLength(5);
  for (const line of lines.slice(0, 3)) {
    expect(line).toMatch(/^<span class="hljs-comment">.*<\/span>$/);
  }
  expect(lines[4]).toBe("");
});

it("drops carriage returns that end lines, highlighted or plain", () => {
  for (const lang of ["typescript", null] as const) {
    const lines = highlightLines("const a = 1;\r\nconst b = 2;\r\n", lang);
    expect(lines, String(lang)).toHaveLength(3);
    expect(lines.join(""), String(lang)).not.toContain("\r");
  }
});

it("keeps a string that spans lines in its colour on every line", () => {
  const ts = highlightLines("const s = `one\ntwo\nthree`;\n", "typescript");
  const py = highlightLines('s = """one\ntwo\nthree"""\n', "python");
  for (const [lang, lines] of [
    ["typescript", ts],
    ["python", py],
  ] as const) {
    expect(lines, lang).toHaveLength(4);
    for (const line of lines.slice(0, 3)) {
      expect(line, `${lang}: ${line}`).toMatch(
        /<span class="hljs-string">[^<]*(?:one|two|three)[^<]*<\/span>/,
      );
    }
  }
  expect(ts[1]).toBe('<span class="hljs-string">two</span>');
  expect(py[1]).toBe('<span class="hljs-string">two</span>');
});

it("keeps a script element in markdown or HTML-bearing code as text", () => {
  const code =
    "# T\n\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n";
  for (const lang of ["markdown", "typescript", "javascript", null] as const) {
    const html = highlightLines(code, lang).join("\n");
    // every tag is a span; without them, the text is the code, escaped
    for (const [tag] of html.matchAll(/<[^>]*>/g)) {
      expect(tag, `${lang}: ${tag}`).toMatch(/^<\/?span[ >]/);
    }
    expect(html.replace(/<[^>]*>/g, ""), String(lang)).toBe(
      code
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;"),
    );
  }
});
