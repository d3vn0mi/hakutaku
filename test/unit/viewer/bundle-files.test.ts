// The bundle's own checks, on copies of the built bundle: a bundle loads only while its template
// holds both placeholders in order and every asset is a plain file name whose bytes match the
// manifest; and the page's placeholders take their text exactly as it is.
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  fillPage,
  loadBundle,
  readBundle,
} from "../../../src/viewer/bundle-files.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BUILT = join(ROOT, "dist/viewer");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// A copy of the built bundle, for one test to change.
function copy(): string {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-bundle-"));
  dirs.push(dir);
  for (const f of ["manifest.json", "page.html", "assets"])
    cpSync(join(BUILT, f), join(dir, f), { recursive: true });
  return dir;
}
const read = (dir: string, f: string) => readFileSync(join(dir, f), "utf8");
const manifestOf = (dir: string) => JSON.parse(read(dir, "manifest.json"));
const writeManifest = (dir: string, m: unknown) =>
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));

it("loads a copy of the built bundle as readBundle reads the bundle itself", () => {
  const loaded = loadBundle(copy());
  const built = readBundle();
  if (loaded === null || built === null) throw new Error("no bundle");
  expect(loaded.page).toBe(built.page);
  expect([...loaded.assets.keys()]).toEqual([...built.assets.keys()]);
  expect([...loaded.assets.keys()]).toContain("app.js");
  for (const [name, asset] of loaded.assets)
    expect(
      Buffer.from(asset.bytes).equals(
        readFileSync(join(BUILT, "assets", name)),
      ),
      name,
    ).toBe(true);
});

it("refuses an asset that differs from the manifest, or is missing", () => {
  const flipped = copy();
  const bytes = readFileSync(join(flipped, "assets/app.css"));
  bytes[0] = (bytes[0] ?? 0) ^ 1; // the same size, another hash
  writeFileSync(join(flipped, "assets/app.css"), bytes);
  expect(loadBundle(flipped)).toBeNull();

  const cut = copy();
  const js = readFileSync(join(cut, "assets/app.js"));
  writeFileSync(join(cut, "assets/app.js"), js.subarray(0, js.length - 1));
  expect(loadBundle(cut)).toBeNull();

  const gone = copy();
  rmSync(join(gone, "assets/plex-mono-400.woff2"));
  expect(loadBundle(gone)).toBeNull();
});

// Lists the file at assets/<name> in the manifest with its true size and hash, writing it first
// as a copy of app.js unless it exists.
function listAsset(dir: string, name: string): void {
  const file = join(dir, "assets", name);
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    cpSync(join(dir, "assets/app.js"), file);
  }
  const bytes = readFileSync(file);
  const m = manifestOf(dir);
  m.assets[name] = {
    type: "text/plain; charset=utf-8",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  writeManifest(dir, m);
}

it("refuses an asset name that is not a plain file name, though its file matches", () => {
  const plain = copy();
  listAsset(plain, "copy.js");
  expect(loadBundle(plain)?.assets.has("copy.js")).toBe(true); // the listing alone is fine
  for (const name of ["../page.html", "sub/app.js", ".app.js", "-app.js"]) {
    const dir = copy();
    listAsset(dir, name);
    expect(loadBundle(dir), name).toBeNull();
  }
});

it("refuses a template without its two placeholders, once each and in order", () => {
  const page = read(BUILT, "page.html");
  for (const broken of [
    page.replace("{{TAIL}}", ""),
    page.replace("{{HEAD}}", ""),
    page.replace("{{HEAD}}", "{{HEAD}}{{HEAD}}"),
    page.replace("{{TAIL}}", "{{TAIL}}{{TAIL}}"),
    page
      .replace("{{HEAD}}", "{{X}}")
      .replace("{{TAIL}}", "{{HEAD}}")
      .replace("{{X}}", "{{TAIL}}"),
  ]) {
    const dir = copy();
    writeFileSync(join(dir, "page.html"), broken);
    expect(loadBundle(dir)).toBeNull();
  }
  const other = copy();
  writeManifest(other, { ...manifestOf(other), page: "index.html" });
  expect(loadBundle(other)).toBeNull();
});

it("finds no bundle where there is no manifest", () => {
  const dir = copy();
  renameSync(join(dir, "manifest.json"), join(dir, "manifest.old"));
  expect(loadBundle(dir)).toBeNull();
});

it("fills the placeholders with their text exactly as it is", () => {
  expect(fillPage("a{{HEAD}}b{{TAIL}}c", "$&$'$$", "$`$1")).toBe(
    "a$&$'$$b$`$1c",
  );
});
