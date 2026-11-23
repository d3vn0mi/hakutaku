// Builds the viewer's browser bundle into dist/viewer, next to tsc's output:
// - assets/app.js and assets/app.css, bundled by esbuild from src/viewer/app/main.ts and the
//   styles it imports;
// - assets/hl-worker.js, the Source tab's highlighting worker, bundled from
//   src/viewer/app/source/hl-worker.ts;
// - each script opening with the licence of every package bundled into it;
// - the six fonts, under the names the styles use;
// - page.html, the page template, copied as it is;
// - manifest.json, which lists every asset with its type, size and hash, and every bundled
//   package with its version and licence.
// Any esbuild warning fails the build, as an error does, and so does a bundle that cannot go
// inline in one self-contained page, as an export puts it: a script or styles whose text would end
// its element early, or keep its end tag from ending it.
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, formatMessages } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const APP = join(ROOT, "src/viewer/app");
const OUT = join(ROOT, "dist/viewer");
const ASSETS = join(OUT, "assets");

// The Latin-1 subsets of the two font families: [bundled name, package, file in the package].
const FONT_PACKAGES = ["@ibm/plex-mono", "@ibm/plex-sans-condensed"];
const FONTS = [
  [
    "plex-mono-400.woff2",
    "@ibm/plex-mono",
    "fonts/split/woff2/IBMPlexMono-Regular-Latin1.woff2",
  ],
  [
    "plex-mono-500.woff2",
    "@ibm/plex-mono",
    "fonts/split/woff2/IBMPlexMono-Medium-Latin1.woff2",
  ],
  [
    "plex-sans-condensed-300.woff2",
    "@ibm/plex-sans-condensed",
    "fonts/split/woff2/IBMPlexSansCondensed-Light-Latin1.woff2",
  ],
  [
    "plex-sans-condensed-400.woff2",
    "@ibm/plex-sans-condensed",
    "fonts/split/woff2/IBMPlexSansCondensed-Regular-Latin1.woff2",
  ],
  [
    "plex-sans-condensed-500.woff2",
    "@ibm/plex-sans-condensed",
    "fonts/split/woff2/IBMPlexSansCondensed-Medium-Latin1.woff2",
  ],
  [
    "plex-sans-condensed-600.woff2",
    "@ibm/plex-sans-condensed",
    "fonts/split/woff2/IBMPlexSansCondensed-SemiBold-Latin1.woff2",
  ],
];

// What each asset is served as, by its extension.
const TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
};

// 0. The self-contained page (step 6) is built with the inliner tsc writes, so tsc runs first, as
// npm run build has it; without the inliner, this fails before anything is removed or written.
const INLINER = new URL("../dist/viewer/inline.js", import.meta.url);
if (!existsSync(INLINER)) {
  process.stderr.write(
    "build-viewer: dist/viewer/inline.js is missing; run tsc -p tsconfig.build.json first, as npm run build does\n",
  );
  process.exit(1);
}

// 1. The last bundle goes; tsc's output stays.
rmSync(ASSETS, { recursive: true, force: true });
rmSync(join(OUT, "page.html"), { force: true });
rmSync(join(OUT, "manifest.json"), { force: true });

