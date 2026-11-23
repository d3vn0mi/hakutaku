// viewerStatic: the viewer's page and its assets, for a host that serves them under a base. The
// page names its base and its API address, and loads its styles and script from assets/; an
// asset is found by its exact name in the bundle's manifest, and no request path ever becomes a
// filesystem path.
import { echo, type ToolError, toolError } from "../tools/index.js";
import { fillPage, readBundle } from "./bundle-files.js";
import { SECURITY_HEADERS, VIEWER_CSP } from "./csp.js";
import type { ViewerResponse } from "./types.js";

// A base or an API address: an absolute path of plain segments that ends in "/". Nothing in it
// needs escaping inside an HTML attribute.
const BASE = /^\/([A-Za-z0-9._~-]+\/)*$/;
const ASSETS = "assets/";
// A script started as a worker runs under the policy of its own answer, never the page's. The
// highlighting worker fetches and imports nothing, so every asset carries a policy that allows
// nothing; a stylesheet, a font or the page's own script ignore it.
const ASSET_CSP = "default-src 'none'";

function checked(name: string, value: unknown): string {
  if (typeof value !== "string" || !BASE.test(value)) {
    throw new TypeError(
      `${name} must be an absolute path of letters, digits and . _ ~ - segments that ends in /`,
    );
  }
  return value;
}

// "" or "index.html": the page. "assets/<name>": the asset of that exact name. Anything else is
// 404. A base or apiBase outside the allowed form throws TypeError, before anything is read;
// apiBase defaults to the base's api/.
export function viewerStatic(
  path: string,
  opts: { base: string; apiBase?: string },
): ViewerResponse {
  const base = checked("base", opts.base);
  const apiBase = checked("apiBase", opts.apiBase ?? `${base}api/`);
  const isPage = path === "" || path === "index.html";
  if (!isPage && !path.startsWith(ASSETS)) return notFound(path);

  const bundle = readBundle();
  if (bundle === null) {
    return failure(500, toolError("internal", "viewer bundle missing"));
  }
  if (isPage) {
    const head = `<base href="${base}"><meta name="hakutaku-api" content="${apiBase}"><link rel="stylesheet" href="assets/app.css"><script defer src="assets/app.js"></script>`;
    return {
      status: 200,
      headers: {
        ...SECURITY_HEADERS,
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": VIEWER_CSP,
      },
      body: fillPage(bundle.page, head, ""),
    };
  }
  const asset = bundle.assets.get(path.slice(ASSETS.length));
  if (asset === undefined) return notFound(path);
  return {
    status: 200,
    headers: {
      ...SECURITY_HEADERS,
      "content-type": asset.type,
      "content-security-policy": ASSET_CSP,
    },
    body: asset.bytes,
  };
}

const notFound = (path: string): ViewerResponse =>
  failure(
    404,
    toolError("not_found", `no page or asset of the viewer at ${echo(path)}`),
  );

// Errors are written as the viewer's API writes them, with the security headers.
const failure = (status: number, error: ToolError): ViewerResponse => ({
  status,
  headers: {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
  },
  body: JSON.stringify({ error }, null, 2),
});
