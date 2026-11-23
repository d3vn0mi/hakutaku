// The built viewer bundle in dist/viewer, as `npm run build` writes it: its manifest lists every
// asset with its size and hash and every bundled package with its licence, and the whole app fits
// in one self-contained page of at most 2 MiB.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { inlineViewerHtml } from "../../../src/viewer/inline.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const manifest = JSON.parse(
  readFileSync(`${ROOT}dist/viewer/manifest.json`, "utf8"),
);

it("lists every asset with its size and hash", () => {
  expect(Object.keys(manifest.assets)).toEqual(
    expect.arrayContaining([
      "app.js",
      "app.css",
      "hl-worker.js",
      "plex-mono-400.woff2",
      "plex-mono-500.woff2",
      "plex-sans-condensed-300.woff2",
      "plex-sans-condensed-400.woff2",
      "plex-sans-condensed-500.woff2",
      "plex-sans-condensed-600.woff2",
    ]),
  );
  for (const [name, a] of Object.entries<{ bytes: number; sha256: string }>(
    manifest.assets,
  )) {
    const b = readFileSync(`${ROOT}dist/viewer/assets/${name}`);
    expect([b.length, createHash("sha256").update(b).digest("hex")]).toEqual([
      a.bytes,
      a.sha256,
    ]);
  }
});

it("types each asset by its extension, and keeps its keys sorted", () => {
  const types = Object.fromEntries(
    Object.entries<{ type: string }>(manifest.assets).map(([name, a]) => [
      name,
      a.type,
    ]),
  );
  expect(types["app.js"]).toBe("text/javascript; charset=utf-8");
  expect(types["hl-worker.js"]).toBe("text/javascript; charset=utf-8");
  expect(types["app.css"]).toBe("text/css; charset=utf-8");
  for (const [name, type] of Object.entries(types))
    if (name.endsWith(".woff2")) expect(type, name).toBe("font/woff2");
  expect(manifest.page).toBe("page.html");
  expect(Object.keys(manifest)).toEqual(["assets", "bundled", "page"]);
  const names = Object.keys(manifest.assets);
  expect(names).toEqual([...names].sort());
  // The page is the template as written, its placeholders left for the server to fill.
  expect(readFileSync(`${ROOT}dist/viewer/page.html`, "utf8")).toBe(
    readFileSync(`${ROOT}src/viewer/app/page.html`, "utf8"),
  );
});

it("names every bundled package with an allowed licence", () => {
  const names = manifest.bundled.map((p: { name: string }) => p.name);
  expect(names).toEqual([...names].sort());
  expect(names).toEqual(
    expect.arrayContaining([
      "@ibm/plex-mono",
      "@ibm/plex-sans-condensed",
      "graphology",
      "highlight.js",
      "sigma",
    ]),
  );
  for (const p of manifest.bundled) {
    expect(p.license).toMatch(
      /^(MIT|ISC|0BSD|BSD-2-Clause|BSD-3-Clause|Apache-2\.0|OFL-1\.1|Unlicense|CC0-1\.0|Python-2\.0|BlueOak-1\.0\.0)$/,
    );
    // Each version is the installed package's own.
    const installed = JSON.parse(
      readFileSync(`${ROOT}node_modules/${p.name}/package.json`, "utf8"),
    );
    expect(p.version, p.name).toBe(installed.version);
  }
});

it("NOTICE names every bundled package with its version and licence", () => {
  const notice = readFileSync(`${ROOT}NOTICE`, "utf8");
  const part = notice
    .split(/^## /m)
    .find((p) => p.startsWith("Bundled in the package\n"));
  if (part === undefined) throw new Error("NOTICE has no bundled section");
  const entries = part
    .split(/^### /m)
    .slice(1)
    .map((entry) => {
      const lines = entry.split("\n");
      const field = (name: string) =>
        lines.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
      return {
        heading: lines[0],
        pkg: field("Package"),
        version: field("Version"),
        licence: field("Licence"),
      };
    });
  for (const p of manifest.bundled) {
    const entry = entries.find(
      (e) =>
        e.pkg === `npm:${p.name}` ||
        (e.pkg === undefined && e.heading === p.name),
    );
    expect(entry, p.name).toBeDefined();
    expect([entry?.version, entry?.licence], p.name).toEqual([
      p.version,
      p.license,
    ]);
  }
});

it("stays within 2 MiB as one self-contained page", () => {
  const bytes = Buffer.byteLength(inlineViewerHtml(null).html);
  console.log(`one self-contained page: ${bytes} bytes`);
  expect(bytes).toBeLessThanOrEqual(2_097_152);
});

const sha = (s: string) => createHash("sha256").update(s).digest("base64");
// The text inside the first element that open starts.
const inner = (html: string, open: RegExp): string => {
  const m = html.match(
    new RegExp(`${open.source}([\\s\\S]*?)</(script|style)>`),
  );
  if (m === null) throw new Error(`no ${open.source} in the page`);
  return m[1];
};
const sha256hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");

it("inlines the styles, the fonts and the script under a CSP that names exactly them", () => {
  const { html, csp } = inlineViewerHtml(null);
  const js = inner(html, /<script>/);
  const css = inner(html, /<style>/);
  expect(csp).toBe(
    `default-src 'none'; script-src 'sha256-${sha(js)}'; style-src 'sha256-${sha(css)}'; font-src data:; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'`,
  );
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  expect(html).toContain(`<meta charset="utf-8">${meta}<style>`);
  // One script and one style element, counted in the markup around the two inline texts: the
  // script's text names <script and <style itself, in highlight.js's grammar for HTML.
  const markup = html.replace(css, "").replace(js, "");
  expect([
    markup.match(/<script/g)?.length,
    markup.match(/<style/g)?.length,
  ]).toEqual([1, 1]);
  expect(js).toBe(readFileSync(`${ROOT}dist/viewer/assets/app.js`, "utf8"));
  // Each font is one of the six files, as a data: URI, and nothing loads from anywhere else.
  const fonts = [
    ...css.matchAll(/url\(data:font\/woff2;base64,([^)]*)\)/g),
  ].map((m) => sha256hex(Buffer.from(m[1], "base64")));
  const files = Object.keys(manifest.assets)
    .filter((n) => n.endsWith(".woff2"))
    .map((n) => sha256hex(readFileSync(`${ROOT}dist/viewer/assets/${n}`)));
  expect(fonts.length).toBe(6);
  expect([...fonts].sort()).toEqual([...files].sort());
  expect(css).not.toMatch(/url\(plex-/);
  // The markup around the two inline texts loads nothing and names no API.
  expect(markup).not.toMatch(/\sstyle=|<base|<link|\ssrc=|hakutaku-api|\{\{/);
});

it("puts the data block before the script, and refuses one that could end it", () => {
  const { html } = inlineViewerHtml('{"format":1}');
  expect(html).toMatch(
    /<script type="application\/json" id="hakutaku-data">\{"format":1\}<\/script><script>/,
  );
  expect(html.match(/<\/script>/g)).toHaveLength(2);
  expect(() => inlineViewerHtml('{"a":"</script><script>x()"}')).toThrow(
    TypeError,
  );
});
