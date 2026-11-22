// The page and its assets as viewerStatic serves them under a base: the page carries its base,
// its API address and the CSP and holds no inline code, assets are found only by their exact
// names in the bundle's manifest, and every answer carries the security headers.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { SECURITY_HEADERS, VIEWER_CSP } from "../../../src/viewer/csp.js";
import { viewerStatic } from "../../../src/viewer/static.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const page = (o: { base: string; apiBase?: string } = { base: "/" }) =>
  viewerStatic("", o);

afterEach(() => {
  vi.doUnmock("../../../src/viewer/bundle-files.js");
  vi.resetModules();
});

it("serves the page with its base, its API address and the CSP", () => {
  const r = page();
  expect([
    r.status,
    r.headers["content-type"],
    r.headers["content-security-policy"],
  ]).toEqual([200, "text/html; charset=utf-8", VIEWER_CSP]);
  expect(String(r.body)).toContain('<base href="/">');
  expect(String(r.body)).toContain(
    '<meta name="hakutaku-api" content="/api/">',
  );
  expect(
    String(
      viewerStatic("index.html", { base: "/repo/x/", apiBase: "/api/repo/x/" })
        .body,
    ),
  ).toContain('<meta name="hakutaku-api" content="/api/repo/x/">');
  // The API address defaults to the base's api/, and the page loads its own assets.
  const mounted = String(page({ base: "/repo/x/" }).body);
  expect(mounted).toContain('<base href="/repo/x/">');
  expect(mounted).toContain(
    '<meta name="hakutaku-api" content="/repo/x/api/">',
  );
  expect(mounted).toContain('<link rel="stylesheet" href="assets/app.css">');
  expect(mounted).toContain('<script defer src="assets/app.js"></script>');
  expect(mounted).not.toContain("{{");
  expect(String(viewerStatic("index.html", { base: "/" }).body)).toBe(
    String(page().body),
  );
});

it("puts no inline script, style block or style attribute in the page", () => {
  const body = String(page().body);
  expect(body).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  expect(body).not.toMatch(/<style|\sstyle=/);
});

it("serves assets only by their manifest names", () => {
  const js = viewerStatic("assets/app.js", { base: "/" });
  expect([js.status, js.headers["content-type"]]).toEqual([
    200,
    "text/javascript; charset=utf-8",
  ]);
  // An asset is the built file, byte for byte.
  expect(
    Buffer.from(js.body).equals(
      readFileSync(`${ROOT}dist/viewer/assets/app.js`),
    ),
  ).toBe(true);
  const font = viewerStatic("assets/plex-mono-400.woff2", { base: "/" });
  expect([font.status, font.headers["content-type"]]).toEqual([
    200,
    "font/woff2",
  ]);
  for (const p of [
    "assets/../package.json",
    "assets/",
    "assets/nope.js",
    "../dist/viewer/page.html",
    "page.html",
    "manifest.json",
    "favicon.ico",
    "assets/app.js/",
    "assets/APP.JS",
    "assets/%2e%2e/page.html",
    "assets/__proto__",
    "assets/constructor",
    "/assets/app.js",
    "/",
  ])
    expect(viewerStatic(p, { base: "/" }).status, p).toBe(404);
  const missing = viewerStatic("nope", { base: "/" });
  expect(missing.headers["content-type"]).toBe(
    "application/json; charset=utf-8",
  );
  expect(JSON.parse(String(missing.body)).error.code).toBe("not_found");
});

it("every response carries the security headers", () => {
  for (const r of [
    page(),
    viewerStatic("assets/app.css", { base: "/" }),
    viewerStatic("nope", { base: "/" }),
  ])
    for (const [k, v] of Object.entries(SECURITY_HEADERS))
      expect(r.headers[k]).toBe(v);
});

it("refuses a base or API address outside the allowed form", () => {
  for (const base of ["", "/x", "x/", "/a b/", "//evil.example/", '/a"/'])
    expect(() => viewerStatic("", { base })).toThrow(TypeError);
  expect(() => viewerStatic("", { base: "/", apiBase: "/api" })).toThrow(
    TypeError,
  );
  for (const apiBase of ["", "api/", "/a<b/", "//evil.example/api/"])
    expect(() => viewerStatic("assets/app.js", { base: "/", apiBase })).toThrow(
      TypeError,
    );
});

it("answers internal for the page and assets when the bundle is missing", async () => {
  vi.resetModules();
  vi.doMock("../../../src/viewer/bundle-files.js", () => ({
    readBundle: () => null,
  }));
  const { viewerStatic: bare } = await import("../../../src/viewer/static.js");
  for (const p of ["", "index.html", "assets/app.js"]) {
    const r = bare(p, { base: "/" });
    expect([r.status, JSON.parse(String(r.body))], p).toEqual([
      500,
      { error: { code: "internal", message: "viewer bundle missing" } },
    ]);
    for (const [k, v] of Object.entries(SECURITY_HEADERS))
      expect(r.headers[k]).toBe(v);
  }
  // Any other path is unknown with or without a bundle, and the base is checked first.
  expect(bare("nope", { base: "/" }).status).toBe(404);
  expect(() => bare("", { base: "x" })).toThrow(TypeError);
});
