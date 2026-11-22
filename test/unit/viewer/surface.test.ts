// What the library's "." gives of the viewer, and what the viewer modules it loads may import.
// Only the server, which opens a socket and may start a browser, and the static export may
// import node:http, node:https, node:net or node:child_process; the rest of src/viewer/, which a
// host loads to mount the viewer, opens no socket and starts no process.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, expectTypeOf, it } from "vitest";
import type { ViewerRequest, ViewerResponse } from "../../../src/index.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

it("the library exports the viewer API and its CSP", async () => {
  const lib = await import("../../../src/index.js");
  expect(typeof lib.viewerApi).toBe("function");
  expect(lib.VIEWER_CSP).toBe(
    "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  );
});

it("the library exports the viewer's request and response types", () => {
  // This compiles only while "." exports both types.
  expectTypeOf<[ViewerRequest, ViewerResponse]>().not.toBeNever();
});

it("the library's viewer modules open no socket and start no process", () => {
  const modules = readdirSync(join(ROOT, "src/viewer")).filter(
    (n) => n.endsWith(".ts") && !["server.ts", "export-page.ts"].includes(n),
  );
  expect(modules).toContain("api.ts"); // the scan reads real files
  for (const f of modules)
    expect(readFileSync(join(ROOT, "src/viewer", f), "utf8"), f).not.toMatch(
      /from\s+["'](node:(http|https|net|child_process)|\.\/server\.js|\.\/export-page\.js)["']/,
    );
});