// 2. The app and its worker. The app's entry is named "app", so that its outputs are app.js and
// app.css, and the worker's "hl-worker", the script the page starts it from. The fonts stay as
// the styles name them: they sit next to app.css.
const result = await build({
  absWorkingDir: ROOT,
  entryPoints: {
    app: join(APP, "main.ts"),
    "hl-worker": join(APP, "source", "hl-worker.ts"),
  },
  tsconfig: join(APP, "tsconfig.json"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "eof",
  metafile: true,
  outdir: ASSETS,
  entryNames: "[name]",
  external: ["*.woff2"],
  logLevel: "error",
});
if (result.warnings.length > 0) {
  const lines = await formatMessages(result.warnings, { kind: "warning" });
  process.stderr.write(lines.join(""));
  throw new Error(
    `esbuild warned ${result.warnings.length} time(s); the viewer is not built`,
  );
}
const outputs = Object.keys(result.metafile.outputs).sort();
const expected = [
  "dist/viewer/assets/app.css",
  "dist/viewer/assets/app.js",
  "dist/viewer/assets/hl-worker.js",
];
if (JSON.stringify(outputs) !== JSON.stringify(expected)) {
  throw new Error(
    `esbuild wrote ${outputs.join(", ")}, not ${expected.join(", ")}`,
  );
}

// 2b. Each script opens with the licence of every package bundled into it, as one /*! comment,
// so the served scripts and every page that inlines them carry the notices those licences ask
// every copy to keep. The text is the package's licence file as written, except that an address
// is written without its scheme: the bundle names no address a browser could be sent to. The
// fonts carry their own copyright and licence in their name tables, which the OFL allows.
function licenceText(dir) {
  const file = readdirSync(join(ROOT, dir)).find((f) =>
    /^licen[cs]e(\.\w+)?$/i.test(f),
  );
  if (file === undefined) throw new Error(`${dir} has no licence file`);
  const text = readFileSync(join(ROOT, dir, file), "utf8")
    .replaceAll(/[a-z][a-z0-9+.-]*:\/\//gi, "")
    .trim();
  if (/\*\/|<\/script|<!--/i.test(text)) {
    throw new Error(`${dir}'s licence cannot go inside a script's comment`);
  }
  return text;
}

for (const out of ["app.js", "hl-worker.js"]) {
  const inputs = result.metafile.outputs[`dist/viewer/assets/${out}`].inputs;
  const packages = new Map();
  for (const input of Object.keys(inputs)) {
    const dir = packageDir(input);
    if (dir === null) continue;
    const { name, version, license } = packageEntry(dir);
    packages.set(`${name}@${version}`, { name, version, license, dir });
  }
  const notices = [...packages.values()]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(
      (p) => `${p.name} ${p.version} (${p.license})\n\n${licenceText(p.dir)}\n`,
    );
  if (notices.length === 0) continue;
  const path = join(ASSETS, out);
  writeFileSync(
    path,
    `/*! ${out} bundles the packages below, each under its own licence.\n\n${notices.join("\n")}*/\n${readFileSync(path, "utf8")}`,
  );
}

// 3. The fonts, and 4. the page template.
for (const [name, pkg, file] of FONTS) {
  copyFileSync(join(ROOT, "node_modules", pkg, file), join(ASSETS, name));
}
copyFileSync(join(APP, "page.html"), join(OUT, "page.html"));

// 5. The manifest.
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const assets = {};
for (const name of readdirSync(ASSETS).sort()) {
  const type = TYPES[extname(name)];
  if (type === undefined) throw new Error(`no type for the asset ${name}`);
  const bytes = readFileSync(join(ASSETS, name));
  assets[name] = { type, bytes: bytes.length, sha256: sha256(bytes) };
}

// The package directory an input under node_modules/ belongs to, nested ones included:
// "node_modules/a/node_modules/@b/c/x.js" is "node_modules/a/node_modules/@b/c".
function packageDir(input) {
  const mark = "node_modules/";
  const at = input.lastIndexOf(mark);
  if (at < 0) return null;
  const parts = input.slice(at + mark.length).split("/");
  const name = parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
  return input.slice(0, at + mark.length) + name;
}

function packageEntry(dir) {
  const pkg = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8"));
  const license =
    typeof pkg.license === "string" ? pkg.license : pkg.license?.type;
  if (typeof license !== "string" || license === "") {
    throw new Error(`${dir}/package.json names no licence`);
  }
  return { name: pkg.name, version: pkg.version, license };
}

const dirs = new Set(FONT_PACKAGES.map((name) => `node_modules/${name}`));
for (const input of Object.keys(result.metafile.inputs)) {
  const dir = packageDir(input);
  if (dir !== null) dirs.add(dir);
}
const seen = new Map();
for (const dir of dirs) {
  const entry = packageEntry(dir);
  seen.set(`${entry.name}@${entry.version}`, entry);
}
const bundled = [...seen.values()].sort((a, b) =>
  a.name === b.name
    ? a.version.localeCompare(b.version, "en")
    : a.name < b.name
      ? -1
      : 1,
);

// Every object's keys sorted, so that the same bundle always writes the same manifest.
function sortedKeys(value) {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedKeys(value[key])]),
  );
}

mkdirSync(OUT, { recursive: true });
writeFileSync(
  join(OUT, "manifest.json"),
  `${JSON.stringify(sortedKeys({ page: "page.html", assets, bundled }), null, 2)}\n`,
);

// 6. The self-contained page, built once from the bundle just written with the inliner tsc has
// just built: it throws for a bundle that does not match its manifest, or whose script or styles
// cannot go inline as they are.
const { inlineViewerHtml } = await import(INLINER.href);
inlineViewerHtml(null);
