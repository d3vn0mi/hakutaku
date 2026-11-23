// The built viewer bundle in dist/viewer, as `npm run build` writes it: its manifest lists every
// asset with its size and hash and every bundled package with its licence, and the whole app fits
// in one self-contained page of at most 2 MiB. The build script, run before tsc, says so plainly.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// A package's licence file, as the bundle carries it: the text word for word, as the licence asks,
// its lines ended by line feeds alone. The addresses a licence names stay in it; the containment
// scan allows each of them by name, since a comment is never requested.
function licenceOf(name: string): string {
  const dir = `${ROOT}node_modules/${name}/`;
  const file = readdirSync(dir).find((f) => /^licen[cs]e(\.\w+)?$/i.test(f));
  if (file === undefined) throw new Error(`${name} has no licence file`);
  return readFileSync(dir + file, "utf8")
    .replaceAll(/\r\n?/g, "\n")
    .trim();
}

it("carries the licence of every package bundled into a script, in that script and in a self-contained page", () => {
  const code = manifest.bundled
    .map((p: { name: string }) => p.name)
    .filter((name: string) => !name.startsWith("@ibm/plex-"));
  expect(code).toEqual(
    expect.arrayContaining(["graphology", "highlight.js", "sigma"]),
  );
  const app = readFileSync(`${ROOT}dist/viewer/assets/app.js`, "utf8");
  const worker = readFileSync(`${ROOT}dist/viewer/assets/hl-worker.js`, "utf8");
  const { html } = inlineViewerHtml(null);
  for (const name of code) {
    const licence = licenceOf(name);
    expect(licence, name).toMatch(/copyright/i);
    expect(app.includes(licence), `${name} in app.js`).toBe(true);
    expect(html.includes(licence), `${name} in the page`).toBe(true);
    // the worker bundles highlight.js alone, and carries its licence alone
    expect(worker.includes(licence), `${name} in hl-worker.js`).toBe(
      name === "highlight.js",
    );
  }
  // the notices open each script, as one comment a minifier keeps
  expect(app.startsWith("/*!")).toBe(true);
  expect(worker.startsWith("/*!")).toBe(true);
});

it("carries the licence of each font in the styles that embed it, and in a self-contained page", () => {
  const fonts = manifest.bundled
    .map((p: { name: string }) => p.name)
    .filter((name: string) => name.startsWith("@ibm/plex-"));
  expect(fonts).toEqual(["@ibm/plex-mono", "@ibm/plex-sans-condensed"]);
  const css = readFileSync(`${ROOT}dist/viewer/assets/app.css`, "utf8");
  const { html } = inlineViewerHtml(null);
  for (const name of fonts) {
    const licence = licenceOf(name);
    expect(licence, name).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/);
    expect(css.includes(licence), `${name} in app.css`).toBe(true);
    expect(html.includes(licence), `${name} in the page`).toBe(true);
  }
  expect(css.startsWith("/*!")).toBe(true);
  // no carriage return: a page's parser turns one into a line feed, and the inlined text would no
  // longer match the hash its policy names
  for (const name of ["app.js", "hl-worker.js", "app.css"]) {
    const text = readFileSync(`${ROOT}dist/viewer/assets/${name}`, "utf8");
    expect(text.includes("\r"), name).toBe(false);
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

it("the build script, run before tsc has written the inliner it needs, says so and removes nothing", () => {
  // a copy of the script, which finds esbuild through a link to the repo's node_modules, in a
  // directory whose dist holds an earlier bundle and nothing of tsc's
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-build-viewer-"));
  try {
    mkdirSync(join(dir, "scripts"));
    copyFileSync(
      join(ROOT, "scripts", "build-viewer.mjs"),
      join(dir, "scripts", "build-viewer.mjs"),
    );
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
    const earlier = join(dir, "dist", "viewer", "assets");
    mkdirSync(earlier, { recursive: true });
    writeFileSync(join(earlier, "app.js"), "earlier\n");
    const r = spawnSync(
      process.execPath,
      [join(dir, "scripts", "build-viewer.mjs")],
      { encoding: "utf8", timeout: 60_000 },
    );
    expect([r.status, r.stdout, r.stderr]).toEqual([
      1,
      "",
      "build-viewer: dist/viewer/inline.js is missing; run tsc -p tsconfig.build.json first, as npm run build does\n",
    ]);
    expect(readdirSync(join(dir, "dist", "viewer"))).toEqual(["assets"]);
    expect(readdirSync(earlier)).toEqual(["app.js"]);
    expect(readFileSync(join(earlier, "app.js"), "utf8")).toBe("earlier\n");
  } finally {
    unlinkSync(join(dir, "node_modules"));
    rmSync(dir, { recursive: true, force: true });
  }
});
